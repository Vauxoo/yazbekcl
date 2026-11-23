"""Tarifa uniforme del carrito web de Yazbek (Odoo 19).

Odoo 19 llama _verify_cart_after_update al terminar de agregar productos
(incluso linked/combo) y al modificar o quitar una línea en /shop/cart/update.
Esto evita depender de automatizaciones de Studio que no detectan unlink.
"""

import logging

from odoo import models
from odoo.http import request
from odoo.addons.website_sale.models.website import (
    PRICELIST_SESSION_CACHE_KEY,
    PRICELIST_SELECTED_SESSION_CACHE_KEY,
)

_logger = logging.getLogger(__name__)


class SaleOrder(models.Model):
    _inherit = "sale.order"

    def _yazbek_sync_cart_pricelist(self):
        self.ensure_one()
        website = self.website_id
        if not website or self.state not in ("draft", "sent"):
            return
        # Aplicable a cualquier pais. Cada sitio utiliza sus propias tarifas
        # Menudeo/Mayoreo, si existen y corresponden a su empresa.
        # Mantener exactamente la tarifa especial de clientes Yazbek.
        special_names = {"descuento 14%", "descuento 14% (clp)"}
        current_name = (self.pricelist_id.name or "").strip().lower()
        partner_price = self.partner_id.property_product_pricelist
        partner_name = (partner_price.name or "").strip().lower()
        if current_name in special_names or partner_name in special_names:
            return

        total_units = 0.0
        for line in self.order_line:
            if line.display_type or not line.product_id or line.is_delivery:
                continue
            if line.product_uom_qty <= 0:
                continue
            if line.product_uom_id and line.product_id.uom_id:
                total_units += line.product_uom_id._compute_quantity(
                    line.product_uom_qty, line.product_id.uom_id,
                )
            else:
                total_units += line.product_uom_qty

        target_name = "Mayoreo" if total_units >= 12 else "Menudeo"
        available = website.sudo().get_pricelist_available(show_visible=True)
        # También contemplar listas del sitio no visibles en el selector.
        available |= website.sudo().pricelist_ids
        target_list = available.filtered(lambda p:
            p.name == target_name
            and p.active
            and (not p.company_id or p.company_id == self.company_id)
            and (not p.website_id or p.website_id == website)
        )[:1]
        if not target_list:
            _logger.warning(
                "Yazbek matriz: falta tarifa %s para website %s y compañía %s",
                target_name, website.id, self.company_id.id,
            )
            return

        # No recalcular todas las líneas si la tarifa permanece igual.
        if self.pricelist_id != target_list:
            self.pricelist_id = target_list
            self._recompute_prices()

        # Sin HTTP 301/303: misma tarifa para página, carrito y próxima petición.
        # Sin fijar selecciones promocionales de otros sitios/empresas.
        if request and request.website and request.website.id == website.id:
            request.session[PRICELIST_SESSION_CACHE_KEY] = target_list.id
            request.session[PRICELIST_SELECTED_SESSION_CACHE_KEY] = target_list.id
            request.pricelist = target_list.sudo()

    def _verify_cart_after_update(self):
        # Super verificará el envío después de aplicar la tarifa final.
        for order in self:
            if not order.env.context.get("yazbek_skip_pricelist_sync"):
                order.with_context(yazbek_skip_pricelist_sync=True)._yazbek_sync_cart_pricelist()
        return super()._verify_cart_after_update()
