from odoo.tests.common import TransactionCase


class TestB2BCredit(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.customer = cls.env['res.partner'].create({
            'name': 'Cliente crédito web',
            'b2b_credit_authorized': True,
            'credit_limit': 1000.0,
        })
        cls.product = cls.env['product.product'].create({
            'name': 'Producto de prueba crédito',
            'list_price': 100.0,
        })

    def _new_confirmed_order(self, amount):
        order = self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [(0, 0, {
                'product_id': self.product.id,
                'product_uom_qty': 1,
                'price_unit': amount,
            })],
        })
        order.action_confirm()
        return order

    def test_authorisation_is_required(self):
        self.customer.b2b_credit_authorized = False
        snapshot = self.customer._b2b_credit_snapshot()
        self.assertFalse(snapshot['authorized'])

    def test_confirmed_uninvoiced_order_is_reserved(self):
        self._new_confirmed_order(250.0)
        snapshot = self.customer._b2b_credit_snapshot()
        self.assertEqual(snapshot['receivables'], 0.0)
        self.assertEqual(snapshot['reserved'], 250.0)
        self.assertEqual(snapshot['available'], 750.0)

    def test_posted_invoice_replaces_order_reservation(self):
        order = self._new_confirmed_order(250.0)
        invoice = order._create_invoices()
        invoice.action_post()
        snapshot = self.customer._b2b_credit_snapshot()
        self.assertEqual(order._b2b_uninvoiced_reserve_company_currency(), 0.0)
        self.assertEqual(snapshot['receivables'], 250.0)
        self.assertEqual(snapshot['reserved'], 0.0)
        self.assertEqual(snapshot['available'], 750.0)
