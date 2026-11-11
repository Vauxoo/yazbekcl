import logging
from urllib.parse import unquote

from werkzeug.exceptions import BadRequest, NotFound

from odoo import http
from odoo.http import request

from odoo.addons.payment_getnet_webcheckout_mxn import const


_logger = logging.getLogger(__name__)


class GetCheckoutController(http.Controller):
    """Receive the encrypted server-to-server notification configured in MIT."""

    _webhook_url = '/payment/getcheckout_mxn/webhook'
    _return_url = '/payment/getcheckout_mxn/return'

    @http.route(_webhook_url, type='http', auth='public', methods=['POST'], csrf=False, save_session=False)
    def getcheckout_webhook(self):
        encrypted_response = request.httprequest.form.get('strResponse')
        if not encrypted_response:
            json_data = request.get_json_data() or {}
            encrypted_response = json_data.get('strResponse')
        if not encrypted_response:
            raise BadRequest('Missing strResponse.')

        # Werkzeug decodes standard form data already. The replacement also handles '+' values
        # that may have been transformed into spaces by form-urlencoded decoding.
        encrypted_response = unquote(encrypted_response).replace(' ', '+')
        providers = request.env['payment.provider'].sudo().search([
            ('code', '=', const.PROVIDER_CODE), ('state', '!=', 'disabled'),
        ])
        for provider in providers:
            try:
                payment_data = provider._getcheckout_decrypt_payload(encrypted_response)
            except Exception:  # Different companies can use different AES keys.
                continue
            reference = payment_data.get('reference')
            if not reference:
                continue
            tx_sudo = request.env['payment.transaction'].sudo().search([
                ('provider_code', '=', const.PROVIDER_CODE), ('provider_id', '=', provider.id),
                ('reference', '=', reference),
            ], limit=1)
            if tx_sudo:
                tx_sudo._process(const.PROVIDER_CODE, payment_data)
                tx_sudo._getcheckout_mxn_post_process_done_transaction()
                return request.make_response('')

        _logger.warning('Rejected Get Checkout notification: no matching provider or transaction.')
        raise NotFound()

    @http.route(
        _return_url, type='http', auth='public', methods=['GET', 'POST'],
        csrf=False, website=True, sitemap=False,
    )
    def getcheckout_return(self, **kwargs):
        """Return the cardholder to the standard eCommerce confirmation page.

        MIT must configure this optional redirect URL. The server-to-server
        webhook remains the authoritative source for the payment result.
        """
        return request.redirect('/shop/confirmation')
