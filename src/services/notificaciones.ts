import { logger } from "../config/logger";
import { prisma } from "../db/prisma";
import type { Tenant } from "../tenants/loader";
import { enviarProactivo } from "./mensajeria";

export interface DatosNotificacion {
  motivo: string;
  resumen: string;
  telefonoCliente?: string;
  /** Texto ya armado para WhatsApp; si falta se construye uno genérico. */
  textoWhatsapp?: string;
}

/** Registra la notificación y la envía al WhatsApp del dueño del negocio. */
export async function notificarHumano(tenant: Tenant, datos: DatosNotificacion): Promise<{ id: number; enviada: boolean }> {
  const notificacion = await prisma.notificacion.create({
    data: {
      tenantId: tenant.id,
      motivo: datos.motivo,
      resumen: datos.resumen,
      telefonoCliente: datos.telefonoCliente ?? null,
    },
  });

  const { owner } = tenant.credenciales();
  if (!owner) {
    await prisma.notificacion.update({ where: { id: notificacion.id }, data: { error: "El tenant no tiene número de dueño" } });
    logger.warn({ tenant: tenant.id }, "Notificación registrada pero el tenant no tiene número de dueño");
    return { id: notificacion.id, enviada: false };
  }

  const texto =
    datos.textoWhatsapp ??
    [
      `🔔 *${tenant.config.nombre}: un cliente necesita atención*`,
      `Motivo: ${datos.motivo}`,
      datos.telefonoCliente ? `Cliente: +${datos.telefonoCliente}` : null,
      "",
      datos.resumen,
    ]
      .filter((linea) => linea !== null)
      .join("\n");

  const envio = await enviarProactivo(tenant, owner, texto, tenant.config.whatsapp.plantilla_notificacion);
  await prisma.notificacion.update({
    where: { id: notificacion.id },
    data: { enviada: envio.ok, error: envio.ok ? null : (envio.error ?? "error desconocido") },
  });
  return { id: notificacion.id, enviada: envio.ok };
}
