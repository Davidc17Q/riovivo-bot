import { logger } from "../config/logger";
import { prisma } from "../db/prisma";
import { obtenerTenant } from "../tenants/loader";
import { enviarProactivo } from "./mensajeria";

const MAX_INTENTOS = 3;
const MAX_PENDIENTES_POR_TELEFONO = 5;
const MAX_DIAS_ADELANTE = 90;

export class ErrorRecordatorio extends Error {}

export async function programarRecordatorio(datos: {
  tenantId: string;
  telefono: string;
  fechaHora: Date;
  mensaje: string;
  reservaId?: number;
}): Promise<{ id: number }> {
  const ahora = Date.now();
  if (datos.fechaHora.getTime() <= ahora) throw new ErrorRecordatorio("La fecha del recordatorio ya pasó.");
  if (datos.fechaHora.getTime() > ahora + MAX_DIAS_ADELANTE * 86_400_000) {
    throw new ErrorRecordatorio(`Solo se pueden programar recordatorios hasta ${MAX_DIAS_ADELANTE} días adelante.`);
  }

  // Tope por cliente (no aplica a los recordatorios automáticos de una reserva).
  if (datos.reservaId === undefined) {
    const pendientes = await prisma.recordatorio.count({
      where: { tenantId: datos.tenantId, telefono: datos.telefono, estado: "PENDIENTE", reservaId: null },
    });
    if (pendientes >= MAX_PENDIENTES_POR_TELEFONO) {
      throw new ErrorRecordatorio("Este cliente ya tiene el máximo de recordatorios pendientes.");
    }
  }

  const creado = await prisma.recordatorio.create({
    data: {
      tenantId: datos.tenantId,
      telefono: datos.telefono,
      fechaHora: datos.fechaHora,
      mensaje: datos.mensaje,
      reservaId: datos.reservaId ?? null,
    },
  });
  return { id: creado.id };
}

/** Envía los recordatorios vencidos. Lo ejecuta el scheduler cada minuto. */
export async function procesarRecordatoriosPendientes(): Promise<number> {
  const vencidos = await prisma.recordatorio.findMany({
    where: { estado: "PENDIENTE", fechaHora: { lte: new Date() } },
    orderBy: { fechaHora: "asc" },
    take: 20,
  });

  let enviados = 0;
  for (const recordatorio of vencidos) {
    const tenant = obtenerTenant(recordatorio.tenantId);
    if (!tenant) {
      await prisma.recordatorio.update({
        where: { id: recordatorio.id },
        data: { estado: "FALLIDO", error: "Tenant no cargado" },
      });
      continue;
    }

    const envio = await enviarProactivo(
      tenant,
      recordatorio.telefono,
      recordatorio.mensaje,
      tenant.config.whatsapp.plantilla_recordatorio,
    );

    if (envio.ok) {
      enviados++;
      await prisma.recordatorio.update({
        where: { id: recordatorio.id },
        data: { estado: "ENVIADO", enviadoEn: new Date(), error: null },
      });
    } else {
      const intentos = recordatorio.intentos + 1;
      await prisma.recordatorio.update({
        where: { id: recordatorio.id },
        data: { intentos, error: envio.error ?? "error desconocido", estado: intentos >= MAX_INTENTOS ? "FALLIDO" : "PENDIENTE" },
      });
      logger.warn({ recordatorio: recordatorio.id, intentos }, "No se pudo enviar el recordatorio");
    }
  }
  return enviados;
}
