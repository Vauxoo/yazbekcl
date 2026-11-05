"""Portable validation; run with `python -m unittest discover -s tests -p test_static_validation.py`."""
import ast
import pathlib
import unittest
import xml.etree.ElementTree as ET


MODULE = pathlib.Path(__file__).resolve().parents[1]


class TestStaticValidation(unittest.TestCase):
    def test_python_files_parse(self):
        for path in MODULE.rglob('*.py'):
            ast.parse(path.read_text(encoding='utf-8'), filename=str(path))

    def test_xml_files_parse(self):
        for path in MODULE.rglob('*.xml'):
            ET.parse(path)

    def test_scope_is_bank_transfer_only(self):
        source = (MODULE / 'models' / 'payment_transaction.py').read_text(encoding='utf-8')
        self.assertIn("'method': 'bank_account'", source)
        self.assertIn("'customer': self._openpay_mxn_prepare_customer_data()", source)
        self.assertIn("'email': self.partner_email[:100]", source)
        self.assertIn("'due_date': self._openpay_mxn_get_due_date()", source)
        self.assertIn("ZoneInfo('America/Mexico_City')", source)
        self.assertIn('openpay_mxn_expiration_days', source)
        self.assertIn("'amount': payment_data.get('amount', self.amount)", source)
        self.assertIn("'currency_code': payment_data.get('currency', self.currency_id.name)", source)
        self.assertIn("datetime.fromisoformat(value.replace('Z', '+00:00'))", source)
        self.assertIn('parsed.astimezone(timezone.utc).replace(tzinfo=None)', source)
        self.assertNotIn("'method': 'card'", source)
        self.assertIn(
            "['bank_transfer']",
            (MODULE / 'models' / 'payment_provider.py').read_text(encoding='utf-8'),
        )

    def test_provider_config_exposes_expiration_and_official_environment_urls(self):
        source = (MODULE / 'views' / 'payment_provider_views.xml').read_text(encoding='utf-8')
        self.assertIn('openpay_mxn_expiration_days', source)
        self.assertIn('https://sandbox-api.openpay.mx', source)
        self.assertIn('https://api.openpay.mx', source)

    def test_redirect_flow_provides_a_form_and_status_transition(self):
        template = (MODULE / 'views' / 'payment_openpay_mxn_templates.xml').read_text(encoding='utf-8')
        controller = (MODULE / 'controllers' / 'main.py').read_text(encoding='utf-8')
        binding = (MODULE / 'data' / 'payment_redirect_binding.xml').read_text(encoding='utf-8')
        self.assertIn('<form t-att-action="api_url" method="post">', template)
        self.assertIn("'/payment/openpay_mxn/process'", controller)
        self.assertIn("request.redirect('/payment/status')", controller)
        self.assertIn('redirect_form_view_id', binding)
        provider = (MODULE / 'models' / 'payment_provider.py').read_text(encoding='utf-8')
        self.assertIn("payment_openpay_mxn.openpay_mxn_redirect_form", provider)

    def test_no_credentials_embedded(self):
        contents = '\n'.join(
            path.read_text(encoding='utf-8')
            for path in MODULE.rglob('*')
            if path.is_file() and path.suffix in {'.py', '.xml', '.md'}
        )
        self.assertNotRegex(contents, r'(?i)sk_[0-9a-f]{20,}')

    def test_manifest_declares_author_and_avoids_unsupported_field_parameter(self):
        manifest = (MODULE / '__manifest__.py').read_text(encoding='utf-8')
        self.assertIn("'author':", manifest)
        source = '\n'.join(
            path.read_text(encoding='utf-8') for path in (MODULE / 'models').glob('*.py')
        )
        self.assertNotIn('password=True', source)

    def test_webhook_uses_nested_transaction_and_retains_verification_code(self):
        source = (MODULE / 'controllers' / 'main.py').read_text(encoding='utf-8')
        self.assertIn("payload.get('transaction')", source)
        self.assertIn("payload.get('verification_code')", source)
        self.assertIn("openpay_mxn_verification_code", source)

    def test_provider_binds_bank_transfer_without_activating_it_in_xml(self):
        binding = (MODULE / 'data' / 'payment_method_binding.xml').read_text(encoding='utf-8')
        self.assertIn("payment.payment_method_bank_transfer", binding)
        self.assertIn('Command.link', binding)
        self.assertNotIn('<field name="active">True</field>', binding)


if __name__ == '__main__':
    unittest.main()
