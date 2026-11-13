import json
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
    getcheckout_card_type = fields.Char(string='Get Checkout tipo de tarjeta', copy=False, readonly=True)
    getcheckout_response_code = fields.Char(string='Get Checkout código de respuesta', copy=False, readonly=True)
    getcheckout_customer_message = fields.Char(
        string='Get Checkout mensaje para cliente', copy=False, readonly=True,
        help='Mensaje seguro para mostrar en eCommerce cuando MIT rechaza o no puede procesar el pago.',
    )
    getcheckout_response_json = fields.Text(
        string='Get Checkout respuesta JSON', copy=False, readonly=True, groups='base.group_system',
        help='Respuesta descifrada recibida de MIT. Las claves sensibles se ocultan antes de guardarse.',
    )

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

    def _getcheckout_mxn_post_process_done_transaction(self):
        """Finalize one approved transaction using Odoo's standard business flow.

        MIT's server-to-server notification does not run the buyer browser's
        normal payment-status polling. This method makes the webhook complete
        the same idempotent Sales and Accounting post-processing: confirming
        the linked quotation and creating the customer payment when Accounting
        is installed.
        """
        self.ensure_one()
        if (
            self.provider_code == const.PROVIDER_CODE
            and self.state == 'done'
        ):
            if not self.is_post_processed:
                self.provider_id._getcheckout_mxn_ensure_accounting_payment_method()
                self.with_company(self.company_id)._post_process()
            # Keep the Mexican CFDI payment form synchronized even when a
            # confirmed webhook is replayed after an upgrade.
            self._getcheckout_mxn_apply_cfdi_payment_form()

    def _getcheckout_mxn_apply_cfdi_payment_form(self):
        """Set CFDI form 04/28 from MIT's approved-card classification.

        MIT provides ``cc_type`` only after an approved charge.  The value is
        authoritative for whether the customer used credit or debit, whereas
        the checkout form itself cannot know that beforehand.  The Mexican
        localization is optional, so all access is guarded for installations
        that do not use its models or fields.
        """
        self.ensure_one()
        card_type = (self.getcheckout_card_type or '').upper().replace('É', 'E')
        if 'CREDITO' in card_type:
            cfdi_code = '04'  # Tarjeta de crédito.
        elif 'DEBITO' in card_type:
            cfdi_code = '28'  # Tarjeta de débito.
        else:
            return

        if 'l10n_mx_edi.payment.method' not in self.env:
            return
        cfdi_payment_form = self.env['l10n_mx_edi.payment.method'].sudo().search(
            [('code', '=', cfdi_code)], limit=1,
        )
        if not cfdi_payment_form:
            return

        payment_form_field = 'l10n_mx_edi_payment_method_id'
        values = {payment_form_field: cfdi_payment_form.id}
        sale_orders = self.sale_order_ids
        if sale_orders and payment_form_field in sale_orders._fields:
            sale_orders.write(values)

        if 'account.payment' not in self.env:
            return
        payment_model = self.env['account.payment'].sudo()
        transaction_field_names = [
            name for name, field in payment_model._fields.items()
            if getattr(field, 'comodel_name', None) == 'payment.transaction'
        ]
        for transaction_field_name in transaction_field_names:
            payments = payment_model.search([(transaction_field_name, '=', self.id)])
            if payments and payment_form_field in payments._fields:
                payments.write(values)

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
            'getcheckout_card_type': payment_data.get('cc_type') or '',
            'getcheckout_response_code': str(payment_data.get('cd_response') or ''),
            'getcheckout_customer_message': self._getcheckout_customer_payment_message(payment_data),
            'getcheckout_response_json': self._getcheckout_format_response_for_audit(payment_data),
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

    def _getcheckout_customer_payment_message(self, payment_data):
        """Return a customer-safe explanation without exposing MIT internals."""
        response = (payment_data.get('response') or '').lower()
        if response == 'approved':
            return False

        response_code = str(payment_data.get('cd_response') or '')
        provider_error = str(payment_data.get('nb_error') or '').strip()
        if response_code == '11' or 'afiliacion' in provider_error.lower():
            return _(
                'El importe de esta compra excede el límite permitido para esta transacción. '
                'Intenta con un monto menor o comunícate con nosotros.'
            )
        if provider_error:
            # MIT is authoritative for a rejection reason. QWeb escapes this text
            # before rendering it in the storefront.
            return provider_error
        if response == 'denied':
            return _(
                'El banco no autorizó el pago. La causa puede variar según la tarjeta o el banco. '
                'Intenta con otra tarjeta o consulta a tu banco.'
            )
        return _(
            'No pudimos confirmar tu pago. No realices otro intento hasta confirmar el estado '
            'con nuestro equipo.'
        )

    def _getcheckout_format_response_for_audit(self, payment_data):
        """Keep a readable, admin-only copy of MIT's decoded notification.

        The encrypted ``strResponse`` is intentionally not persisted.  Although MIT's
        response normally contains masked card information only, remove credentials
        defensively in case its response schema changes.
        """
        sensitive_keys = {'pwd', 'password', 'aes_key', 'key', 'secret', 'token'}

        def _redact(value):
            if isinstance(value, dict):
                return {
                    key: '[oculto]' if key.lower() in sensitive_keys else _redact(item)
                    for key, item in value.items()
                }
            if isinstance(value, list):
                return [_redact(item) for item in value]
            return value

        return json.dumps(_redact(payment_data), ensure_ascii=False, indent=2, sort_keys=True, default=str)
