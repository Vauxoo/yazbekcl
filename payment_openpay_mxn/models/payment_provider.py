from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class PaymentProvider(models.Model):
    _inherit = 'payment.provider'

    code = fields.Selection(
        selection_add=[('openpay_mxn', 'Openpay México - SPEI/CIE')],
        ondelete={'openpay_mxn': 'set default'},
    )
    openpay_mxn_merchant_id = fields.Char(string='Openpay Merchant ID', copy=False, groups='base.group_system')
    openpay_mxn_private_key = fields.Char(
        string='Openpay Private Key', copy=False, groups='base.group_system'
    )
    openpay_mxn_webhook_user = fields.Char(
        string='Openpay Webhook User', copy=False, groups='base.group_system'
    )
    openpay_mxn_webhook_password = fields.Char(
        string='Openpay Webhook Password', copy=False, groups='base.group_system'
    )
    openpay_mxn_verification_code = fields.Char(
        string='Openpay Webhook Verification Code', readonly=True, copy=False,
        groups='base.group_system',
        help='Último código recibido durante la verificación del webhook en Openpay.',
    )
    openpay_mxn_expiration_days = fields.Integer(
        string='Días de vigencia de la referencia', default=7, required=True,
        groups='base.group_system',
        help='Días naturales antes del vencimiento de la referencia SPEI/CIE (de 1 a 30).',
    )

    def _get_supported_currencies(self):
        currencies = super()._get_supported_currencies()
        if self.code == 'openpay_mxn':
            currencies = currencies.filtered(lambda currency: currency.name == 'MXN')
        return currencies

    @api.constrains('state', 'openpay_mxn_merchant_id', 'openpay_mxn_private_key')
    def _check_openpay_mxn_credentials(self):
        for provider in self.filtered(lambda p: p.code == 'openpay_mxn' and p.state != 'disabled'):
            if not provider.openpay_mxn_merchant_id or not provider.openpay_mxn_private_key:
                raise ValidationError(_(
                    'Configure el Merchant ID y la llave privada de Openpay antes de activar el proveedor.'
                ))
            if not provider.openpay_mxn_webhook_user or not provider.openpay_mxn_webhook_password:
                raise ValidationError(_(
                    'Configure el usuario y contraseña HTTP Basic del webhook antes de activar el proveedor.'
                ))

    @api.constrains('openpay_mxn_expiration_days')
    def _check_openpay_mxn_expiration_days(self):
        for provider in self.filtered(lambda p: p.code == 'openpay_mxn'):
            if not 1 <= provider.openpay_mxn_expiration_days <= 30:
                raise ValidationError(_(
                    'Los días de vigencia de una referencia Openpay deben estar entre 1 y 30.'
                ))

    def _get_default_payment_method_codes(self):
        self.ensure_one()
        if self.code == 'openpay_mxn':
            return ['bank_transfer']
        return super()._get_default_payment_method_codes()

    def _get_redirect_form_view(self, is_validation=False):
        """Always provide Openpay's transition form, including for providers created by old data."""
        self.ensure_one()
        if self.code != 'openpay_mxn':
            return super()._get_redirect_form_view(is_validation=is_validation)
        return self.env.ref('payment_openpay_mxn.openpay_mxn_redirect_form')

    def _build_request_url(self, endpoint, **kwargs):
        if self.code != 'openpay_mxn':
            return super()._build_request_url(endpoint, **kwargs)
        base_url = 'https://sandbox-api.openpay.mx' if self.state == 'test' else 'https://api.openpay.mx'
        return f'{base_url}/v1/{self.openpay_mxn_merchant_id}/{endpoint.lstrip("/")}'

    def _build_request_headers(self, method, endpoint, payload, **kwargs):
        if self.code != 'openpay_mxn':
            return super()._build_request_headers(method, endpoint, payload, **kwargs)
        return {'Content-Type': 'application/json', 'Accept': 'application/json'}

    def _build_request_auth(self, **kwargs):
        if self.code != 'openpay_mxn':
            return super()._build_request_auth(**kwargs)
        # Openpay private-key authentication is HTTP Basic: key as user, blank password.
        return (self.openpay_mxn_private_key, '')

    def _parse_response_error(self, response):
        if self.code != 'openpay_mxn':
            return super()._parse_response_error(response)
        try:
            error = response.json().get('error', {})
            return error.get('description') or error.get('message') or response.text
        except ValueError:
            return response.text

    def _parse_response_content(self, response, **kwargs):
        if self.code != 'openpay_mxn':
            return super()._parse_response_content(response, **kwargs)
        return response.json()
