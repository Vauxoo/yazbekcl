from odoo.tests.common import TransactionCase


class TestOpenpayMXN(TransactionCase):
    def test_openpay_mxn_payload_is_bank_only(self):
        provider = self.env.ref('payment_openpay_mxn.payment_provider_openpay_mxn')
        self.assertEqual(provider.code, 'openpay_mxn')
        self.assertEqual(provider._get_default_payment_method_codes(), ['bank_transfer'])

    def test_openpay_mxn_currency_is_mxn_only(self):
        provider = self.env.ref('payment_openpay_mxn.payment_provider_openpay_mxn')
        self.assertEqual(provider._get_supported_currencies().mapped('name'), ['MXN'])
