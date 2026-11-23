"""Permitir cambiar las opciones por website desde Ajustes > Sitio web."""

from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    yazbek_price_decimals = fields.Boolean(
        related="website_id.yazbek_price_decimals", readonly=False,
    )
    yazbek_show_availability = fields.Boolean(
        related="website_id.yazbek_show_availability", readonly=False,
    )

    yazbek_matrix_sale_mode = fields.Selection(
        related="website_id.yazbek_matrix_sale_mode", readonly=False,
    )
