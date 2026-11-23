# Yazbek Matrix Batch v19.0.1.2.1 — Odoo 19 Enterprise

## Nuevo en v19.0.1.2.1: Menudeo/Mayoreo sin restricción de país
- La tarifa del **carrito web** se determina por la suma de **piezas reales**, sin importar el país de la empresa del sitio (México, Chile u otro).
- Aplica solamente a carritos web (`draft`/`sent`) que dispongan de listas **Menudeo** y **Mayoreo** válidas para el sitio y su compañía; no cambia pedidos de empresas o sitios sin esas listas.
- El umbral se mantiene en **12 piezas**; se suman todas las líneas de productos, excluyendo envío y líneas de presentación.
- Cuando la matriz vende **Cajas**, convierte primero cada caja a sus piezas base antes de enviar al carrito. Ejemplo: **1 caja de 72 = 72 piezas → Mayoreo**.
- Para evitar recálculos redundantes, Odoo recalcula los precios de todas las líneas **solo cuando cambia la lista de precios**. Se conserva la excepción para tarifas especiales «Descuento 14 %».
- La lógica se ejecuta desde el controlador estándar del carrito de `website_sale`: agregar, cambiar cantidad o eliminar una línea. No depende de la automatización Studio.
- **Desactivar en staging** la acción automática `WEB - Recalcular tarifa al cambiar cantidad` antes de probar, pues mantenerla en paralelo puede provocar recálculos duplicados.
- Validar al menos: 11 piezas → Menudeo; 12 piezas → Mayoreo; 1 caja de 72 → Mayoreo; eliminación de línea hasta quedar en menos de 12 → Menudeo; tarifas por website y empresa; no afectar las tarifas especiales.

## Nuevo en v19.0.1.2.0: modalidad de compra por website
- **Sitio web → Configuración → Ajustes → eCommerce → Venta en la matriz por**:
  - **Solo unidades** (valor inicial, respeta el comportamiento anterior).
  - **Solo cajas** (permite capturar cajas completas).
  - **Unidades y cajas** (se muestran botones para que el comprador elija).
- El ajuste queda guardado en cada `website`: México y Chile pueden tener configuraciones distintas. No modifica los ajustes de decimales ni disponibilidad anteriores.
- **Piezas por caja**: se leen en el servidor desde el campo de la variante `product.product.x_studio_embalaje_variante` (o el del producto plantilla si la variante no define ese campo). Debe contener un número entero positivo, p. ej. `72`. Si falta o no es válido, la variante no puede comprarse en modo Cajas; no se inventa un embalaje de 1.
- **Disponibilidad** en cajas = `floor(piezas disponibles / piezas por caja)`; las piezas sobrantes no cuentan como caja completa. Ejemplo: 150 piezas en variante de 72 pzas/caja = 2 cajas disponibles (sobran 6 piezas). Se respeta «Mostrar disponibilidad» para ocultar o mostrar cifras.
- **Precio en matriz**: en Unidades se muestra precio por pieza; en Cajas se muestra precio por caja completa (precio unitario calculado por la tarifa vigente y cantidad física correspondiente, multiplicado por piezas/caja). La tarjeta «Desde» sigue expresando el precio por **pieza**, como antes.
- **Carrito/ventas**: 2 cajas de 72 se envían como 144 **unidades base**. Odoo registra y calcula el pedido en piezas; no crea nuevas unidades de medida ni paquetes físicos. La tarifa Menudeo/Mayoreo usa el total real de piezas. Las ediciones posteriores en el carrito estándar siguen expresadas en piezas.
- **Cambio de modo**: si el usuario había capturado cantidades, se solicita confirmación antes de reiniciarlas; evita que 2 unidades pasen a interpretarse automáticamente como 2 cajas.
- Las cotizaciones, impuestos, envío, inventario, promociones y pagos no cambian. Las opciones Unidades/Cajas controlan la **interfaz de la matriz**; no son una restricción global para otras rutas del catálogo/carrito estándar.
- El endpoint por lotes conserva el límite de 25 variantes y procesa ambos esquemas sin consultar 198 variantes individualmente. Al alternar modo se vuelven a consultar los lotes una vez para obtener el precio aplicable al empaque.

### Pruebas obligatorias en staging
1. Selecciona **Yazbek México**, cambia a «Unidades y cajas» y guarda. En la ficha con matriz comprueba que aparezcan ambos botones.
2. Revisa una variante configurada con **72 piezas/caja** y, con disponibilidad de 150 piezas, comprueba «Disponible: 2 cajas». En Unidades muestra 150 unidades.
3. Agrega 2 cajas: el carrito debe recibir **144 piezas** (no 2). Comprueba precios unitarios, subtotal, impuestos y tarifa Mayoreo.
4. Prueba variantes con diferentes embalajes (p. ej. 18, 36, 72); comprueba también una variante **sin embalaje**, que no debe admitir cajas.
5. Cambia la modalidad a «Solo cajas» y luego «Solo unidades»; prueba que la otra opción no aparezca en la matriz.
6. Selecciona **Yazbek Chile** y usa una modalidad diferente; verifica que México no cambie. Prueba las dos casillas previas de precios/stock.
7. En Network valida lotes (`/yazbek/matrix/variants/batch`) y que no aparezcan errores JS ni 500.
8. Prueba el carrito, envío y checkout completos con una cuenta de prueba. **No subir a producción sin completar estas pruebas.**

## Cambios anteriores (v19.0.1.1.0)
- Se agregan dos checkboxes independientes por sitio web en **Sitio web → Configuración → Ajustes → eCommerce**. Seleccionar arriba **Yazbek México** o **Yazbek Chile**, cambiar las opciones y Guardar.
- **Precio con decimales**: activado = mostrar dos decimales; desactivado = mostrar precios enteros, redondeados para su **visualización**. Abarca los importes monetarios estándar del sitio (catálogo, página del producto, carrito y checkout) y los precios de la matriz personalizada. No altera el valor unitario real ni el redondeo de impuestos, entregas, cobros o facturas.
- **Mostrar disponibilidad de producto**: activado = dejar visible la información de disponibilidad que ya ofrece Odoo en cada producto; desactivado = ocultar las cantidades disponibles mostradas por `website_sale_stock` y la matriz personalizada. La comprobación y restricciones de existencias **siguen activas**; se conservan avisos de producto agotado y la opción de aviso de reposición de Odoo.
- Los ajustes se guardan **en el registro `website`**, no como configuración general de la empresa; cada web puede tener su combinación de opciones.
- Inicialmente ambas casillas estarán marcadas en los sitios existentes, para mantener el comportamiento de México. **Revisa Chile**: si deseas conservar precios enteros CLP, desmarca allí «Precio con decimales».
- No se realizan llamadas extra al servidor. El formato decimal también se actualiza cuando el precio cambia de forma dinámica.

## Instalación de la nueva versión
1. Reemplaza la carpeta antigua `yazbek_variant_matrix_batch` por esta carpeta, respetando el nombre técnico.
2. Despliega en una rama de **staging** de Odoo.sh.
3. En Odoo (modo desarrollador), abre Apps y pulsa **Actualizar** sobre «Yazbek - Matriz de variantes por lotes».
4. Ve a **Sitio web → Configuración → Ajustes**, selecciona el website desde el selector superior, marca las dos opciones a tu gusto y pulsa **Guardar**. Repite en cada sitio web.
5. Recarga las páginas públicas con `Ctrl+Shift+R`; comprueba el catálogo, una ficha con matriz, carrito y checkout, con ambos estados activado/desactivado.
6. Valida especialmente que los importes finales, impuestos y stock se calculen igual con ambas presentaciones. No instalar directamente en producción sin completar estas pruebas.

## Cambios de la base v19.0.1.0.2
- 198 variantes se cargan mediante 8 solicitudes JSON-RPC de hasta 25 productos (dos tarifas).
- El JavaScript **no** llama `/shop/change_pricelist` en la carga de la cuadrícula o al escribir cantidades.
- Las cantidades editadas consultan `/yazbek/matrix/variants/batch` con `quantity`, tarifa y producto explícitos.
- La tarjeta «Desde»: Menudeo (1 pieza) / Mayoreo (12 piezas); no sobreescribe el precio de 12 con precios de celda de 1.
- Se añade `models/sale_order.py`: al terminar de agregar/modificar/quitar líneas de un carrito web, Odoo recalcula la tarifa según el total acumulado en unidades base y **recalcula todas las líneas solo si la tarifa cambia**. Desde v19.0.1.2.1 aplica sin filtro de país.
- Conserva el tratamiento especial «Descuento 14 %».
- **Actualizado en v19.0.1.2.1:** también aplica a Chile y a cualquier país con tarifas Menudeo/Mayoreo válidas.

## PASOS IMPORTANTES EN STAGING
1. Sustituye la carpeta anterior `yazbek_variant_matrix_batch` por la de este ZIP, sin dejar dos versiones del módulo.
2. **DESACTIVA EN STAGING** la acción automática `WEB - Recalcular tarifa al cambiar cantidad` (solo después de dejar disponible esta versión en staging). Si mantienes ambas activas, pueden competir o duplicar cálculos.
3. Conserva las vistas QWeb que generan `#yazbek-variant-matrix-data` y `#yazbek-price-card`; retira el JS antiguo de los assets o editor web.
4. Reinicia/actualiza el módulo Odoo en staging: modo desarrollador → Apps → actualizar lista → Upgrade de "Yazbek - Matriz de variantes por lotes". Despliegue en Odoo.sh, luego recarga forzada Ctrl+Shift+R.
5. Prueba 11 piezas en el carrito → agregar 1 = Mayoreo; quitar 1 = Menudeo; borrar una línea completa; cambiar cantidades en varias variantes; clientes «Descuento 14 %»; IVA, precios y total del pedido.
6. Comprueba Network: `/yazbek/matrix/variants/batch` ~8 iniciales y **0** solicitudes de `/shop/change_pricelist` procedentes de esta cuadrícula. El JS base de Odoo puede emitir `get_combination_info`.

## Nota sobre tarifas configuradas
- No filtra por país: funciona con cualquier `website` que tenga listas `Menudeo` y `Mayoreo` válidas para el sitio y su empresa.
- Deben existir listas `Menudeo` y `Mayoreo` para ese website/empresa.
- Se usa el mínimo de 12 piezas sumando todas las líneas de producto, excluyendo transporte y líneas de presentación. La conversión de unidad se realiza con `_compute_quantity`.
- No modifica pedidos confirmados.
- La lógica se activa en el carrito mediante `_verify_cart_after_update()` de Odoo 19, que es invocada al agregar y actualizar/eliminar líneas por las rutas estándar.
- Al cambiar de tarifa ejecuta `_recompute_prices()`, que puede reiniciar descuentos aplicados manualmente; validar si se usan promociones extra.

## Validación
Validación de sintaxis Python/JavaScript y simulación de la carga de lotes; **no hay prueba de integración en una base Odoo 19 Enterprise real desde este entorno**. No desplegar en producción sin pruebas completas de pedido e impuestos.
