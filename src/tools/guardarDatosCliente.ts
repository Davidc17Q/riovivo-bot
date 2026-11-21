import { z } from "zod";
import { guardarDatosCliente as guardar } from "../services/memoria";
import { definirHerramienta } from "./definicion";

export const guardarDatosCliente = definirHerramienta({
  nombre: "guardar_datos_cliente",
  descripcion:
    "Guarda lo que el cliente va contando (nombre, experiencia que le interesa, fechas que tiene en mente, número de personas, otros detalles) para recordarlo en futuras conversaciones. Envía solo los campos nuevos o que cambiaron.",
  esquema: z.object({
    nombre: z.string().min(2).max(120).optional(),
    experiencia_interes: z.string().max(120).optional(),
    fechas_mencionadas: z.string().max(200).optional().describe("Fechas exactas o aproximadas que mencionó el cliente."),
    numero_personas: z.number().int().min(1).max(50).optional(),
    notas: z.string().max(400).optional().describe("Otros datos útiles: celebración, preferencias, restricciones."),
  }),
  async ejecutar(ctx, entrada) {
    await guardar(ctx.conversacionId, entrada);
    return { guardado: true };
  },
});
