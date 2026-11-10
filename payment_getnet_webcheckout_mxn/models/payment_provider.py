import json

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError
from odoo.tools import urls

from odoo.addons.payment_getnet_webcheckout_mxn import const
from odoo.addons.payment_getnet_webcheckout_mxn import getcheckout_crypto


class PaymentProvider(models.Model):
    _inherit = 'payment.provider'

    code = fields.Selection(
        selection_add=[(const.PROVIDER_CODE, 'Get Checkout (MIT México)')],
        ondelete={const.PROVIDER_CODE: 'set default'},
    )
    getcheckout_company_id = fields.Char(string='ID de comercio MIT', groups='base.group_system')
    getcheckout_branch_id = fields.Char(string='ID de sucursal MIT', groups='base.group_system')
    getcheckout_user = fields.Char(string='Usuario de integraciones MIT', groups='base.group_system')
    getcheckout_password = fields.Char(
        string='Contraseña de integraciones MIT', groups='base.group_system',
    )
    getcheckout_data0 = fields.Char(string='Data0 MIT', groups='base.group_system')
    getcheckout_aes_key = fields.Char(string='Llave AES MIT', groups='base.group_system')
    getcheckout_qa_url = fields.Char(
        string='URL de QA', default=const.QA_API_URL, groups='base.group_system', required_if_provider=const.PROVIDER_CODE,
    )
    getcheckout_production_url = fields.Char(
        string='URL de producción', groups='base.group_system',
        help='MIT entrega esta URL una vez que la certificación en QA fue aprobada.',
    )
    getcheckout_suppress_email_notification = fields.Boolean(
        string='No enviar correo de cobro desde MIT', default=True,
        help='Se envía como suppress_email_notification en la solicitud a MIT.',
    )

    @api.constrains(
        'state', 'getcheckout_company_id', 'getcheckout_branch_id', 'getcheckout_user',
        'getcheckout_password', 'getcheckout_data0', 'getcheckout_aes_key', 'getcheckout_qa_url',
        'getcheckout_production_url',
    )
    def _check_getcheckout_configuration(self):
        required_fields = (
            'getcheckout_company_id', 'getcheckout_branch_id', 'getcheckout_user',
            'getcheckout_password', 'getcheckout_data0', 'getcheckout_aes_key',
        )
        for provider in self.filtered(lambda p: p.code == const.PROVIDER_CODE and p.state != 'disabled'):
            missing = [field for field in required_fields if not provider[field]]
            if missing:
                raise ValidationError(_('Completa las credenciales de Get Checkout/MIT antes de habilitarlo.'))
            try:
                getcheckout_crypto._key_from_hex(provider.getcheckout_aes_key)
            except ValueError as error:
                raise ValidationError(str(error)) from error
            if provider.state == 'test' and not provider.getcheckout_qa_url:
                raise ValidationError(_('Configura la URL de QA de Get Checkout/MIT.'))
            if provider.state == 'enabled' and not provider.getcheckout_production_url:
                raise ValidationError(_('MIT debe proporcionarte la URL de producción antes de activar el proveedor.'))

    def write(self, vals):
        """Activate Card only after this provider is usable.

        Odoo 19 rejects activating a payment method unless an attached provider
        is already in test or enabled state.  At XML installation time this
        provider must remain disabled because its merchant credentials are not
        known yet, so activating Card is intentionally deferred to this point.
        """
        result = super().write(vals)
        if vals.get('state') in ('test', 'enabled'):
            getcheckout_providers = self.filtered(
                lambda provider: provider.code == const.PROVIDER_CODE
                and provider.state in ('test', 'enabled')
            )
            card_methods = getcheckout_providers.payment_method_ids.filtered(
                lambda method: method.code == 'card' and not method.active
            )
            if card_methods:
                card_methods.write({'active': True})
        return result

    def _compute_feature_support_fields(self):
        super()._compute_feature_support_fields()
        self.filtered(lambda provider: provider.code == const.PROVIDER_CODE).update({
            'support_express_checkout': False,
            'support_manual_capture': False,
            'support_refund': 'none',
            'support_tokenization': False,
        })

    def _get_default_payment_method_codes(self):
        self.ensure_one()
        if self.code != const.PROVIDER_CODE:
            return super()._get_default_payment_method_codes()
        return const.DEFAULT_PAYMENT_METHOD_CODES

    def _get_supported_currencies(self):
        currencies = super()._get_supported_currencies()
        if self.code == const.PROVIDER_CODE:
            currencies = currencies.filtered(lambda currency: currency.name in const.SUPPORTED_CURRENCIES)
        return currencies

    def _get_redirect_form_view(self, is_validation=False):
        self.ensure_one()
        if self.code != const.PROVIDER_CODE:
            return super()._get_redirect_form_view(is_validation=is_validation)
        return self.env.ref('payment_getnet_webcheckout_mxn.redirect_form')

    def _getcheckout_api_url(self):
        self.ensure_one()
        return self.getcheckout_qa_url if self.state == 'test' else self.getcheckout_production_url

    def _getcheckout_webhook_url(self):
        self.ensure_one()
        return urls.urljoin(self.get_base_url(), '/payment/getcheckout_mxn/webhook')

    def _getcheckout_encrypt_payload(self, payload):
        self.ensure_one()
        plaintext = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        return getcheckout_crypto.encrypt(plaintext, self.getcheckout_aes_key)

    def _getcheckout_decrypt_payload(self, ciphertext):
        self.ensure_one()
        try:
            plaintext = getcheckout_crypto.decrypt(ciphertext, self.getcheckout_aes_key)
        except ValueError as error:
            # Keep encryption details out of the storefront and avoid returning
            # an unhandled RPC error when MIT sends an invalid response.
            raise ValidationError(
                _('Get Checkout devolvió una respuesta cifrada inválida.')
            ) from error
        try:
            decoded = json.loads(plaintext)
        except json.JSONDecodeError as error:
            raise ValidationError(_('Get Checkout devolvió contenido descifrado que no es JSON válido.')) from error
        if not isinstance(decoded, dict):
            raise ValidationError(_('Get Checkout devolvió una estructura de respuesta inválida.'))
        return decoded

    def _build_request_url(self, endpoint, **kwargs):
        if self.code != const.PROVIDER_CODE:
            return super()._build_request_url(endpoint, **kwargs)
        return self._getcheckout_api_url()

    def _build_request_headers(self, *args, **kwargs):
        if self.code != const.PROVIDER_CODE:
            return super()._build_request_headers(*args, **kwargs)
        return {'Accept': 'application/json', 'Content-Type': 'application/json'}

    def _parse_response_content(self, response, **kwargs):
        if self.code != const.PROVIDER_CODE:
            return super()._parse_response_content(response, **kwargs)
        try:
            content = response.json()
        except ValueError:
            content = response.text
        ciphertext = content.get('data') if isinstance(content, dict) else content
        if not isinstance(ciphertext, str) or not ciphertext:
            message = content.get('message') if isinstance(content, dict) else None
            if message:
                raise ValidationError(_('Get Checkout no devolvió la liga cifrada esperada: %s', message))
            raise ValidationError(_('Get Checkout no devolvió la respuesta cifrada esperada.'))
        return self._getcheckout_decrypt_payload(ciphertext)

    def _parse_response_error(self, response):
        if self.code != const.PROVIDER_CODE:
            return super()._parse_response_error(response)
        try:
            content = response.json()
        except ValueError:
            return response.text[:500]
        return content.get('message') or content.get('error') or str(content)
