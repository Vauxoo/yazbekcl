"""Constants for Get Checkout / MIT México."""

PROVIDER_CODE = 'getcheckout_mxn'
QA_API_URL = 'https://qa5.mitec.com.mx/p/gen'
SUPPORTED_CURRENCIES = {'MXN', 'USD'}
DEFAULT_PAYMENT_METHOD_CODES = {'card'}
SENSITIVE_KEYS = {
    'pwd', 'password', 'getcheckout_password', 'getcheckout_aes_key',
    'getcheckout_data0', 'data', 'strResponse', 'str_response',
}
