import Anthropic from "@anthropic-ai/sdk";
import { ejecutarAgente, resumirConversacion } from "../agent/agente";
import { logger, ocultarTelefono } from "../config/logger";
import type { Tenant } from "../tenants/loader";
import { enviarTexto } from "../whatsapp/cliente";
import {
  construirHistorial,
  guardarMensajeEntrante,
  guardarRespuesta,
  obtenerOCrearConversacion,
  resumirSiHaceFalta,
} from "./memoria";
import { cambiarEstadoReserva } from "./reservas";
import { normalizarTelefono } from "./texto";

export const MENSAJE_FALLBACK = "¡Hola! Dame un momentico y ya te ayudo 🙏";
export const MENSAJE_SOLO_TEXTO =
  "¡Hola! Por ahora solo puedo leer mensajes de texto 🙈 ¿Me cuentas por escrito en qué te puedo ayudar?";

export interface MensajeEntrante {
  tenant: Tenant;
  telefono: string;
  texto: string;
  waMessageId?: string;
  nombrePerfil?: string;
  /** false en /test/chat: la respuesta se devuelve pero no se manda por WhatsApp. */
  enviarPorWhatsapp: boolean;
}

export interface ResultadoEntrada {
  respuesta: string | null;
  herramientas: string[];
  duplicado?: boolean;
  error?: boolean;
}

// Cola por conversación: los mensajes de un mismo cliente se procesan de a uno
// para que el historial no se mezcle si escribe varias veces seguidas.
const colas = new Map<string, Promise<unknown>>();

function enCola<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const anterior = colas.get(clave) ?? Promise.resolve();
  const actual = anterior.catch(() => undefined).then(tarea);
  colas.set(clave, actual);
  void actual
    .catch(() => undefined)
    .finally(() => {
      if (colas.get(clave) === actual) colas.delete(clave);
    });
  return actual;
}

/** El dueño gestiona solicitudes respondiendo "CONFIRMAR 12", "RECHAZAR 12" o "CANCELAR 12". */
function comandoDelDueno(texto: string): { estado: string; id: number } | null {
  const m = /^\s*(confirmar|rechazar|cancelar)\s+#?(\d+)\s*$/i.exec(texto);
  if (!m || !m[1] || !m[2]) return null;
  const estados: Record<string, string> = { confirmar: "CONFIRMADA", rechazar: "RECHAZADA", cancelar: "CANCELADA" };
  const estado = estados[m[1].toLowerCase()];
  return estado ? { estado, id: Number(m[2]) } : null;
}

function describirError(error: unknown): Record<string, unknown> {
  if (error instanceof Anthropic.AuthenticationError) return { tipo: "anthropic_autenticacion", estado: error.status };
  if (error instanceof Anthropic.RateLimitError) return { tipo: "anthropic_limite_de_uso", estado: error.status };
  if (error instanceof Anthropic.APIConnectionError) return { tipo: "anthropic_conexion" };
  if (error instanceof Anthropic.APIError) return { tipo: "anthropic_api", estado: error.status, mensaje: error.message };
  return { tipo: "interno", err: error };
}

async function procesar(m: MensajeEntrante): Promise<ResultadoEntrada> {
  const { tenant } = m;
  const telefono = normalizarTelefono(m.telefono, tenant.config.codigo_pais);
  const log = logger.child({ tenant: tenant.id, cliente: ocultarTelefono(telefono) });

  const responder = async (texto: string): Promise<void> => {
    if (m.enviarPorWhatsapp) await enviarTexto(tenant, telefono, texto);
  };

  try {
    const conversacion = await obtenerOCrearConversacion(tenant, telefono, m.nombrePerfil);
    const nuevo = await guardarMensajeEntrante(conversacion.id, m.texto, m.waMessageId);
    if (!nuevo) return { respuesta: null, herramientas: [], duplicado: true };

    // Comandos del dueño: no pasan por el modelo.
    const comando = telefono === tenant.credenciales().owner ? comandoDelDueno(m.texto) : null;
    if (comando) {
      const resultado = await cambiarEstadoReserva(tenant, comando.id, comando.estado);
      await guardarRespuesta(conversacion.id, resultado.mensaje);
      await responder(resultado.mensaje);
      return { respuesta: resultado.mensaje, herramientas: [] };
    }

    const historial = await construirHistorial(conversacion.id);
    const { texto, herramientas } = await ejecutarAgente({ tenant, conversacion, historial, log });

    await guardarRespuesta(conversacion.id, texto);
    await responder(texto);
    log.info({ herramientas }, "Mensaje atendido");

    // Mantenimiento de memoria: fuera del camino de la respuesta.
    void resumirSiHaceFalta(conversacion.id, resumirConversacion).catch((error: unknown) =>
      log.warn(describirError(error), "No se pudo resumir el historial"),
    );

    return { respuesta: texto, herramientas };
  } catch (error) {
    // Nada de esto tumba el servidor: se registra y el cliente recibe un mensaje amable.
    log.error(describirError(error), "No se pudo atender el mensaje");
    try {
      await responder(MENSAJE_FALLBACK);
    } catch (errorEnvio) {
      log.error({ err: errorEnvio }, "Tampoco se pudo enviar el mensaje de respaldo");
    }
    return { respuesta: MENSAJE_FALLBACK, herramientas: [], error: true };
  }
}

export function procesarMensajeEntrante(m: MensajeEntrante): Promise<ResultadoEntrada> {
  const telefono = normalizarTelefono(m.telefono, m.tenant.config.codigo_pais);
  return enCola(`${m.tenant.id}:${telefono}`, () => procesar(m));
}
