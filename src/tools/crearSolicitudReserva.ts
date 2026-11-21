import { z } from "zod";
import { guardarDatosCliente } from "../services/memoria";
import { crearSolicitudReserva as crear } from "../services/reservas";
import { definirHerramienta } from "./definicion";

export const crearSolicitudReserva = definirHerramienta({
  nombre: "crear_solicitud_reserva",
  descripcion:
    "Registra una solicitud de reserva en estado PENDIENTE y avisa al equipo humano, que es quien la confirma cuando recibe el depósito. Nunca confirma la reserva. Úsala solo cuando el cliente ya dijo que quiere reservar y tienes nombre, experiencia, fecha, número de personas y (para pasadías) hora de llegada. Vuelve a validar la disponibilidad: si ya no hay cupo devuelve alternativas en lugar de crearla.",
  esquema: z.object({
    nombre: z.string().min(2).max(120).describe("Nombre completo del cliente."),
    telefono: z
      .string()
      .optional()
      .describe("Teléfono de contacto si el cliente dio uno distinto al de este chat. Si se omite se usa el de este chat."),
    experiencia: z.string().describe("Id de la experiencia o plan según el catálogo."),
    fecha_inicio: z
      .string()
      .describe("Pasadías: 'YYYY-MM-DDTHH:mm' con la hora de llegada elegida. Hospedaje: fecha de llegada 'YYYY-MM-DD'."),
    fecha_fin: z.string().optional().describe("Solo hospedaje: fecha de salida 'YYYY-MM-DD'."),
    personas: z.number().int().min(1).max(50),
    notas: z
      .string()
      .max(500)
      .optional()
      .describe("Detalles útiles para el equipo: celebración, peticiones especiales, teléfono alterno, etc."),
  }),
  async ejecutar(ctx, entrada) {
    // La reserva siempre queda ligada al número del chat; un teléfono alterno va en las notas.
    const alterno = entrada.telefono?.replace(/\D/g, "");
    const notas =
      alterno && !ctx.telefono.endsWith(alterno)
        ? [entrada.notas, `Teléfono alterno indicado por el cliente: ${alterno}`].filter(Boolean).join(" · ")
        : entrada.notas;

    const resultado = await crear(ctx.tenant, {
      nombre: entrada.nombre,
      telefono: ctx.telefono,
      experiencia: entrada.experiencia,
      fechaInicio: entrada.fecha_inicio,
      fechaFin: entrada.fecha_fin,
      personas: entrada.personas,
      notas,
      conversacionId: ctx.conversacionId,
    });

    if (!resultado.ok) return resultado.respuesta;
    await guardarDatosCliente(ctx.conversacionId, { nombre: entrada.nombre });
    return resultado.resumen;
  },
});
