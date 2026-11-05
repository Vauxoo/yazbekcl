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
  descripción y referencia de pedido.
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

## Validación previa a producción

1. Pruebe una orden MXN real en sandbox y confirme que se genera `bank_account`.
2. Compruebe que se muestran convenio, CLABE, referencia y PDF.
3. Verifique que el webhook llega autenticado y que una notificación duplicada no altera
   una transacción ya confirmada.
4. Pruebe `completed`, `failed` y `cancelled`; confirme que los montos y la moneda
   coinciden.
5. Solicite a Openpay la habilitación de producción y cambie únicamente las credenciales
   dentro de Odoo.

## Límites de la entrega

La sintaxis, XML y estructura se validaron localmente sin credenciales ni una instancia
de Odoo 19. La instalación funcional y las llamadas sandbox/producción deben validarse
en su Odoo.sh o servidor de desarrollo antes de publicar el proveedor.

Fuentes: documentación oficial de [cargos bancarios](https://documents.openpay.mx/docs/bank-charge),
[API](https://documents.openpay.mx/docs/api/index.html) y [webhooks](https://documents.openpay.mx/docs/webhooks).
