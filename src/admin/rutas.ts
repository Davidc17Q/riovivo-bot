import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { cambiarEstadoReserva } from "../services/reservas";
import { textoLocal } from "../services/tiempo";
import { obtenerTenant } from "../tenants/loader";

function autorizado(req: FastifyRequest): boolean {
  const recibido = req.headers["x-admin-token"];
  if (!env.ADMIN_TOKEN || typeof recibido !== "string") return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(env.ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Endpoints mínimos para que el equipo gestione solicitudes sin panel.
 * Requieren el encabezado x-admin-token; sin ADMIN_TOKEN configurado no se registran.
 */
export function registrarAdmin(app: FastifyInstance): void {
  if (!env.ADMIN_TOKEN) return;

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!autorizado(req)) await reply.code(401).send({ error: "No autorizado" });
  };

  app.get("/admin/reservas", { preHandler: guard }, async (req, reply) => {
    const q = z
      .object({ tenant: z.string().default("riovivo"), estado: z.string().optional() })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: z.prettifyError(q.error) });
    const tenant = obtenerTenant(q.data.tenant);
    if (!tenant) return reply.code(404).send({ error: "Tenant no existe" });

    const reservas = await prisma.reserva.findMany({
      where: { tenantId: tenant.id, ...(q.data.estado ? { estado: q.data.estado.toUpperCase() } : {}) },
      orderBy: { inicio: "asc" },
      take: 200,
    });
    const zona = tenant.config.zona_horaria;
    return reservas.map((r) => ({
      id: r.id,
      estado: r.estado,
      nombre: r.nombre,
      telefono: r.telefono,
      experiencia: r.experienciaNombre,
      personas: r.personas,
      inicio: textoLocal(r.inicio, zona),
      fin: textoLocal(r.fin, zona),
      cita_profesional: r.profInicio ? textoLocal(r.profInicio, zona) : null,
      habitacion: r.habitacionId,
      total_estimado: r.totalEstimado,
      deposito_estimado: r.depositoEstimado,
      notas: r.notas,
    }));
  });

  app.post("/admin/reservas/:id/estado", { preHandler: guard }, async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    const cuerpo = z
      .object({ tenant: z.string().default("riovivo"), estado: z.enum(["CONFIRMADA", "RECHAZADA", "CANCELADA"]) })
      .safeParse(req.body);
    if (!params.success || !cuerpo.success) return reply.code(400).send({ error: "Parámetros inválidos" });
    const tenant = obtenerTenant(cuerpo.data.tenant);
    if (!tenant) return reply.code(404).send({ error: "Tenant no existe" });

    const resultado = await cambiarEstadoReserva(tenant, params.data.id, cuerpo.data.estado);
    return reply.code(resultado.ok ? 200 : 409).send(resultado);
  });
}
