"""AES-128-CBC helpers compatible with MIT's published Python component."""

import base64
import os

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def _key_from_hex(aes_key):
    """Return the 16-byte key required by the provider's AES-128 contract."""
    try:
        key = bytes.fromhex((aes_key or '').strip())
    except ValueError as error:
        raise ValueError('La llave AES debe estar en formato hexadecimal.') from error
    if len(key) != 16:
        raise ValueError('La llave AES debe tener exactamente 32 caracteres hexadecimales.')
    return key


def encrypt(plaintext, aes_key):
    """Encrypt UTF-8 text and return Base64(IV + ciphertext)."""
    key = _key_from_hex(aes_key)
    iv = os.urandom(16)
    padder = padding.PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(plaintext.encode('utf-8')) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(iv + ciphertext).decode('ascii')


def decrypt(ciphertext, aes_key):
    """Decrypt a Base64(IV + ciphertext) value and return UTF-8 text."""
    key = _key_from_hex(aes_key)
    try:
        encrypted = base64.b64decode((ciphertext or '').encode('ascii'), validate=True)
    except (ValueError, UnicodeEncodeError) as error:
        raise ValueError('La respuesta cifrada no tiene un Base64 válido.') from error
    if len(encrypted) <= 16 or len(encrypted[16:]) % 16:
        raise ValueError('La respuesta cifrada tiene un tamaño inválido.')
    decryptor = Cipher(algorithms.AES(key), modes.CBC(encrypted[:16])).decryptor()
    padded = decryptor.update(encrypted[16:]) + decryptor.finalize()
    unpadder = padding.PKCS7(algorithms.AES.block_size).unpadder()
    try:
        return (unpadder.update(padded) + unpadder.finalize()).decode('utf-8')
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError('No fue posible descifrar la respuesta de Get Checkout.') from error
