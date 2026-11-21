import { z } from "zod";
import { prisma } from "../db/prisma";
import { evaluarDisponibilidad, evaluacionParaModelo } from "../services/agenda";
import { definirHerramienta } from "./definicion";

export const consultarDisponibilidad = definirHerramienta({
  nombre: "consultar_disponibilidad",
  descripcion:
    "Consulta la agenda real del negocio (varios profesionales en paralelo y habitaciones) y devuelve si hay cupo, las horas libres y la cotización (total y depósito). Si no hay cupo, sugiere fechas alternativas. Llámala siempre antes de decir que una fecha u hora está o no disponible. Las fechas van en hora local del negocio. Para pasadías, pasa solo la fecha para ver las horas libres, o fecha y hora para verificar una hora concreta. Para hospedaje, fecha_inicio es la llegada y fecha_fin la salida.",
  esquema: z.object({
    fecha_inicio: z
      .string()
      .describe("Fecha de la visita o de llegada: 'YYYY-MM-DD', o 'YYYY-MM-DDTHH:mm' para verificar una hora concreta."),
    fecha_fin: z
      .string()
      .optional()
      .describe("Solo hospedaje: fecha de salida 'YYYY-MM-DD'. Si se omite se asume una noche."),
    experiencia: z.string().describe("Id de la experiencia o plan según el catálogo, p. ej. 'aurea', 'namaste', 'hospedaje'."),
    personas: z.number().int().min(1).max(50).describe("Número de personas."),
  }),
  async ejecutar(ctx, entrada) {
    const solicitud = {
      experiencia: entrada.experiencia,
      fechaInicio: entrada.fecha_inicio,
      fechaFin: entrada.fecha_fin,
      personas: entrada.personas,
    };
    const evaluacion = await evaluarDisponibilidad(prisma, ctx.tenant, solicitud);
    return evaluacionParaModelo(ctx.tenant, evaluacion, solicitud);
  },
});
