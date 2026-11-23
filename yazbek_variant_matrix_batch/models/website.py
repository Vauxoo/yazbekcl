"""Opciones visuales independientes para cada sitio web Yazbek."""

from odoo import fields, models


class Website(models.Model):
    _inherit = "website"

    yazbek_price_decimals = fields.Boolean(
        string="Precio con decimales",
        default=True,
        help="Mostrar dos decimales en los precios de la tienda. "
             "Solo afecta la presentación; no redondea pedidos, impuestos o cobros.",
    )
    yazbek_show_availability = fields.Boolean(
        string="Mostrar disponibilidad de producto",
        default=True,
        help="Mostrar cantidades disponibles en la tienda. "
             "No desactiva restricciones de existencia ni validaciones de venta.",
    )

    yazbek_matrix_sale_mode = fields.Selection(
        selection=[
            ("units", "Solo unidades"),
            ("boxes", "Solo cajas"),
            ("both", "Unidades y cajas"),
        ],
        string="Venta en la matriz por",
        default="units",
        required=True,
        help="Elige los formatos de compra disponibles en la matriz de variantes de este sitio.",
    )
