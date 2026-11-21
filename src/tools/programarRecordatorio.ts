import { z } from "zod";
import { ErrorRecordatorio, programarRecordatorio as programar } from "../services/recordatorios";
import { localAUtc, parsearFechaLocal, textoLocal } from "../services/tiempo";
import { definirHerramienta } from "./definicion";

export const programarRecordatorio = definirHerramienta({
  nombre: "programar_recordatorio",
  descripcion:
    "Programa un mensaje de WhatsApp que se le enviará a este mismo cliente en una fecha y hora futuras. Úsala solo cuando el cliente lo pide expresamente; el recordatorio de una reserva confirmada lo crea el sistema automáticamente.",
  esquema: z.object({
    telefono: z.string().optional().describe("Se ignora: el recordatorio siempre va al teléfono de este chat."),
    fecha_hora: z.string().describe("Cuándo enviarlo, en hora local del negocio: 'YYYY-MM-DDTHH:mm'."),
    mensaje: z.string().min(5).max(600).describe("Texto del recordatorio, listo para enviar tal cual."),
  }),
  async ejecutar(ctx, entrada) {
    const zona = ctx.tenant.config.zona_horaria;
    const fecha = parsearFechaLocal(entrada.fecha_hora);
    if (!fecha || !fecha.hora) {
      return { programado: false, detalle: "fecha_hora debe tener el formato YYYY-MM-DDTHH:mm." };
    }
    try {
      const { id } = await programar({
        tenantId: ctx.tenant.id,
        telefono: ctx.telefono,
        fechaHora: localAUtc(fecha.fecha, fecha.hora, zona),
        mensaje: entrada.mensaje,
      });
      return { programado: true, recordatorio_id: id, se_enviara: textoLocal(localAUtc(fecha.fecha, fecha.hora, zona), zona) };
    } catch (error) {
      if (error instanceof ErrorRecordatorio) return { programado: false, detalle: error.message };
      throw error;
    }
  },
});
