import { z } from "zod";
import { prisma } from "../db/prisma";
import { notificarHumano as notificar } from "../services/notificaciones";
import { definirHerramienta } from "./definicion";

export const notificarHumano = definirHerramienta({
  nombre: "notificar_humano",
  descripcion:
    "Avisa al equipo humano del negocio por WhatsApp para que atienda al cliente. Úsala cuando el cliente pide hablar con una persona, tiene una queja o un tema de pagos, quiere cambiar o cancelar una reserva, o pregunta algo que las demás herramientas no responden. El equipo solo verá lo que escribas en `resumen`, así que incluye todo lo necesario para actuar sin releer el chat.",
  esquema: z.object({
    motivo: z.string().min(3).max(80).describe("Etiqueta corta, p. ej. 'pregunta_fuera_de_catalogo', 'queja', 'pago', 'cambio_de_reserva', 'grupo_grande'."),
    resumen: z.string().min(10).max(1200).describe("Qué necesita el cliente, con los datos relevantes (nombre, fechas, experiencia, pregunta exacta)."),
    telefono_cliente: z.string().optional().describe("Se completa automáticamente con el teléfono de este chat."),
  }),
  async ejecutar(ctx, entrada) {
    const aviso = await notificar(ctx.tenant, {
      motivo: entrada.motivo,
      resumen: entrada.resumen,
      telefonoCliente: ctx.telefono,
    });
    await prisma.conversacion.update({ where: { id: ctx.conversacionId }, data: { estado: "ESCALADA" } });
    return {
      registrada: true,
      enviada_al_equipo: aviso.enviada,
      indicacion: "Dile al cliente que el equipo ya fue avisado y lo contactará por este chat. No prometas tiempos exactos.",
    };
  },
});
