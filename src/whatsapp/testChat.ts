import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { procesarMensajeEntrante } from "../services/entrada";
import { obtenerTenant } from "../tenants/loader";

const cuerpoSchema = z.object({
  telefono: z.string().min(7).default("573000000000"),
  mensaje: z.string().min(1).max(4000),
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

    const resultado = await procesarMensajeEntrante({
      tenant,
      telefono: cuerpo.data.telefono,
      texto: cuerpo.data.mensaje,
      nombrePerfil: cuerpo.data.nombre,
      enviarPorWhatsapp: false,
    });
    return reply.send(resultado);
  });
}
