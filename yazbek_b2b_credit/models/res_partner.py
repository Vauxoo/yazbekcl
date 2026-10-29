from odoo import _, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, format_amount


class ResPartner(models.Model):
    _inherit = 'res.partner'

    b2b_credit_authorized = fields.Boolean(
        string='Authorised for B2B Website Credit',
        company_dependent=True,
        copy=False,
        help=(
            'Allows this commercial partner to use its configured credit limit in '
            'the website checkout. This never creates a payment.'
        ),
    )

    def _commercial_fields(self):
        return super()._commercial_fields() + ['b2b_credit_authorized']

    def _b2b_credit_lock(self):
        """Serialise credit confirmations for one commercial partner.

        The lock lasts until the HTTP transaction commits or rolls back.  A second
        simultaneous checkout waits, then recalculates its available credit after
        the first order has become a confirmed order/reservation.
        """
        commercial_partner = self.commercial_partner_id
        self.env.cr.execute(
            'SELECT pg_advisory_xact_lock(%s, %s)',
            (190019, commercial_partner.id),
        )

    def _b2b_credit_snapshot(self, current_order=None):
        """Return the credit position in the order company currency.

        Exposure = open customer receivables + the still-uninvoiced portions of
        confirmed orders.  Posted invoices are represented by receivables, while
        draft invoices remain part of the order reservation; this prevents double
        counting.  All amounts are tax and delivery inclusive.
        """
        self.ensure_one()
        partner = self.commercial_partner_id
        company = current_order.company_id if current_order else self.env.company
        partner = partner.with_company(company)
        order = current_order or self.env['sale.order']
        child_partner_ids = self.with_context(active_test=False).search([
            ('id', 'child_of', partner.id),
        ]).ids

        self.env.cr.execute("""
            SELECT COALESCE(SUM(aml.amount_residual), 0)
              FROM account_move_line AS aml
              JOIN account_account AS account ON account.id = aml.account_id
             WHERE aml.parent_state = 'posted'
               AND aml.company_id = %s
               AND aml.partner_id = ANY(%s)
               AND aml.reconciled IS NOT TRUE
               AND account.account_type = 'asset_receivable'
        """, (company.id, child_partner_ids))
        receivables = self.env.cr.fetchone()[0] or 0.0

        order_domain = [
            ('company_id', '=', company.id),
            ('partner_id', 'in', child_partner_ids),
            ('state', 'in', ('sale', 'done')),
        ]
        if order:
            order_domain.append(('id', 'not in', order.ids))
        confirmed_orders = self.env['sale.order'].sudo().search(order_domain)
        reserved = sum(
            confirmed_order._b2b_uninvoiced_reserve_company_currency()
            for confirmed_order in confirmed_orders
        )

        limit = partner.credit_limit
        available = limit - receivables - reserved
        order_total = order._b2b_amount_total_company_currency() if order else 0.0
        currency = company.currency_id
        authorized = bool(partner.b2b_credit_authorized and limit > 0.0)
        return {
            'authorized': authorized,
            'limit': limit,
            'receivables': receivables,
            'reserved': reserved,
            'available': available,
            'order_total': order_total,
            'can_confirm': authorized and float_compare(
                available, order_total, precision_rounding=currency.rounding
            ) >= 0,
        }

    def _b2b_validate_credit_for_order(self, order):
        """Lock and validate the final credit amount for a checkout order."""
        self.ensure_one()
        commercial_partner = self.commercial_partner_id.with_company(order.company_id)
        commercial_partner._b2b_credit_lock()
        # The preceding waiter may have confirmed another order while this request
        # was waiting. Refresh all checkout values *after* the lock, then drop
        # cached values before calculating the final credit position.
        order.invalidate_recordset()
        order._recompute_cart()
        order._check_cart_is_ready_to_be_paid()
        order.invalidate_recordset()
        snapshot = commercial_partner._b2b_credit_snapshot(current_order=order)
        if not snapshot['authorized']:
            raise UserError(_(
                'Commercial credit is not authorised for this customer or it has no credit limit.'
            ))
        if not snapshot['can_confirm']:
            raise UserError(_(
                'Insufficient commercial credit. Available: %(available)s; order total: %(total)s.',
                available=format_amount(self.env, snapshot['available'], order.company_id.currency_id),
                total=format_amount(self.env, snapshot['order_total'], order.company_id.currency_id),
            ))
        return snapshot
