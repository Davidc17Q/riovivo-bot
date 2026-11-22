import { z } from "zod";
import { datosPagoDelCliente } from "../services/reservas";
import { definirHerramienta } from "./definicion";

export const consultarDatosPago = definirHerramienta({
  nombre: "consultar_datos_pago",
  descripcion:
    "Devuelve los datos de la cuenta para pagar el depósito, pero solo si el cliente de este chat tiene una reserva que el equipo ya CONFIRMÓ. Si sus solicitudes siguen pendientes, indica qué decirle. Úsala siempre que el cliente pida el número de cuenta, cómo pagar o a dónde consignar; nunca escribas datos de pago de memoria.",
  esquema: z.object({}),
  async ejecutar(ctx) {
    return datosPagoDelCliente(ctx.tenant, ctx.telefono);
  },
});
