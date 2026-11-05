import hmac
import json

from werkzeug.exceptions import Forbidden, NotFound

from odoo import http
from odoo.http import request


class OpenpayMXNController(http.Controller):
    """Endpoints intentionally limited to Openpay bank-transfer notifications."""

    _webhook_url = '/payment/openpay_mxn/webhook'

    @http.route(_webhook_url, type='http', auth='public', methods=['POST'], csrf=False)
    def openpay_mxn_webhook(self, **kwargs):
        """Authenticate a notification then retrieve the charge server-to-server.

        The payload is used only to locate the local transaction. Its status, amount, and
        currency are not trusted: the transaction asks Openpay for the authoritative charge.
        """
        payload = request.httprequest.get_json(silent=True)
        if not isinstance(payload, dict):
            return request.make_json_response({'error': 'invalid_json'}, status=400)

        provider = self._get_authenticated_provider()
        transaction_id = payload.get('id')
        if not transaction_id:
            # Openpay sends a verification request when a webhook is registered.
            return request.make_json_response({'verification_code': payload.get('verification_code')})

        tx = request.env['payment.transaction'].sudo().search([
            ('provider_code', '=', 'openpay_mxn'),
            ('provider_reference', '=', transaction_id),
            ('provider_id', '=', provider.id),
        ], limit=1)
        if not tx:
            raise NotFound()
        tx._openpay_mxn_refresh_status()
        return request.make_json_response({'status': 'ok'})

    @staticmethod
    def _get_authenticated_provider():
        authorization = request.httprequest.authorization
        if not authorization or authorization.type.lower() != 'basic':
            raise Forbidden()
        providers = request.env['payment.provider'].sudo().search([
            ('code', '=', 'openpay_mxn'), ('state', '!=', 'disabled'),
        ])
        for provider in providers:
            if (
                hmac.compare_digest(authorization.username or '', provider.openpay_mxn_webhook_user or '')
                and hmac.compare_digest(authorization.password or '', provider.openpay_mxn_webhook_password or '')
            ):
                return provider
        raise Forbidden()
