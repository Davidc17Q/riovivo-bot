import { env } from "../config/env";
import { logger } from "../config/logger";
import type { Tenant } from "../tenants/loader";

// WhatsApp limita los audios a 16 MB; Whisper acepta hasta 25 MB.
const MAX_BYTES = 16 * 1024 * 1024;

export interface AudioEntrante {
  mediaId: string;
  mimeType?: string;
}

function extensionPara(mime: string): string {
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("amr")) return "amr";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  return "ogg";
}

/** Descarga un archivo de WhatsApp: primero se pide su URL temporal y luego el binario (ambos con el token). */
async function descargarMedia(tenant: Tenant, mediaId: string): Promise<{ datos: Buffer; mime: string }> {
  const { token } = tenant.credenciales();
  if (!token) throw new Error("WhatsApp sin token: no se puede descargar el audio");

  const meta = await fetch(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!meta.ok) throw new Error(`Graph API ${meta.status} al pedir el audio`);
  const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!info.url) throw new Error("Graph API no devolvió la URL del audio");
  if (info.file_size && info.file_size > MAX_BYTES) throw new Error(`Audio demasiado grande (${info.file_size} bytes)`);

  const archivo = await fetch(info.url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!archivo.ok) throw new Error(`Descarga del audio falló (${archivo.status})`);
  const datos = Buffer.from(await archivo.arrayBuffer());
  if (datos.length > MAX_BYTES) throw new Error(`Audio demasiado grande (${datos.length} bytes)`);
  return { datos, mime: info.mime_type ?? "audio/ogg" };
}

/** Convierte audio a texto con una API compatible con Whisper (Groq u OpenAI). */
export async function transcribirAudio(datos: Buffer, mime: string): Promise<string> {
  if (!env.STT_API_KEY) throw new Error("STT_API_KEY no configurada");
  const tipo = mime.split(";")[0]?.trim() || "audio/ogg";

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(datos)], { type: tipo }), `nota.${extensionPara(tipo)}`);
  form.append("model", env.STT_MODEL);
  form.append("language", "es");
  form.append("response_format", "json");

  const respuesta = await fetch(env.STT_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STT_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!respuesta.ok) {
    const detalle = (await respuesta.text()).slice(0, 300);
    throw new Error(`Voz a texto ${respuesta.status}: ${detalle}`);
  }
  const cuerpo = (await respuesta.json()) as { text?: string };
  return (cuerpo.text ?? "").trim();
}

/** Descarga y transcribe una nota de voz. Devuelve null si no se pudo o si quedó vacía. */
export async function transcribirNotaDeVoz(tenant: Tenant, audio: AudioEntrante): Promise<string | null> {
  try {
    const { datos, mime } = await descargarMedia(tenant, audio.mediaId);
    const texto = await transcribirAudio(datos, audio.mimeType ?? mime);
    return texto || null;
  } catch (error) {
    logger.error({ err: error, tenant: tenant.id }, "No se pudo transcribir la nota de voz");
    return null;
  }
}
