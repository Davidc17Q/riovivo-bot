import type Anthropic from "@anthropic-ai/sdk";
import type { Conversacion } from "@prisma/client";
import { logger } from "../config/logger";
import { prisma } from "../db/prisma";
import type { Tenant } from "../tenants/loader";

// Control de tokens: cuando hay más de UMBRAL mensajes sin resumir, los más
// antiguos se condensan en Conversacion.resumen y dejan de enviarse completos.
const UMBRAL_RESUMEN = 30;
const MENSAJES_RECIENTES = 12;

export async function obtenerOCrearConversacion(tenant: Tenant, telefono: string, nombrePerfil?: string): Promise<Conversacion> {
  return prisma.conversacion.upsert({
    where: { tenantId_telefono: { tenantId: tenant.id, telefono } },
    create: { tenantId: tenant.id, telefono, nombreCliente: nombrePerfil ?? null },
    update: {},
  });
}

/** Guarda el mensaje del cliente. Devuelve false si Meta lo reenvió y ya estaba procesado. */
export async function guardarMensajeEntrante(conversacionId: number, texto: string, waMessageId?: string): Promise<boolean> {
  if (waMessageId) {
    const existente = await prisma.mensaje.findUnique({ where: { waMessageId }, select: { id: true } });
    if (existente) return false;
  }
  await prisma.$transaction([
    prisma.mensaje.create({ data: { conversacionId, rol: "user", contenido: texto, waMessageId: waMessageId ?? null } }),
    prisma.conversacion.update({ where: { id: conversacionId }, data: { ultimoEntranteEn: new Date() } }),
  ]);
  return true;
}

export async function guardarRespuesta(conversacionId: number, texto: string): Promise<void> {
  await prisma.mensaje.create({ data: { conversacionId, rol: "assistant", contenido: texto } });
}

/** Historial reciente (sin resumir) en el formato de la API de Anthropic. */
export async function construirHistorial(conversacionId: number): Promise<Anthropic.MessageParam[]> {
  const mensajes = await prisma.mensaje.findMany({
    where: { conversacionId, resumido: false },
    orderBy: { id: "asc" },
  });
  const historial: Anthropic.MessageParam[] = mensajes.map((m) => ({
    role: m.rol === "assistant" ? "assistant" : "user",
    content: m.contenido,
  }));
  // La API exige que el primer mensaje sea del usuario.
  while (historial.length > 0 && historial[0]?.role !== "user") historial.shift();
  return historial;
}

export interface DatosCliente {
  experiencia_interes?: string;
  fechas_mencionadas?: string;
  numero_personas?: number;
  notas?: string;
}

export function leerDatosCliente(conversacion: Conversacion): DatosCliente {
  try {
    const datos: unknown = JSON.parse(conversacion.datosCliente);
    return datos && typeof datos === "object" ? (datos as DatosCliente) : {};
  } catch {
    return {};
  }
}

export async function guardarDatosCliente(
  conversacionId: number,
  cambios: DatosCliente & { nombre?: string },
): Promise<void> {
  const conversacion = await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacionId } });
  const { nombre, ...resto } = cambios;
  const datos = { ...leerDatosCliente(conversacion), ...resto };
  await prisma.conversacion.update({
    where: { id: conversacionId },
    data: { datosCliente: JSON.stringify(datos), ...(nombre ? { nombreCliente: nombre } : {}) },
  });
}

/**
 * Si el historial creció demasiado, resume los mensajes viejos con el modelo.
 * Se llama después de responder; un fallo aquí no afecta al cliente.
 */
export async function resumirSiHaceFalta(
  conversacionId: number,
  resumir: (resumenPrevio: string | null, transcripcion: string) => Promise<string>,
): Promise<void> {
  const pendientes = await prisma.mensaje.findMany({
    where: { conversacionId, resumido: false },
    orderBy: { id: "asc" },
    select: { id: true, rol: true, contenido: true },
  });
  if (pendientes.length <= UMBRAL_RESUMEN) return;

  const viejos = pendientes.slice(0, pendientes.length - MENSAJES_RECIENTES);
  const transcripcion = viejos.map((m) => `${m.rol === "assistant" ? "Asistente" : "Cliente"}: ${m.contenido}`).join("\n");
  const conversacion = await prisma.conversacion.findUniqueOrThrow({ where: { id: conversacionId } });

  const resumen = await resumir(conversacion.resumen, transcripcion);
  if (!resumen.trim()) return;

  await prisma.$transaction([
    prisma.conversacion.update({ where: { id: conversacionId }, data: { resumen: resumen.trim() } }),
    prisma.mensaje.updateMany({ where: { id: { in: viejos.map((m) => m.id) } }, data: { resumido: true } }),
  ]);
  logger.debug({ conversacion: conversacionId, resumidos: viejos.length }, "Historial resumido");
}
