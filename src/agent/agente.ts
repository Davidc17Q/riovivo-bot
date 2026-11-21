import Anthropic from "@anthropic-ai/sdk";
import type { Conversacion } from "@prisma/client";
import { env } from "../config/env";
import type { Logger } from "../config/logger";
import { leerDatosCliente } from "../services/memoria";
import { reservasDelCliente } from "../services/reservas";
import { textoHumano, textoLocal } from "../services/tiempo";
import type { Tenant } from "../tenants/loader";
import type { ContextoTool } from "../tools/definicion";
import { buscarHerramienta, definicionesTools } from "./tools";

// Tope de vueltas modelo → herramientas → modelo por cada mensaje del cliente.
const MAX_ITERACIONES = 8;
const MAX_TOKENS = 16000;

let cliente: Anthropic | undefined;
function anthropic(): Anthropic {
  // Toma ANTHROPIC_API_KEY del entorno. Se crea al primer uso para que el
  // servidor arranque aunque la llave aún no esté configurada.
  cliente ??= new Anthropic({ maxRetries: 2, timeout: 60_000 });
  return cliente;
}

export class ErrorAgente extends Error {}

export interface RespuestaAgente {
  texto: string;
  herramientas: string[];
}

/**
 * System prompt en dos bloques: el prompt del tenant (estable, se cachea junto
 * con las herramientas) y el contexto del turno (cambia siempre, va después del
 * punto de caché para no invalidarlo).
 */
async function construirSystem(tenant: Tenant, conversacion: Conversacion): Promise<Anthropic.TextBlockParam[]> {
  const zona = tenant.config.zona_horaria;
  const ahora = new Date();
  const datos = leerDatosCliente(conversacion);
  const reservas = await reservasDelCliente(tenant, conversacion.telefono);

  const lineas = [
    "<contexto_actual>",
    `Fecha y hora actual (${zona}): ${textoHumano(ahora, zona)} [${textoLocal(ahora, zona)}]`,
    `Teléfono del cliente (este chat): ${conversacion.telefono}`,
    `Nombre del cliente: ${conversacion.nombreCliente ?? "aún no lo sabemos"}`,
  ];
  if (Object.keys(datos).length > 0) lineas.push(`Datos guardados del cliente: ${JSON.stringify(datos)}`);
  if (reservas.length > 0) lineas.push("Solicitudes y reservas de este cliente:", ...reservas.map((r) => `- ${r}`));
  if (conversacion.resumen) lineas.push("Resumen de conversaciones anteriores con este cliente:", conversacion.resumen);
  lineas.push("</contexto_actual>");

  return [
    { type: "text", text: tenant.prompt, cache_control: { type: "ephemeral" } },
    { type: "text", text: lineas.join("\n") },
  ];
}

function textoDe(respuesta: Anthropic.Message): string {
  return respuesta.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Ejecuta el agente para un mensaje: llama al modelo y resuelve sus herramientas hasta tener la respuesta. */
export async function ejecutarAgente(parametros: {
  tenant: Tenant;
  conversacion: Conversacion;
  historial: Anthropic.MessageParam[];
  log: Logger;
}): Promise<RespuestaAgente> {
  const { tenant, conversacion, log } = parametros;
  const mensajes = [...parametros.historial];
  const system = await construirSystem(tenant, conversacion);
  const ctx: ContextoTool = { tenant, telefono: conversacion.telefono, conversacionId: conversacion.id, log };
  const usadas: string[] = [];

  for (let vuelta = 0; vuelta < MAX_ITERACIONES; vuelta++) {
    const respuesta = await anthropic().messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: definicionesTools,
      messages: mensajes,
      ...(env.ANTHROPIC_EFFORT ? { output_config: { effort: env.ANTHROPIC_EFFORT } } : {}),
    });

    log.debug(
      {
        vuelta,
        stop: respuesta.stop_reason,
        entrada: respuesta.usage.input_tokens,
        salida: respuesta.usage.output_tokens,
        cache_lectura: respuesta.usage.cache_read_input_tokens,
      },
      "Respuesta del modelo",
    );

    if (respuesta.stop_reason === "refusal" || respuesta.stop_reason === "max_tokens") {
      throw new ErrorAgente(`El modelo se detuvo sin terminar (${respuesta.stop_reason})`);
    }
    if (respuesta.stop_reason === "pause_turn") {
      mensajes.push({ role: "assistant", content: respuesta.content });
      continue;
    }

    const llamadas = respuesta.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (llamadas.length === 0) {
      const texto = textoDe(respuesta);
      if (!texto) throw new ErrorAgente("El modelo respondió sin texto");
      return { texto, herramientas: usadas };
    }

    // El contenido del asistente se devuelve completo (incluye los bloques de razonamiento).
    mensajes.push({ role: "assistant", content: respuesta.content });

    // En orden y no en paralelo: algunas escriben en la base de datos.
    const resultados: Anthropic.ToolResultBlockParam[] = [];
    for (const llamada of llamadas) {
      usadas.push(llamada.name);
      const herramienta = buscarHerramienta(llamada.name);
      const resultado = herramienta
        ? await herramienta.ejecutar(ctx, llamada.input)
        : { esError: true, contenido: JSON.stringify({ error: "herramienta_desconocida" }) };
      resultados.push({
        type: "tool_result",
        tool_use_id: llamada.id,
        content: resultado.contenido,
        ...(resultado.esError ? { is_error: true } : {}),
      });
    }
    mensajes.push({ role: "user", content: resultados });
  }

  throw new ErrorAgente("Se alcanzó el máximo de iteraciones del agente");
}

/** Condensa mensajes antiguos en un resumen breve (memoria de largo plazo). */
export async function resumirConversacion(resumenPrevio: string | null, transcripcion: string): Promise<string> {
  const respuesta = await anthropic().messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 4000,
    system:
      "Mantienes la memoria de un asistente de WhatsApp de un negocio. Escribe un resumen breve (máximo 12 líneas, en español) con lo que conviene recordar del cliente: nombre, qué busca, experiencias de interés, fechas y número de personas mencionados, solicitudes de reserva y su estado, asuntos pendientes y preferencias. Conserva los datos exactos (fechas, ids, cifras). No agregues nada que no esté en el texto.",
    messages: [
      {
        role: "user",
        content: `Resumen previo:\n${resumenPrevio ?? "(ninguno)"}\n\nMensajes nuevos a integrar:\n${transcripcion}\n\nEscribe el resumen actualizado.`,
      },
    ],
  });
  return textoDe(respuesta);
}
