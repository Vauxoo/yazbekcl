{
    "name": "Yazbek - Matriz de variantes por lotes",
    "summary": "Matriz eCommerce por lotes, tarifas y modalidades de compra por sitio",
    "version": "19.0.1.2.0",
    "category": "Website/Website",
    "author": "Yazbek",
    "license": "LGPL-3",
    "depends": ["website_sale_stock"],
    "data": [
        "views/res_config_settings_views.xml",
        "views/website_layout_views.xml",
    ],
    "assets": {
        "web.assets_frontend": [
            "yazbek_variant_matrix_batch/static/src/js/yazbek_variant_matrix.js",
            "yazbek_variant_matrix_batch/static/src/js/yazbek_website_display.js",
            "yazbek_variant_matrix_batch/static/src/scss/yazbek_website_display.scss",
        ],
    },
    "installable": True,
    "application": False,
}
