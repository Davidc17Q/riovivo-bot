import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PREFIJO_NOTA_DE_VOZ, procesarMensajeEntrante } from "../services/entrada";
import { transcribirAudio } from "../services/transcripcion";
import { obtenerTenant } from "../tenants/loader";

const cuerpoSchema = z.object({
  telefono: z.string().min(7).default("573000000000"),
  mensaje: z.string().min(1).max(4000).optional(),
  // Nota de voz de prueba: archivo de audio en base64 (se transcribe con STT_API_KEY).
  audio_base64: z.string().min(1).optional(),
  audio_mime: z.string().default("audio/ogg"),
  tenant: z.string().default("riovivo"),
  nombre: z.string().optional(),
});

/**
 * Modo de prueba local: simula un mensaje entrante sin pasar por WhatsApp.
 * Usa el mismo camino que el webhook (memoria, agente, herramientas), pero la
 * respuesta se devuelve en el JSON en vez de enviarse al cliente.
 */
export function registrarTestChat(app: FastifyInstance): void {
  app.post("/test/chat", async (req, reply) => {
    const cuerpo = cuerpoSchema.safeParse(req.body);
    if (!cuerpo.success) return reply.code(400).send({ error: z.prettifyError(cuerpo.error) });

    const tenant = obtenerTenant(cuerpo.data.tenant);
    if (!tenant) return reply.code(404).send({ error: `Tenant "${cuerpo.data.tenant}" no existe` });

    let texto = cuerpo.data.mensaje;
    let transcripcion: string | undefined;
    if (cuerpo.data.audio_base64) {
      try {
        transcripcion = await transcribirAudio(Buffer.from(cuerpo.data.audio_base64, "base64"), cuerpo.data.audio_mime);
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : "Fallo la transcripción" });
      }
      texto = `${PREFIJO_NOTA_DE_VOZ} ${transcripcion}`;
    }
    if (!texto) return reply.code(400).send({ error: "Envía `mensaje` o `audio_base64`" });

    const resultado = await procesarMensajeEntrante({
      tenant,
      telefono: cuerpo.data.telefono,
      texto,
      nombrePerfil: cuerpo.data.nombre,
      enviarPorWhatsapp: false,
    });
    return reply.send(transcripcion === undefined ? resultado : { transcripcion, ...resultado });
  });
}
