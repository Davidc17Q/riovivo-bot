import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  // Por si algún objeto con credenciales llega a un log.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-admin-token']",
      "req.headers['x-hub-signature-256']",
      "*.token",
      "*.apiKey",
      "*.authorization",
    ],
    censor: "[oculto]",
  },
});

export type Logger = typeof logger;

/** Muestra solo los últimos 4 dígitos de un teléfono en los logs. */
export function ocultarTelefono(telefono: string): string {
  return telefono.length <= 4 ? "****" : `***${telefono.slice(-4)}`;
}
