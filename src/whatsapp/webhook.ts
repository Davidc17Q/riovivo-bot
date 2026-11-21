import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { MENSAJE_SOLO_TEXTO, procesarMensajeEntrante } from "../services/entrada";
import { tenantPorPhoneNumberId } from "../tenants/loader";
import { enviarTexto } from "./cliente";

// Solo se valida lo que se usa del payload de Meta; el resto se ignora.
const payloadSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z
                .object({
                  metadata: z.object({ phone_number_id: z.string() }).optional(),
                  contacts: z.array(z.object({ profile: z.object({ name: z.string().optional() }).optional() })).optional(),
                  messages: z
                    .array(
                      // Campos laxos: un mensaje mal formado o de tipo inesperado no debe
                      // invalidar todo el payload. Se filtra más abajo en procesarPayload.
                      z.object({
                        from: z.string().optional(),
                        id: z.string().optional(),
                        type: z.string().optional(),
                        text: z.object({ body: z.string() }).optional(),
                      }),
                    )
                    .optional(),
                })
                .optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

type Payload = z.infer<typeof payloadSchema>;

function firmaValida(cuerpo: Buffer | undefined, firma: string | undefined): boolean {
  if (!env.WHATSAPP_APP_SECRET) return true; // sin secreto configurado no se valida (solo desarrollo)
  if (!cuerpo || !firma) return false;
  const esperada = `sha256=${crypto.createHmac("sha256", env.WHATSAPP_APP_SECRET).update(cuerpo).digest("hex")}`;
  const a = Buffer.from(esperada);
  const b = Buffer.from(firma);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function procesarPayload(payload: Payload): Promise<void> {
  for (const entrada of payload.entry) {
    for (const cambio of entrada.changes) {
      const valor = cambio.value;
      // Los eventos de estado (entregado, leído) llegan sin `messages`.
      if (!valor?.metadata || !valor.messages?.length) continue;

      const tenant = await tenantPorPhoneNumberId(valor.metadata.phone_number_id);
      if (!tenant) {
        logger.warn({ phoneNumberId: valor.metadata.phone_number_id }, "Webhook de un número sin tenant registrado");
        continue;
      }
      const nombrePerfil = valor.contacts?.[0]?.profile?.name;

      for (const mensaje of valor.messages) {
        // Un mensaje sin remitente, id o tipo no es procesable: se ignora sin tumbar el resto.
        if (!mensaje.from || !mensaje.id || !mensaje.type) {
          logger.warn({ tenant: tenant.id }, "Mensaje de webhook sin from/id/type; se ignora");
          continue;
        }
        if (mensaje.type === "text" && mensaje.text?.body.trim()) {
          // Sin await: cada conversación tiene su propia cola y no bloquea a las demás.
          void procesarMensajeEntrante({
            tenant,
            telefono: mensaje.from,
            texto: mensaje.text.body.trim(),
            waMessageId: mensaje.id,
            nombrePerfil,
            enviarPorWhatsapp: true,
          });
        } else if (["audio", "image", "video", "document", "sticker", "location", "contacts"].includes(mensaje.type)) {
          await enviarTexto(tenant, mensaje.from, MENSAJE_SOLO_TEXTO);
        }
      }
    }
  }
}

export function registrarWebhook(app: FastifyInstance): void {
  // Verificación del webhook (Meta la llama una vez al configurarlo).
  app.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const tokenOk = Boolean(env.WHATSAPP_VERIFY_TOKEN) && q["hub.verify_token"] === env.WHATSAPP_VERIFY_TOKEN;
    if (q["hub.mode"] === "subscribe" && tokenOk) {
      return reply.code(200).type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send("Forbidden");
  });

  // Recepción: se responde 200 de inmediato y se procesa en segundo plano,
  // porque Meta reintenta si el webhook tarda.
  app.post("/webhook", async (req, reply) => {
    const firma = req.headers["x-hub-signature-256"];
    if (!firmaValida(req.rawBody, typeof firma === "string" ? firma : undefined)) {
      return reply.code(401).send("Firma inválida");
    }

    const payload = payloadSchema.safeParse(req.body);
    void reply.code(200).send("EVENT_RECEIVED");

    if (!payload.success) {
      logger.warn({ detalle: z.prettifyError(payload.error) }, "Payload de webhook con forma inesperada");
      return reply;
    }
    setImmediate(() => {
      procesarPayload(payload.data).catch((error: unknown) => logger.error({ err: error }, "Error procesando el webhook"));
    });
    return reply;
  });
}
