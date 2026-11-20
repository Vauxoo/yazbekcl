"""Consulta por lotes para la matriz Yazbek en Odoo 19 Enterprise.

Se calculan precios mediante el mismo método que usa el eCommerce
(`_get_additionnal_combination_info`), incluido el stock de website_sale_stock.
No se selecciona ni persiste una tarifa alternativa en la sesión web.
"""

import logging
import math

from odoo import fields
from odoo.fields import Domain
from odoo.http import Controller, request, route
from odoo.exceptions import AccessError, ValidationError

_logger = logging.getLogger(__name__)

MAX_VARIANTS = 25
MAX_PRICELISTS = 2


class YazbekVariantMatrixBatch(Controller):

    @route(
        '/yazbek/matrix/variants/batch',
        type='jsonrpc', auth='public', methods=['POST'],
        website=True, readonly=True,
    )
    def get_variants_batch(self, product_template_id=None, items=None,
                           pricelist_ids=None, reference_quantities=None, **kwargs):
        """Recibe hasta 25 variantes y 1-2 tarifas; responde solo datos de venta.

        No acepta lista de precios arbitraria: debe estar disponible en el
        website actual o ser la lista efectiva del visitante.
        """
        try:
            template_id = int(product_template_id or 0)
            if template_id <= 0:
                raise ValueError()
            if not isinstance(items, list) or not (1 <= len(items) <= MAX_VARIANTS):
                raise ValueError()
            if not isinstance(pricelist_ids, list) or not (1 <= len(pricelist_ids) <= MAX_PRICELISTS):
                raise ValueError()
            list_ids = [int(value) for value in pricelist_ids]
            if len(set(list_ids)) != len(list_ids) or any(value <= 0 for value in list_ids):
                raise ValueError()
            # Cantidades usadas SOLO para los precios «Desde» de la tarjeta.
            # La cuadrícula y los cambios por cantidad utilizan precios específicos.
            if reference_quantities is None:
                reference_quantities = {}
            if not isinstance(reference_quantities, dict):
                raise ValueError()
            if set(reference_quantities) - {str(pid) for pid in list_ids}:
                raise ValueError()
            ref_qty_by_pl = {}
            for pid in list_ids:
                ref_qty = float(reference_quantities.get(str(pid), 1))
                if not math.isfinite(ref_qty) or not (1 <= ref_qty <= 1000):
                    raise ValueError()
                ref_qty_by_pl[pid] = ref_qty
            # Solicitudes iniciales: quantity=1 por defecto.
            # En una edición de cantidad: se consulta solo esa variante con
            # la cantidad indicada y una tarifa explícita, sin tocar sesión.
            product_ids = []
            item_qty = {}
            for row in items:
                if not isinstance(row, dict):
                    raise ValueError()
                pid = int(row['product_id'])
                qty = float(row.get('quantity', 1.0))
                if pid <= 0 or pid in item_qty or not math.isfinite(qty) or not 1 <= qty <= 1000:
                    raise ValueError()
                product_ids.append(pid)
                item_qty[pid] = qty
        except (ValueError, TypeError, KeyError):
            return {'error': 'invalid_request'}

        website = request.website
        # No exponer productos de otros sitios/empresas, ni no publicados.
        domain = Domain.AND([
            website.sale_product_domain(),
            [('id', '=', template_id)],
        ])
        template = request.env['product.template'].sudo().with_company(
            website.company_id
        ).search(domain, limit=1)
        if not template:
            return {'error': 'not_available'}

        # El usuario únicamente puede pedir tarifas ofrecidas por este sitio.
        # request.pricelist incluye la tarifa actual (también tarifa de cliente).
        original_pricelist = request.pricelist
        valid_price_ids = set(website.get_pricelist_available(show_visible=True).ids)
        valid_price_ids.add(original_pricelist.id)
        # Tarifas vinculadas al sitio, aunque se oculten del selector público:
        # se necesitan en la tarjeta Menudeo/Mayoreo de la matriz.
        site_price_ids = set(website.sudo().pricelist_ids.filtered(
            lambda p: p.website_id == website and p.active
        ).ids)
        valid_price_ids.update(site_price_ids)

        if not set(list_ids).issubset(valid_price_ids):
            return {'error': 'invalid_pricelist'}
        pricelists = request.env['product.pricelist'].sudo().with_company(
            website.company_id
        ).browse(list_ids).exists()
        if len(pricelists) != len(list_ids) or any(
            (not p.active) or (p.company_id and p.company_id != website.company_id)
            or (p.website_id and p.website_id != website)
            for p in pricelists
        ):
            return {'error': 'invalid_pricelist'}

        products = request.env['product.product'].sudo().with_company(
            website.company_id
        ).search([
            ('id', 'in', product_ids),
            ('product_tmpl_id', '=', template.id),
            ('active', '=', True),
            ('sale_ok', '=', True),
            ('company_id', 'in', [False, website.company_id.id]),
        ])
        product_by_id = {p.id: p for p in products}

        # website_sale_stock activa estas claves en su controlador base.
        request.update_context(website_sale_stock_get_quantity=True)
        template = template.with_context(request.env.context)
        web_ctx = website.with_context(request.env.context)
        now = fields.Date.context_today(template)

        response = {'prices': {str(pl_id): {} for pl_id in list_ids}}
        try:
            for pricelist in pricelists:
                # Cambio exclusivamente local al request HTTP. Nunca se mutan
                # ni la sesión ni el carrito del visitante.
                request.pricelist = pricelist
                output = response['prices'][str(pricelist.id)]
                for product_id in product_ids:
                    product = product_by_id.get(product_id)
                    if not product:
                        output[str(product_id)] = {
                            'referencePrice': 0, 'price': 0, 'freeQty': 0, 'cartQty': 0,
                            'showAvailability': False,
                            'allowOutOfStock': False, 'isStorable': True,
                        }
                        continue
                    try:
                        # Equivale a la porción de precio y stock de
                        # template._get_combination_info() de Odoo 19,
                        # sin recrear variantes, imágenes, etiquetas, etc.
                        combination = product.product_template_attribute_value_ids
                        price_ctx = product._get_product_price_context(combination)
                        priced_product = product.with_context(**price_ctx)
                        result = template._get_additionnal_combination_info(
                            product_or_template=priced_product,
                            quantity=item_qty[product_id],
                            uom=product.uom_id,
                            date=now,
                            website=web_ctx,
                        )
                        ref_qty = ref_qty_by_pl[pricelist.id]
                        if ref_qty == item_qty[product_id]:
                            reference_price = float(result.get('price') or 0)
                        else:
                            # Precio de referencia para 12 piezas en Mayoreo:
                            # mismo método de Odoo 19, impuestos y posición fiscal.
                            reference_result = template._get_additionnal_combination_info(
                                product_or_template=priced_product,
                                quantity=ref_qty,
                                uom=product.uom_id,
                                date=now,
                                website=web_ctx,
                            )
                            reference_price = float(reference_result.get('price') or 0)
                        output[str(product_id)] = {
                            'referencePrice': reference_price,
                            'price': float(result.get('price') or 0),
                            'freeQty': float(result.get('free_qty') or 0),
                            'cartQty': float(result.get('cart_qty') or 0),
                            'showAvailability': bool(result.get('show_availability')),
                            'allowOutOfStock': bool(result.get('allow_out_of_stock_order')),
                            'isStorable': bool(result.get('is_storable')),
                        }
                    except (AccessError, ValidationError):
                        _logger.exception('Yazbek matrix: no se pudo calcular %s', product_id)
                        # No inventar precio en caso de error.
                        output[str(product_id)] = {
                            'referencePrice': 0, 'price': 0, 'freeQty': 0, 'cartQty': 0,
                            'showAvailability': False,
                            'allowOutOfStock': False, 'isStorable': True,
                        }
        finally:
            request.pricelist = original_pricelist
        return response
