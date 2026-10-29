from werkzeug.exceptions import Forbidden

from odoo import _
from odoo.exceptions import UserError, ValidationError
from odoo.http import request, route

from odoo.addons.website_sale.controllers.main import WebsiteSale


class YazbekB2BCreditWebsiteSale(WebsiteSale):
    """Add a direct, server-validated B2B credit option to the checkout."""

    def _get_shop_payment_values(self, order, **kwargs):
        values = super()._get_shop_payment_values(order, **kwargs)
        values['b2b_credit'] = False
        values['b2b_credit_error'] = request.session.pop('b2b_credit_error', False)

        # Never expose a company's credit information to the public user.
        if request.env.user._is_public() or not order:
            return values
        if order.partner_id.commercial_partner_id != request.env.user.partner_id.commercial_partner_id:
            return values

        snapshot = order.sudo()._b2b_credit_snapshot()
        if snapshot['authorized']:
            values['b2b_credit'] = snapshot
        return values

    @route(
        '/shop/credit/confirm', type='http', auth='user', methods=['POST'], website=True,
        sitemap=False,
    )
    def shop_credit_confirm(self, **post):
        """Confirm the current cart without creating a payment transaction.

        The eligibility and amount are recalculated on the server after taking the
        commercial-partner transaction lock.  Values posted by the browser are
        deliberately ignored.
        """
        order = request.cart
        if not order or order.state != 'draft':
            return request.redirect('/shop')
        if order.partner_id.commercial_partner_id != request.env.user.partner_id.commercial_partner_id:
            raise Forbidden()

        if redirection := self._check_cart_and_addresses(order):
            return redirection

        try:
            # `_b2b_confirm_with_credit` refreshes price, IVA and the selected
            # Shipit/delivery rate after acquiring the customer transaction lock.
            order._b2b_confirm_with_credit()
        except (UserError, ValidationError) as error:
            request.session['b2b_credit_error'] = error.args[0] if error.args else _(
                'The order could not be confirmed with commercial credit.'
            )
            return request.redirect('/shop/payment')

        # Same session lifecycle used by Odoo's payment validation controller.
        request.session['sale_last_order_id'] = order.id
        request.website.sale_reset()
        return request.redirect('/shop/confirmation')
