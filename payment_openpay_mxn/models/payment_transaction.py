from odoo import _, fields, models
from odoo.exceptions import ValidationError


class PaymentTransaction(models.Model):
    _inherit = 'payment.transaction'

    openpay_mxn_agreement = fields.Char(string='Convenio CIE', readonly=True, copy=False)
    openpay_mxn_clabe = fields.Char(string='CLABE Openpay', readonly=True, copy=False)
    openpay_mxn_reference = fields.Char(string='Referencia bancaria', readonly=True, copy=False)
    openpay_mxn_bank = fields.Char(string='Banco destino', readonly=True, copy=False)
    openpay_mxn_due_date = fields.Datetime(string='Fecha límite Openpay', readonly=True, copy=False)
    openpay_mxn_receipt_url = fields.Char(string='Recibo Openpay', readonly=True, copy=False)

    def _get_specific_processing_values(self, processing_values):
        if self.provider_code != 'openpay_mxn':
            return super()._get_specific_processing_values(processing_values)
        self.ensure_one()
        if self.currency_id.name != 'MXN':
            raise ValidationError(_('Openpay SPEI/CIE solo admite pagos en MXN.'))
        try:
            charge_data = self._send_api_request(
                'POST', 'charges', json={
                    'method': 'bank_account',
                    'amount': self.amount,
                    'currency': 'MXN',
                    'description': self.reference[:250],
                    'order_id': self.reference[:100],
                }
            )
        except ValidationError as error:
            self._set_error(str(error))
            return {}
        charge_data['reference'] = self.reference
        self._process('openpay_mxn', charge_data)
        return {
            'openpay_mxn_reference': self.openpay_mxn_reference,
            'openpay_mxn_receipt_url': self.openpay_mxn_receipt_url,
        }

    def _openpay_mxn_refresh_status(self):
        self.ensure_one()
        if self.provider_code != 'openpay_mxn' or not self.provider_reference:
            return
        try:
            charge_data = self._send_api_request('GET', f'charges/{self.provider_reference}')
        except ValidationError:
            return
        charge_data['reference'] = self.reference
        self._process('openpay_mxn', charge_data)

    def _apply_updates(self, payment_data):
        if self.provider_code != 'openpay_mxn':
            return super()._apply_updates(payment_data)
        self.ensure_one()
        payment_method = payment_data.get('payment_method') or {}
        provider_reference = payment_data.get('id') or self.provider_reference
        values = {
            'provider_reference': provider_reference,
            'openpay_mxn_agreement': payment_method.get('agreement') or self.openpay_mxn_agreement,
            'openpay_mxn_clabe': payment_method.get('clabe') or self.openpay_mxn_clabe,
            'openpay_mxn_reference': payment_method.get('name') or self.openpay_mxn_reference,
            'openpay_mxn_bank': payment_method.get('bank') or self.openpay_mxn_bank,
            'openpay_mxn_due_date': payment_data.get('due_date') or self.openpay_mxn_due_date,
        }
        if provider_reference:
            dashboard = (
                'https://sandbox-dashboard.openpay.mx'
                if self.provider_id.state == 'test' else 'https://dashboard.openpay.mx'
            )
            values['openpay_mxn_receipt_url'] = (
                f'{dashboard}/spei-pdf/{self.provider_id.openpay_mxn_merchant_id}/{provider_reference}'
            )
        self.write(values)

        status = payment_data.get('status')
        if status in ('in_progress', 'charge_pending'):
            self._set_pending()
        elif status == 'completed':
            self._set_done()
        elif status == 'cancelled':
            self._set_canceled()
        else:
            self._set_error(payment_data.get('error_message') or _('Openpay rechazó o no reconoció el cargo.'))

    def _cron_openpay_mxn_refresh_pending(self):
        pending_transactions = self.search([
            ('provider_code', '=', 'openpay_mxn'), ('state', '=', 'pending'),
        ])
        for transaction in pending_transactions:
            transaction._openpay_mxn_refresh_status()
