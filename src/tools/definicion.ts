import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Logger } from "../config/logger";
import type { Tenant } from "../tenants/loader";

/** Lo que cada herramienta sabe del turno actual. El teléfono viene del canal, no del modelo. */
export interface ContextoTool {
  tenant: Tenant;
  telefono: string;
  conversacionId: number;
  log: Logger;
}

export interface ResultadoTool {
  contenido: string;
  esError: boolean;
}

export interface Herramienta {
  nombre: string;
  definicion: Anthropic.Tool;
  ejecutar(ctx: ContextoTool, entrada: unknown): Promise<ResultadoTool>;
}

/**
 * Define una herramienta con un único esquema zod: de ahí sale el JSON Schema
 * que ve el modelo y la validación de los argumentos antes de ejecutar.
 */
export function definirHerramienta<S extends z.ZodObject>(opciones: {
  nombre: string;
  descripcion: string;
  esquema: S;
  ejecutar(ctx: ContextoTool, entrada: z.infer<S>): Promise<unknown>;
}): Herramienta {
  const { $schema: _omitido, ...jsonSchema } = z.toJSONSchema(opciones.esquema) as Record<string, unknown>;

  return {
    nombre: opciones.nombre,
    definicion: {
      name: opciones.nombre,
      description: opciones.descripcion,
      input_schema: jsonSchema as Anthropic.Tool.InputSchema,
    },
    async ejecutar(ctx, entrada) {
      const validado = opciones.esquema.safeParse(entrada);
      if (!validado.success) {
        // El modelo recibe el detalle para corregir los argumentos y reintentar.
        return {
          esError: true,
          contenido: JSON.stringify({ error: "argumentos_invalidos", detalle: z.prettifyError(validado.error) }),
        };
      }
      try {
        const salida = await opciones.ejecutar(ctx, validado.data);
        return { esError: false, contenido: JSON.stringify(salida) };
      } catch (error) {
        ctx.log.error({ err: error, herramienta: opciones.nombre }, "Falló una herramienta");
        return {
          esError: true,
          contenido: JSON.stringify({
            error: "fallo_interno",
            detalle: "La herramienta falló. No inventes el dato: dile al cliente que lo confirmas con el equipo.",
          }),
        };
      }
    },
  };
}
