# Yazbek - Matriz de variantes por lotes (Odoo 19.0 Enterprise) — revisión de vistas QWeb

## Objetivo

Reemplaza el JavaScript de la cuadrícula Yazbek México y añade
`/yazbek/matrix/variants/batch` para reducir solicitudes HTTP al abrir
un producto de 198 variantes. Los lotes contienen hasta 25 variantes,
con hasta 2 solicitudes a la vez. Cada lote calcula precios de Menudeo y Mayoreo (o tarifa especial),
y existencias mediante métodos de Odoo 19. La tarjeta QWeb de Mayoreo
requiere precio de referencia con `quantity=12`, distinto del precio de
celda que se consulta con `quantity=1` inicialmente. El backend responde
ambos conceptos de forma separada. Esto añade trabajo de cálculo en el
servidor, pero mantiene las ~8 solicitudes HTTP por 198 variantes.

**Con 198 variantes se esperan ~8 solicitudes iniciales a la nueva ruta**,
en lugar de unas 396 llamadas individuales; esto **no equivale** a una
reducción del 98 % de uso de CPU, porque el backend sigue calculando
los precios y el inventario de las variantes.

## Requisitos
- Odoo 19.0+e con `website_sale_stock` y el código de plantilla QWeb
  **preexistente** que genera `#yazbek-variant-matrix-data` y sus
  nodos `.yazbek-variant-data`.
- Revisar las tarifas vinculadas a la web de México, incluido el acceso
  a Menudeo/Mayoreo para usuarios públicos.
- Instalar en staging primero. No sobreescribe plantillas ni pedidos.

## MUY IMPORTANTE: no duplicar JS

El módulo registra `yazbek_variant_matrix` en `public.interactions`.
**DESACTIVAR / retirar el JavaScript anterior** de sus assets (o del
editor de código de la web) antes de cargar el nuevo archivo del módulo.
Dejar ambos puede causar error de registro duplicado o dos cuadrículas.
No retirar el QWeb que inyecta las variantes al HTML.

## Instalación en Odoo.sh
1. Subir la carpeta `yazbek_variant_matrix_batch` en el directorio de
   addons personalizados del repositorio, mediante rama feature + PR
   hacia staging/dev según flujo interno.
2. En staging, desactivar el JS anterior, conservar el QWeb de datos.
3. Actualizar lista de Apps, buscar “Yazbek - Matriz de variantes por lotes”
   e instalarlo. Actualizar el bundle assets (si aplica).
4. Recargar página en ventana privada con Ctrl+Shift+R.
5. Verificar en Network (Fetch/XHR):
   `/yazbek/matrix/variants/batch`: cerca de 8 solicitudes para 198
   variantes; sin cientos de `get_combination_info` en la carga inicial.
6. Comprobar precios Menudeo y Mayoreo, transición de 11 a 12 piezas,
   cuenta especial 14 %, disponibilidad y carrito (piezas múltiples).

## Forma del contrato JSON-RPC
Petición:
```
{
  "product_template_id": 123,
  "items": [{"product_id": 456}, {"product_id": 457}],
  "pricelist_ids": [44, 46],
  "reference_quantities": {"46": 12}
}
```
Respuesta de ejemplo:
```
{
  "prices": {
    "44": {"456": {"price": 67.0, "referencePrice": 67.0, "freeQty": 35.0,
                   "cartQty": 0.0, "showAvailability": true,
                   "allowOutOfStock": false, "isStorable": true}},
    "46": {"456": {"price": 62.0, "referencePrice": 60.0, "freeQty": 35.0,
                   "cartQty": 0.0, "showAvailability": true,
                   "allowOutOfStock": false, "isStorable": true}}
  }
}
```
El ejemplo es ilustrativo; no representa precios reales.

## Notas de seguridad y compatibilidad
- API `auth=public`, `type=jsonrpc`, `readonly=True`.
- Limita a 25 variantes y 2 tarifas por petición.
- Verifica que el producto pertenezca al sitio web actual y esté
  publicable; no admite variantes de otras empresas/sitios.
- Permite solo tarifas visibles para el visitante, la tarifa de la sesión
  o las tarifas explícitamente asignadas al sitio actual.
- No cambia la lista de precios ni los pedidos de la sesión al solicitar
  la tarifa alternativa. El JS aún usa el cambio de tarifa estándar
  para que el carrito aplique la lista correspondiente.
- Este código NO elimina integraciones ni valida personalizaciones de
  terceros. Comparar resultados reales con staging previo a producción.
- Cambios de cantidad que activan reglas de precio por cantidad siguen
  consultando una variante a la vez mediante endpoint estándar.
- Si un lote falla, el JS desactiva la venta en lugar de presentar un
  precio o disponibilidad no verificados.

## Diagnóstico de staging
- En consola debería aparecer `Yazbek Matrix Batch 19` con
  `variantes: 198`, `requests: 8` (aproximadamente).
- Revisar logs de Odoo si hay `invalid_pricelist`, errores 500 o
  fallos de cálculo de variantes.
- Si se mantiene el pico de CPU a pesar de haber menos XHR, la siguiente
  fase debe optimizar reglas de precio/cálculo de stock del servidor.

## Compatibilidad con las dos vistas heredadas entregadas
- `//div[@class='product_price']`: muestra precio de una unidad para Menudeo y de doce unidades para Mayoreo, con IVA conforme a fiscalidad del sitio. No se reemplaza.
- `//div[@name='product_price_container']`: crea `#yazbek-price-card` con `data-role=retail-price` y `data-role=wholesale-price`. No se reemplaza.
- Conservar otra vista QWeb que genera `#yazbek-variant-matrix-data`; el módulo la necesita para enumerar variantes.
- Comprobar que las vistas estén limitadas al sitio México. Si la tarifa Mayoreo tiene mínimo 12 por *línea* en la lista de precios, los 12 acumulados entre variantes no garantizan por sí solos precio de mayorista al confirmar el pedido; hay que probar el total.
- La primera vista realiza cálculos en renderizado de catálogo que este módulo NO reduce; revisar si persiste CPU alta al navegar catálogo.
