import hmac
from werkzeug.exceptions import Forbidden, NotFound

from odoo import http
from odoo.http import request


class OpenpayMXNController(http.Controller):
    """Endpoints intentionally limited to Openpay bank-transfer notifications."""

    _webhook_url = '/payment/openpay_mxn/webhook'

    @http.route(_webhook_url, type='http', auth='public', methods=['POST'], csrf=False)
    def openpay_mxn_webhook(self, **kwargs):
        """Authenticate an Openpay webhook and query the authoritative charge status.

        The notification only identifies the Odoo transaction; amounts, currency, and state are
        always re-read from Openpay before changing it. Openpay's verification event is retained
        per provider, so an administrator can complete the dashboard verification workflow.
        """
        payload = request.httprequest.get_json(silent=True)
        if not isinstance(payload, dict):
            return request.make_json_response({'error': 'invalid_json'}, status=400)

        provider = self._get_authenticated_provider()
        event_type = payload.get('type')

        if event_type == 'verification':
            verification_code = payload.get('verification_code')
            if (
                not isinstance(verification_code, str)
                or not verification_code
                or len(verification_code) > 128
            ):
                return request.make_json_response({'error': 'invalid_verification_code'}, status=400)
            request.env['ir.config_parameter'].sudo().set_param(
                f'payment_openpay_mxn.verification_code.{provider.id}', verification_code
            )
            provider.sudo().write({'openpay_mxn_verification_code': verification_code})
            return request.make_json_response({'status': 'ok'}, status=200)

        if event_type not in {
            'charge.created', 'charge.succeeded', 'charge.failed', 'charge.cancelled',
            'transaction.expired', 'spei.received',
        }:
            return request.make_json_response({'status': 'ignored'}, status=200)

        transaction = payload.get('transaction')
        transaction_id = transaction.get('id') if isinstance(transaction, dict) else None
        if not transaction_id:
            return request.make_json_response({'error': 'missing_transaction_id'}, status=400)

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
