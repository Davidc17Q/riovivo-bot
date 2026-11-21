import "dotenv/config";
import path from "node:path";
import { z } from "zod";

// Las variables vacías del .env ("CLAVE=") se tratan como ausentes.
const crudo: Record<string, string> = {};
for (const [clave, valor] of Object.entries(process.env)) {
  if (valor !== undefined && valor.trim() !== "") crudo[clave] = valor.trim();
}

const esquema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  TIMEZONE: z.string().default("America/Bogota"),
  DATABASE_URL: z.string().default("file:./dev.db"),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),

  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  GRAPH_API_VERSION: z.string().default("v21.0"),

  ADMIN_TOKEN: z.string().optional(),
  ENABLE_TEST_CHAT: z.enum(["true", "false"]).optional(),
  TENANTS_DIR: z.string().optional(),
});

const resultado = esquema.safeParse(crudo);
if (!resultado.success) {
  // No se imprime el valor de ninguna variable, solo cuál falla.
  const detalle = resultado.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Variables de entorno inválidas: ${detalle}`);
}

const datos = resultado.data;

export const env = {
  ...datos,
  esProduccion: datos.NODE_ENV === "production",
  testChatHabilitado: datos.ENABLE_TEST_CHAT ? datos.ENABLE_TEST_CHAT === "true" : datos.NODE_ENV !== "production",
  // Los datos de cada negocio viven en archivos; se leen desde la raíz del proyecto
  // (así funciona igual con `tsx` y con el build en dist/).
  tenantsDir: datos.TENANTS_DIR ? path.resolve(datos.TENANTS_DIR) : path.resolve(process.cwd(), "src", "tenants"),
};

/**
 * Lee una variable por nombre. Las credenciales de cada tenant se referencian
 * por nombre de variable en su config.json, nunca por valor.
 */
export function leerEnv(nombre: string | undefined | null): string | undefined {
  if (!nombre) return undefined;
  return crudo[nombre];
}
