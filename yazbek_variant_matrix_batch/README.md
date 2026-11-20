# Yazbek Matrix Batch v19.0.1.0.2 — Odoo 19 Enterprise

## Cambios de esta versión
- 198 variantes se cargan mediante 8 solicitudes JSON-RPC de hasta 25 productos (dos tarifas).
- El JavaScript **no** llama `/shop/change_pricelist` en la carga de la cuadrícula o al escribir cantidades.
- Las cantidades editadas consultan `/yazbek/matrix/variants/batch` con `quantity`, tarifa y producto explícitos.
- La tarjeta «Desde»: Menudeo (1 pieza) / Mayoreo (12 piezas); no sobreescribe el precio de 12 con precios de celda de 1.
- Se añade `models/sale_order.py`: al terminar de agregar/modificar/quitar líneas de un carrito web de compañía mexicana, Odoo recalcula la tarifa según el total acumulado en unidades base, y **recalcula todas las líneas solo si la tarifa cambia**. Sin acciones automáticas en cada línea.
- Conserva el tratamiento especial «Descuento 14 %».
- No aplica al sitio de Chile (filtro de compañía del sitio con código `MX`).

## PASOS IMPORTANTES EN STAGING
1. Sustituye la carpeta anterior `yazbek_variant_matrix_batch` por la de este ZIP, sin dejar dos versiones del módulo.
2. **DESACTIVA EN STAGING** la acción automática `WEB - Recalcular tarifa al cambiar cantidad` (solo después de dejar disponible esta versión en staging). Si mantienes ambas activas, pueden competir o duplicar cálculos.
3. Conserva las vistas QWeb que generan `#yazbek-variant-matrix-data` y `#yazbek-price-card`; retira el JS antiguo de los assets o editor web.
4. Reinicia/actualiza el módulo Odoo en staging: modo desarrollador → Apps → actualizar lista → Upgrade de "Yazbek - Matriz de variantes por lotes". Despliegue en Odoo.sh, luego recarga forzada Ctrl+Shift+R.
5. Prueba 11 piezas en el carrito → agregar 1 = Mayoreo; quitar 1 = Menudeo; borrar una línea completa; cambiar cantidades en varias variantes; clientes «Descuento 14 %»; IVA, precios y total del pedido.
6. Comprueba Network: `/yazbek/matrix/variants/batch` ~8 iniciales y **0** solicitudes de `/shop/change_pricelist` procedentes de esta cuadrícula. El JS base de Odoo puede emitir `get_combination_info`.

## Nota sobre tarifas configuradas
- Solo aplica a sitios cuyo `website.company_id.country_id.code` sea `MX`.
- Deben existir listas `Menudeo` y `Mayoreo` para ese website/empresa.
- Se usa el mínimo de 12 piezas sumando todas las líneas de producto, excluyendo transporte y líneas de presentación. La conversión de unidad se realiza con `_compute_quantity`.
- No modifica pedidos confirmados.
- La lógica se activa en el carrito mediante `_verify_cart_after_update()` de Odoo 19, que es invocada al agregar y actualizar/eliminar líneas por las rutas estándar.
- Al cambiar de tarifa ejecuta `_recompute_prices()`, que puede reiniciar descuentos aplicados manualmente; validar si se usan promociones extra.

## Validación
Validación de sintaxis Python/JavaScript y simulación de la carga de lotes; **no hay prueba de integración en una base Odoo 19 Enterprise real desde este entorno**. No desplegar en producción sin pruebas completas de pedido e impuestos.
