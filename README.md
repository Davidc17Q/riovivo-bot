# Asistente de WhatsApp con IA (multi-tenant)

Bot de WhatsApp para negocios de servicios. Primer cliente: **Río Vivo Spa** (asistente "Vivi").
Responde con datos reales del catálogo, consulta la agenda, crea solicitudes de reserva
**pendientes** y avisa a una persona del equipo, que es quien confirma.

- **Sin inventar:** precios, horarios, políticas y disponibilidad solo salen de herramientas (tool use de Claude).
- **Sin sobre-reservar:** un solo profesional; las citas no se solapan y las habitaciones no se duplican.
- **El bot nunca confirma:** toda reserva nace `PENDIENTE`; solo una persona la pasa a `CONFIRMADA`.
- **Multi-tenant:** cada negocio es una carpeta en `src/tenants/<id>/`. Clonar el bot = copiar la carpeta y cambiar datos.

## Requisitos

- Node.js 20 o superior.
- Una llave de API de Anthropic.
- Una app de Meta con el producto WhatsApp (para producción; en local se puede probar sin ella).

## Instalación

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npx prisma migrate deploy
```

```bash
npm run seed
```

```bash
npm run dev
```

El servidor queda en `http://localhost:3000`. Al arrancar también sincroniza los tenants, así que el seed solo es obligatorio la primera vez si quieres ver los datos antes de iniciar.

| Script | Qué hace |
|---|---|
| `npm run dev` | Desarrollo con recarga (`tsx watch`) |
| `npm run build` | Genera el cliente de Prisma y compila a `dist/` |
| `npm start` | Aplica migraciones y arranca `dist/index.js` (producción) |
| `npm run seed` | Carga los tenants de `src/tenants/` en la base de datos |
| `npm run prisma:migrate` | Crea una migración nueva tras cambiar `schema.prisma` |
| `npm run prisma:studio` | Abre Prisma Studio para ver y editar la base de datos |

## Probar sin WhatsApp: `POST /test/chat`

Solo necesitas `ANTHROPIC_API_KEY` en el `.env`. Usa el mismo camino que el webhook real (memoria, agente y herramientas), pero devuelve la respuesta en el JSON en vez de enviarla.

```bash
curl -s -X POST http://localhost:3000/test/chat -H "Content-Type: application/json" -d '{"telefono":"573001112233","mensaje":"Hola, ¿cuánto vale el plan Áurea?"}'
```

Repite la llamada con el mismo `telefono` para continuar la conversación (por ejemplo: "somos 2, para este sábado a las 10", luego "sí, resérvame, soy Ana Pérez"). La respuesta incluye `herramientas`, la lista de tools que usó el modelo en ese turno.

Para simular al dueño confirmando una solicitud, envía desde el número de `OWNER_WHATSAPP`:

```bash
curl -s -X POST http://localhost:3000/test/chat -H "Content-Type: application/json" -d '{"telefono":"573113470053","mensaje":"CONFIRMAR 1"}'
```

`/test/chat` está activo fuera de producción. Con `NODE_ENV=production` solo se habilita si pones `ENABLE_TEST_CHAT=true` (no lo dejes abierto en un servidor público).

## Cómo funciona

```
WhatsApp → POST /webhook → resuelve tenant por phone_number_id → cola por cliente
        → guarda mensaje → agente (Claude + herramientas) → guarda respuesta → Graph API
```

### Herramientas del agente

| Herramienta | Qué hace |
|---|---|
| `consultar_catalogo` | Lee `catalogo.json` y `menu.json` del tenant (experiencias, hospedaje, habitaciones, menú, políticas, información general) |
| `consultar_disponibilidad` | Revisa agenda y habitaciones; devuelve horas libres, cotización (total y depósito) o fechas alternativas |
| `crear_solicitud_reserva` | Revalida el cupo y crea la reserva `PENDIENTE`; avisa al dueño |
| `notificar_humano` | Registra el aviso y lo envía al WhatsApp del dueño |
| `programar_recordatorio` | Crea un recordatorio en la base de datos (solo para el teléfono del chat) |
| `guardar_datos_cliente` | Guarda nombre, experiencia de interés y fechas para futuras conversaciones |

Los argumentos de cada herramienta se validan con zod antes de ejecutarse. El teléfono del cliente siempre se toma del canal, no de lo que diga el modelo.

### Flujo de reserva

1. El cliente consulta; el bot responde con el catálogo y verifica disponibilidad.
2. El cliente acepta → se crea la solicitud `PENDIENTE` (el cupo queda apartado para no ofrecerlo dos veces).
3. Al dueño le llega un WhatsApp con el resumen y el número de solicitud.
4. Cuando recibe el depósito, el dueño responde al bot **`CONFIRMAR 12`** (o `RECHAZAR 12` / `CANCELAR 12`).
5. Al confirmar, el cliente recibe el aviso y se programa el recordatorio (24 h antes por defecto).

También se puede gestionar por HTTP si defines `ADMIN_TOKEN`:

```bash
curl -s http://localhost:3000/admin/reservas?estado=PENDIENTE -H "x-admin-token: TU_TOKEN"
```

```bash
curl -s -X POST http://localhost:3000/admin/reservas/12/estado -H "x-admin-token: TU_TOKEN" -H "Content-Type: application/json" -d '{"estado":"CONFIRMADA"}'
```

### Reglas de agenda (`src/tenants/riovivo/config.json`)

Estos valores son **supuestos iniciales que hay que validar con el spa**; se cambian sin tocar código:

- `agenda.experiencias.<id>.minutos_profesional`: cuánto tiempo ocupa al profesional cada experiencia, y si es `por_persona`. Hoy: Solara y Armonía 60 min, Vitalia y Alma 90, Áurea 120 (por persona); Namasté 90, Oasis 120, Serena 120, Romántico 150 (por pareja).
- `agenda.apertura` / `cierre`: 10:00 a 17:00. `paso_min`: las horas se ofrecen cada 30 min.
- `agenda.anticipacion_min`: no se ofrecen citas a menos de 60 min de la hora actual.
- `agenda.checkin` / `checkout`: 15:00 y 12:00 para hospedaje.
- Habitaciones: salen de `catalogo.json` (hoy 1 sencilla y 1 grupal).
- En planes con noche, el tratamiento se aparta el día de llegada o el siguiente; la hora exacta la coordina el equipo.
- El descuento de entre semana del hospedaje **no** se aplica en la cotización: el bot avisa que lo confirma el equipo.
- Un grupo que no cabe en una jornada se pasa al equipo.

### Memoria

Cada conversación (tenant + teléfono) guarda sus mensajes, los datos del cliente y un resumen. Al modelo se le envían los mensajes recientes más el resumen. Cuando hay más de 30 mensajes sin resumir, los más antiguos se condensan (quedan los 12 últimos completos), así el costo por mensaje no crece con el tiempo.

### Recordatorios y ventana de 24 h

Un scheduler revisa cada minuto la tabla `Recordatorio` y envía los vencidos (3 intentos).

WhatsApp solo permite texto libre si el cliente escribió en las últimas 24 h. Fuera de esa ventana el mensaje debe ser una **plantilla aprobada**. Esto afecta a:

- Los recordatorios (casi siempre caen fuera de la ventana).
- El aviso de confirmación al cliente.
- Las notificaciones al dueño, si él no le ha escrito al bot en las últimas 24 h.

**Pendiente antes de producción (TODO):** crea en WhatsApp Manager dos plantillas de categoría *Utilidad*, cada una con una sola variable `{{1}}` en el cuerpo (por ejemplo: `Río Vivo Spa: {{1}}`), y pon sus nombres en `config.json` → `whatsapp.plantilla_recordatorio` y `whatsapp.plantilla_notificacion`. Sin plantilla configurada, esos mensajes fuera de ventana no se envían y quedan registrados con el error (tablas `Recordatorio` y `Notificacion`). Mientras tanto, un truco simple para el dueño: escribirle "hola" al bot una vez al día mantiene su ventana abierta.

## Configurar WhatsApp en Meta

1. Entra a <https://developers.facebook.com/apps> → **Crear app** → tipo **Negocios**.
2. En la app, agrega el producto **WhatsApp**. En **Configuración de la API** verás un número de prueba, su **Identificador de número de teléfono** y un token temporal (dura 24 h).
3. Para producción, registra el número real del negocio en esa misma pantalla (no puede estar activo en la app de WhatsApp normal al mismo tiempo).
4. **Token permanente:** en <https://business.facebook.com/settings> → Usuarios → **Usuarios del sistema** → crea uno (Administrador), asígnale la app y genera un token con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
5. **Webhook:** en WhatsApp → Configuración → Webhook, pon la URL `https://TU-DOMINIO/webhook` y el mismo texto que definiste en `WHATSAPP_VERIFY_TOKEN`. Luego suscríbete al campo **messages**.
6. Publica la app (modo *Activo*) para atender números que no estén en la lista de prueba.

### Variables de entorno

| Variable | De dónde sale |
|---|---|
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com> → API Keys |
| `ANTHROPIC_MODEL` | Opcional. Por defecto `claude-haiku-5-5` |
| `ANTHROPIC_EFFORT` | Opcional (`low`, `medium`, `high`). Vacío = valor por defecto del modelo |
| `WHATSAPP_TOKEN` | Token del usuario del sistema (paso 4) |
| `WHATSAPP_PHONE_NUMBER_ID` | Identificador de número de teléfono (paso 2). No es el número |
| `WHATSAPP_VERIFY_TOKEN` | Lo inventas tú; debe coincidir con el del webhook (paso 5) |
| `WHATSAPP_APP_SECRET` | Configuración de la app → Básica → **Clave secreta**. Valida que el webhook viene de Meta. Ponlo siempre en producción |
| `OWNER_WHATSAPP` | Número que recibe los avisos, con código de país y sin `+` |
| `DATABASE_URL` | `file:./dev.db` en local (la ruta es relativa a `prisma/`) |
| `ADMIN_TOKEN` | Lo inventas tú; habilita `/admin/*` |
| `PORT`, `TIMEZONE`, `LOG_LEVEL` | Servidor |

## Probar el webhook en local con un túnel

Con el servidor corriendo, abre un túnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

o

```bash
ngrok http 3000
```

Copia la URL `https://...` que te da, agrégale `/webhook` y úsala en el paso 5. Escríbele al número de prueba desde tu WhatsApp (tu número debe estar en la lista de destinatarios de prueba).

## Despliegue

### Railway

1. Sube este proyecto a un repositorio y crea un servicio en Railway desde él. Si queda dentro de otro repo, define **Root Directory** = `riovivo-bot`.
2. Build: `npm run build`. Start: `npm start` (aplica las migraciones al iniciar).
3. **Agrega un volumen** montado en `/data` y usa `DATABASE_URL=file:/data/prod.db`. Sin volumen, SQLite se borra en cada despliegue.
4. Carga las demás variables y `NODE_ENV=production`.
5. Usa el dominio público de Railway como URL del webhook.

### Render

Web Service con Build `npm install && npm run build` y Start `npm start`. Agrega un **Disk** (requiere plan de pago) montado en `/data` y `DATABASE_URL=file:/data/prod.db`. El plan gratuito se duerme y no tiene disco persistente: no sirve para un webhook.

### Pasar a Postgres

En `prisma/schema.prisma` cambia `provider = "sqlite"` por `"postgresql"`, apunta `DATABASE_URL` a la base, borra `prisma/migrations` y ejecuta `npm run prisma:migrate`. El código no cambia.

## Costos mensuales aproximados

Son estimaciones; revisa las tarifas vigentes de cada proveedor.

| Concepto | Estimado |
|---|---|
| Anthropic (`claude-haiku-5-5`: US$0,10 por millón de tokens de entrada y US$0,50 de salida) | Unos US$0,002 por mensaje atendido. 3.000 mensajes al mes ≈ US$5–8 |
| WhatsApp Cloud API | Responder dentro de la ventana de 24 h no tiene costo. Las plantillas de utilidad (recordatorios) se cobran por mensaje, fracciones de centavo de dólar en Colombia |
| Hosting (Railway Hobby o Render Starter + disco) | US$5–8 |
| **Total para un spa pequeño** | **US$10–20 al mes** |

## Agregar otro negocio (tenant)

1. Copia `src/tenants/riovivo/` a `src/tenants/<nuevo-id>/`.
2. Edita `config.json` (cambia `id`, nombre, reglas de agenda y los **nombres** de las variables de entorno de sus credenciales, por ejemplo `"token_env": "WHATSAPP_TOKEN_ACME"`), `catalogo.json`, `menu.json` y `prompt.md`.
3. Define esas variables en el entorno y reinicia. El tenant se registra solo y se resuelve por el `phone_number_id` que recibe el mensaje.

El prompt no lleva precios: siempre salen de `consultar_catalogo`.

## Por qué Fastify

Se eligió Fastify sobre Express porque NFCloud ya corre en Fastify + TypeScript (integrarlo después es más directo), trae pino integrado para los logs y permite capturar el cuerpo crudo del webhook, necesario para validar la firma `X-Hub-Signature-256` de Meta.

## Estructura

```
prisma/schema.prisma        Tenant, Conversacion, Mensaje, Reserva, Recordatorio, Notificacion
src/config                  variables de entorno y logger
src/db                      cliente de Prisma y seed
src/whatsapp                webhook (verificación y recepción), envío por Graph API, /test/chat
src/agent                   loop del agente y registro de herramientas
src/tools                   una herramienta por archivo
src/services                agenda, reservas, memoria, recordatorios, notificaciones, mensajería
src/scheduler               envío de recordatorios cada minuto
src/admin                   endpoints /admin protegidos por token
src/tenants/<id>            config.json, catalogo.json, menu.json, prompt.md
```

## Limitaciones conocidas de la v1

- Solo texto: a audios, imágenes y documentos responde pidiendo que escriban.
- No hay "pausa" del bot cuando una persona toma el chat; el bot sigue respondiendo.
- La cola por cliente vive en memoria: pensado para una sola instancia del servidor.
- El bot no verifica pagos ni comprobantes; eso lo hace el equipo.
