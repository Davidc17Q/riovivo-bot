import { logger, ocultarTelefono } from "../config/logger";
import { prisma } from "../db/prisma";
import type { Tenant } from "../tenants/loader";
import { enviarPlantilla, enviarTexto, type ResultadoEnvio } from "../whatsapp/cliente";

const VENTANA_MS = 24 * 60 * 60 * 1000;

/** ¿El destinatario nos escribió en las últimas 24 h? (regla de WhatsApp para texto libre) */
export async function dentroDeVentana(tenant: Tenant, telefono: string): Promise<boolean> {
  const conversacion = await prisma.conversacion.findUnique({
    where: { tenantId_telefono: { tenantId: tenant.id, telefono } },
    select: { ultimoEntranteEn: true },
  });
  if (!conversacion?.ultimoEntranteEn) return false;
  return Date.now() - conversacion.ultimoEntranteEn.getTime() < VENTANA_MS;
}

/**
 * Envía un mensaje iniciado por el negocio respetando la ventana de 24 h:
 * dentro de la ventana va como texto; fuera, como plantilla (si el tenant tiene una).
 */
export async function enviarProactivo(
  tenant: Tenant,
  telefono: string,
  texto: string,
  plantilla: string | null | undefined,
): Promise<ResultadoEnvio> {
  if (await dentroDeVentana(tenant, telefono)) return enviarTexto(tenant, telefono, texto);
  if (plantilla) return enviarPlantilla(tenant, telefono, plantilla, [texto]);

  // Sin credenciales el envío es simulado y no hay ventana que respetar.
  const { token, phoneNumberId } = tenant.credenciales();
  if (!token || !phoneNumberId) return enviarTexto(tenant, telefono, texto);

  logger.warn(
    { tenant: tenant.id, para: ocultarTelefono(telefono) },
    "Mensaje fuera de la ventana de 24 h y sin plantilla configurada: no se envía",
  );
  return { ok: false, error: "Fuera de la ventana de 24 h y el tenant no tiene plantilla aprobada configurada" };
}
