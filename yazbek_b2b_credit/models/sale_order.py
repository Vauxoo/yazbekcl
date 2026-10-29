from odoo import fields, models


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    b2b_credit_confirmed = fields.Boolean(readonly=True, copy=False)
    b2b_credit_currency_id = fields.Many2one(
        related='company_id.currency_id', string='Company Currency', readonly=True,
    )
    b2b_credit_limit_snapshot = fields.Monetary(
        string='B2B Credit Limit at Confirmation', readonly=True, copy=False,
        currency_field='b2b_credit_currency_id',
    )
    b2b_credit_available_snapshot = fields.Monetary(
        string='B2B Credit Available at Confirmation', readonly=True, copy=False,
        currency_field='b2b_credit_currency_id',
    )

    def _b2b_amount_total_company_currency(self):
        self.ensure_one()
        return self.currency_id._convert(
            self.amount_total,
            self.company_id.currency_id,
            self.company_id,
            fields.Date.context_today(self),
        )

    def _b2b_uninvoiced_reserve_company_currency(self):
        """Reserve only the portion not already posted as an invoice.

        `amount_total` and `amount_total_signed` include IVA and delivery lines.
        A draft invoice is intentionally ignored here: until it is posted it is not
        part of accounts receivable, so the order must remain fully reserved.
        """
        self.ensure_one()
        order_total = self._b2b_amount_total_company_currency()
        posted_invoices = self.invoice_ids.filtered(
            lambda move: move.state == 'posted'
            and move.move_type in ('out_invoice', 'out_refund')
        )
        posted_total = sum(posted_invoices.mapped('amount_total_signed'))
        return max(order_total - posted_total, 0.0)

    def _b2b_confirm_with_credit(self):
        """Confirm a website order after the partner-level credit validation."""
        self.ensure_one()
        commercial_partner = self.partner_id.commercial_partner_id
        snapshot = commercial_partner._b2b_validate_credit_for_order(self)
        self.write({
            'b2b_credit_confirmed': True,
            'b2b_credit_limit_snapshot': snapshot['limit'],
            'b2b_credit_available_snapshot': snapshot['available'],
        })
        # `_validate_order` is the Odoo 19 checkout hook. It confirms and sends
        # the normal sale confirmation notification, but creates no payment.
        self._validate_order()
