{
    'name': 'Get Checkout (MIT México)',
    'version': '19.0.1.0.5',
    'author': 'Yazbek',
    'category': 'Accounting/Payment Providers',
    'summary': 'Get Checkout / MIT encrypted payment-link provider for Mexico',
    'description': """Hosted payment provider for Get Checkout (MIT México).

The module creates AES-128 encrypted payment-link requests and processes the
encrypted POST notification configured with MIT.
""",
    'depends': ['payment', 'website_sale'],
    'data': [
        'views/payment_provider_views.xml',
        'views/payment_getcheckout_templates.xml',
        'data/payment_provider_data.xml',
    ],
    'external_dependencies': {'python': ['cryptography']},
    'license': 'LGPL-3',
    'installable': True,
    'application': False,
}
