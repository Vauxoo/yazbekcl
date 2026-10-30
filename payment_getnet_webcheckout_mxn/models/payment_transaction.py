from decimal import Decimal, ROUND_HALF_UP

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from odoo.addons.payment.logging import get_payment_logger
from odoo.addons.payment_getnet_webcheckout_mxn import const


_logger = get_payment_logger(__name__, const.SENSITIVE_KEYS)


class PaymentTransaction(models.Model):
    _inherit = 'payment.transaction'

    getcheckout_id_url = fields.Char(string='Get Checkout ID de liga', copy=False, readonly=True, index=True)
    getcheckout_folio = fields.Char(string='Get Checkout folio', copy=False, readonly=True)
    getcheckout_authorization = fields.Char(string='Get Checkout autorización', copy=False, readonly=True)
    getcheckout_card_mask = fields.Char(string='Get Checkout tarjeta enmascarada', copy=False, readonly=True)
    getcheckout_response_code = fields.Char(string='Get Checkout código de respuesta', copy=False, readonly=True)

    def _get_specific_rendering_values(self, processing_values):
        if self.provider_code != const.PROVIDER_CODE:
            return super()._get_specific_rendering_values(processing_values)
        payload = self._getcheckout_prepare_request_payload()
        try:
            response = self._send_api_request('POST', '', json={
                'data0': self.provider_id.getcheckout_data0,
                'data': self.provider_id._getcheckout_encrypt_payload(payload),
            })
        except ValidationError as error:
            self._set_error(str(error))
            return {}

        response_data = response.get('P_RESPONSE') or {}
        checkout_url = response_data.get('nb_url')
        if response_data.get('cd_response') != 'success' or not checkout_url:
            self._set_error(response_data.get('nb_response') or _('Get Checkout no generó una liga de pago.'))
            return {}
        self.write({
            'getcheckout_id_url': response_data.get('id_url') or '',
            'provider_reference': response_data.get('id_url') or self.provider_reference,
        })
        self._set_pending()
        return {'checkout_url': checkout_url}

    def _getcheckout_prepare_request_payload(self):
        self.ensure_one()
        provider = self.provider_id
        amount = Decimal(str(self.amount)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        return {
            'P': {
                'business': {
                    'id_company': provider.getcheckout_company_id,
                    'id_branch': provider.getcheckout_branch_id,
                    'user': provider.getcheckout_user,
                    'pwd': provider.getcheckout_password,
                },
                'url': {
                    'reference': self.reference[:50],
                    'amount': format(amount, '.2f'),
                    'currency': self.currency_id.name,
                    'channel': 'W',
                    'version': 'IntegraWPP',
                    'suppress_email_notification': '1' if provider.getcheckout_suppress_email_notification else '0',
                },
            },
        }

    @api.model
    def _extract_reference(self, provider_code, payment_data):
        if provider_code != const.PROVIDER_CODE:
            return super()._extract_reference(provider_code, payment_data)
        return payment_data.get('reference')

    def _extract_amount_data(self, payment_data):
        if self.provider_code != const.PROVIDER_CODE:
            return super()._extract_amount_data(payment_data)
        amount = payment_data.get('amount')
        if amount in (None, ''):
            return None
        try:
            return {'amount': float(amount), 'currency_code': self.currency_id.name}
        except (TypeError, ValueError):
            return None

    def _apply_updates(self, payment_data):
        if self.provider_code != const.PROVIDER_CODE:
            return super()._apply_updates(payment_data)
        response = (payment_data.get('response') or '').lower()
        values = {
            'getcheckout_id_url': payment_data.get('id_url') or self.getcheckout_id_url,
            'getcheckout_folio': str(payment_data.get('foliocpagos') or ''),
            'getcheckout_authorization': str(payment_data.get('auth') or ''),
            'getcheckout_card_mask': payment_data.get('cc_mask') or '',
            'getcheckout_response_code': str(payment_data.get('cd_response') or ''),
        }
        if payment_data.get('foliocpagos'):
            values['provider_reference'] = str(payment_data['foliocpagos'])
        self.write(values)
        if response == 'approved':
            self._set_done(state_message=_('Pago aprobado por Get Checkout.'))
        elif response == 'denied':
            self._set_canceled(state_message=payment_data.get('nb_error') or _('Pago rechazado por Get Checkout.'))
        else:
            self._set_error(payment_data.get('nb_error') or _('Respuesta no reconocida de Get Checkout.'))
