# Openpay México — SPEI/CIE para Odoo 19 Enterprise

`payment_openpay_mxn` genera una referencia de Openpay para que el comprador pague por
SPEI o CIE. El alcance es exclusivamente `method: bank_account`: no ofrece tarjetas,
tokenización, cargos recurrentes ni reembolsos.

## Instalación

1. Copie la carpeta `payment_openpay_mxn` a una ruta incluida en `addons_path` (en
   Odoo.sh, agréguela al repositorio en una rama de desarrollo).
2. Actualice la lista de Aplicaciones e instale **Openpay México - SPEI/CIE**.
3. En Contabilidad → Configuración → Proveedores de pago, abra el proveedor y capture
   Merchant ID, llave privada y las credenciales HTTP Basic exclusivas para el webhook.
4. Cambie el proveedor a **Modo de prueba**. En la pestaña **Configuración**, pulse
   **Enable Payment Methods**, abra **Bank Transfer** y actívelo. El módulo lo vincula al
   proveedor, pero no lo activa por XML. Publique el proveedor y haga una orden en MXN.
   Solo después de validar el flujo use **Activado**.

Nunca guarde las claves en XML, Git, tickets o mensajes. Los campos están restringidos
al administrador de Odoo y el addon no incluye valores de ejemplo que parezcan secretos.

## Openpay y webhook

* Sandbox: `https://sandbox-api.openpay.mx`; producción: `https://api.openpay.mx`.
* Odoo crea `POST /v1/{MERCHANT_ID}/charges` con `method=bank_account`, monto MXN,
  descripción `Pedido {referencia}`, referencia de pedido y fecha límite configurable por el
  administrador (de 1 a 30 días) a las 23:59:59 de Ciudad de México. Envía `customer` con nombre completo, apellido en blanco y
  correo del comprador. Aunque Openpay documenta `customer` como opcional para este método,
  algunas cuentas lo requieren; por ello Odoo exige correo electrónico al comprador.
* El webhook es `https://SU-DOMINIO/payment/openpay_mxn/webhook`. Regístrelo en el
  dashboard de Openpay con HTTPS/TLS válido y el mismo usuario/contraseña HTTP Basic
  configurados en Odoo. Suscriba `verification`, `charge.created`, `charge.succeeded`,
  `charge.failed`, `charge.cancelled` y, si está disponible para su cuenta, `spei.received`.
  El código recibido durante `verification` queda visible en el proveedor, solo para
  administradores, y también se conserva por proveedor en Parámetros del sistema.
* El webhook no confía en el estado recibido: localiza la transacción y consulta el cargo
  a Openpay antes de cambiar el estado. La tarea programada también revisa pendientes
  cada 10 minutos.

Cuando Openpay devuelve la referencia, Odoo conserva solo: identificador de cargo,
convenio CIE, CLABE, referencia, banco, fecha límite y URL del recibo. El recibo oficial
se construye con el dashboard correspondiente y está disponible mientras el cargo siga
pendiente.

## Instrucciones para el comprador

* En BBVA: pagar servicios, usar el convenio CIE y la referencia devueltos por Openpay.
* En otro banco: registrar BBVA como banco destino, usar la CLABE y colocar la referencia
  numérica en el concepto; capture el monto exacto.

El pedido debe mantenerse pendiente hasta que Openpay confirme `completed`. Generar una
referencia no equivale a recibir el dinero.

La respuesta inicial de algunas cuentas Openpay omite `amount` y `currency`. El addon conserva
para esa respuesta el importe y la moneda inmutables de la transacción Odoo; al consultar el
estado posteriormente, valida los valores devueltos por Openpay antes de confirmar el pago.
La fecha `due_date` devuelta por Openpay se convierte de ISO 8601 con zona horaria al formato UTC
interno de Odoo antes de guardarse.

## Validación previa a producción

1. Pruebe una orden MXN real en sandbox y confirme que se genera `bank_account`.
2. Compruebe que se muestran convenio, CLABE, referencia y PDF.
3. Verifique que el webhook llega autenticado y que una notificación duplicada no altera
   una transacción ya confirmada.
4. Pruebe `completed`, `failed` y `cancelled`; confirme que los montos y la moneda
   coinciden.
5. Solicite a Openpay la habilitación de producción y cambie únicamente las credenciales
   dentro de Odoo.

Use **Modo de prueba** únicamente con Merchant ID y llave privada de sandbox. **Activado**
consulta producción y requiere las credenciales de producción, emitidas tras la aprobación de
Openpay; usar las de sandbox allí genera el error `401 / 1002`.

En la pestaña **Configuración** del proveedor se muestran también los enlaces oficiales:

* Pruebas: API `https://sandbox-api.openpay.mx` y panel `https://sandbox-dashboard.openpay.mx`.
* Producción: API `https://api.openpay.mx` y panel `https://dashboard.openpay.mx`.

## Límites de la entrega

La sintaxis, XML y estructura se validaron localmente sin credenciales ni una instancia
de Odoo 19. La instalación funcional y las llamadas sandbox/producción deben validarse
en su Odoo.sh o servidor de desarrollo antes de publicar el proveedor.

Fuentes: documentación oficial de [cargos bancarios](https://documents.openpay.mx/docs/bank-charge),
[API](https://documents.openpay.mx/docs/api/index.html) y [webhooks](https://documents.openpay.mx/docs/webhooks).
