import { env } from "../config/env";
import { logger, ocultarTelefono } from "../config/logger";
import type { Tenant } from "../tenants/loader";
import { partirMensaje } from "../services/texto";

export interface ResultadoEnvio {
  ok: boolean;
  simulado?: boolean;
  error?: string;
}

async function postMensaje(tenant: Tenant, cuerpo: Record<string, unknown>, para: string): Promise<ResultadoEnvio> {
  const { token, phoneNumberId } = tenant.credenciales();

  // Sin credenciales de Meta (desarrollo local): no se envía nada, solo se registra.
  if (!token || !phoneNumberId) {
    logger.info({ tenant: tenant.id, para: ocultarTelefono(para) }, "WhatsApp sin credenciales: envío simulado");
    return { ok: true, simulado: true };
  }

  try {
    const respuesta = await fetch(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: para, ...cuerpo }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!respuesta.ok) {
      const detalle = (await respuesta.text()).slice(0, 500);
      logger.error({ tenant: tenant.id, estado: respuesta.status, detalle }, "Graph API rechazó el envío");
      return { ok: false, error: `Graph API ${respuesta.status}: ${detalle}` };
    }
    return { ok: true };
  } catch (error) {
    logger.error({ err: error, tenant: tenant.id }, "Fallo de red al enviar por WhatsApp");
    return { ok: false, error: error instanceof Error ? error.message : "error de red" };
  }
}

/** Envía texto libre (solo válido dentro de la ventana de 24 h del cliente). */
export async function enviarTexto(tenant: Tenant, para: string, texto: string): Promise<ResultadoEnvio> {
  let ultimo: ResultadoEnvio = { ok: true };
  for (const parte of partirMensaje(texto)) {
    ultimo = await postMensaje(tenant, { type: "text", text: { preview_url: false, body: parte } }, para);
    if (!ultimo.ok) return ultimo;
  }
  return ultimo;
}

/**
 * Envía una plantilla aprobada por Meta (obligatoria fuera de la ventana de 24 h).
 * TODO(plantillas): crear y aprobar las plantillas en WhatsApp Manager y poner su
 * nombre en config.json del tenant (plantilla_recordatorio / plantilla_notificacion).
 * Se asume una plantilla con una sola variable {{1}} en el cuerpo.
 */
export async function enviarPlantilla(
  tenant: Tenant,
  para: string,
  nombre: string,
  parametros: string[],
): Promise<ResultadoEnvio> {
  // Los parámetros de plantilla no admiten saltos de línea ni tabulaciones.
  const limpios = parametros.map((p) => p.replace(/\s+/g, " ").trim().slice(0, 1000));
  return postMensaje(
    tenant,
    {
      type: "template",
      template: {
        name: nombre,
        language: { code: tenant.config.whatsapp.idioma_plantilla },
        components: limpios.length
          ? [{ type: "body", parameters: limpios.map((text) => ({ type: "text", text })) }]
          : [],
      },
    },
    para,
  );
}
