import { logger } from "../config/logger";
import { prisma } from "../db/prisma";
import type { Tenant } from "../tenants/loader";
import { evaluarDisponibilidad, evaluacionParaModelo, type Evaluacion, type SolicitudAgenda } from "./agenda";
import { enviarProactivo } from "./mensajeria";
import { notificarHumano } from "./notificaciones";
import { programarRecordatorio } from "./recordatorios";
import { formatoPesos } from "./texto";
import { textoHumano, textoLocal } from "./tiempo";

export interface DatosSolicitud extends SolicitudAgenda {
  nombre: string;
  telefono: string;
  notas?: string | null;
  conversacionId?: number;
}

export type ResultadoSolicitud =
  | { ok: true; reservaId: number; resumen: Record<string, unknown> }
  | { ok: false; respuesta: Record<string, unknown> };

/**
 * Crea una solicitud de reserva SIEMPRE en estado PENDIENTE y avisa al equipo.
 * La disponibilidad se vuelve a validar dentro de la transacción para que dos
 * clientes no aparten el mismo espacio.
 */
export async function crearSolicitudReserva(tenant: Tenant, datos: DatosSolicitud): Promise<ResultadoSolicitud> {
  const zona = tenant.config.zona_horaria;

  const resultado = await prisma.$transaction(async (tx) => {
    const ev: Evaluacion = await evaluarDisponibilidad(tx, tenant, datos);
    if (!ev.disponible) return { ev, reserva: null };
    if (!ev.horaElegida) return { ev, reserva: null };

    const reserva = await tx.reserva.create({
      data: {
        tenantId: tenant.id,
        conversacionId: datos.conversacionId ?? null,
        nombre: datos.nombre,
        telefono: datos.telefono,
        experienciaId: ev.experiencia.item.id,
        experienciaNombre: ev.experiencia.item.nombre,
        inicio: ev.propuesta.inicio,
        fin: ev.propuesta.fin,
        profInicio: ev.propuesta.profInicio,
        profFin: ev.propuesta.profFin,
        habitacionId: ev.propuesta.habitacionId,
        personas: datos.personas,
        noches: ev.propuesta.noches,
        totalEstimado: ev.cotizacion.total,
        depositoEstimado: ev.cotizacion.deposito,
        notas: datos.notas ?? null,
        estado: "PENDIENTE",
      },
    });
    return { ev, reserva };
  });

  const { ev, reserva } = resultado;
  if (!ev.disponible) return { ok: false, respuesta: { creada: false, ...evaluacionParaModelo(tenant, ev, datos) } };
  if (!reserva) {
    return {
      ok: false,
      respuesta: {
        creada: false,
        motivo: "falta_la_hora",
        detalle: "Para esta experiencia fecha_inicio debe incluir la hora de llegada (YYYY-MM-DDTHH:mm).",
        horas_inicio_disponibles: ev.horasDisponibles,
      },
    };
  }

  const esNoche = ev.experiencia.tipo === "noche";
  const cuando = esNoche
    ? `${textoHumano(reserva.inicio, zona)} → ${textoHumano(reserva.fin, zona)} (${reserva.noches} noche(s))`
    : textoHumano(reserva.profInicio ?? reserva.inicio, zona);
  const habitacion = reserva.habitacionId
    ? (tenant.catalogo.habitaciones.find((h) => h.id === reserva.habitacionId)?.nombre ?? reserva.habitacionId)
    : null;

  const textoWhatsapp = [
    `🔔 *Nueva solicitud de reserva #${reserva.id}* (PENDIENTE)`,
    `Cliente: ${reserva.nombre} (+${reserva.telefono})`,
    `Experiencia: ${reserva.experienciaNombre}`,
    `Fecha: ${cuando}`,
    `Personas: ${reserva.personas}`,
    habitacion ? `Habitación: ${habitacion}` : null,
    `Total estimado: ${formatoPesos(ev.cotizacion.total)} · Depósito: ${formatoPesos(ev.cotizacion.deposito)}`,
    reserva.notas ? `Notas: ${reserva.notas}` : null,
    "",
    `Cuando recibas el depósito responde *CONFIRMAR ${reserva.id}*. Para descartarla: *RECHAZAR ${reserva.id}*.`,
  ]
    .filter((linea) => linea !== null)
    .join("\n");

  const aviso = await notificarHumano(tenant, {
    motivo: "nueva_solicitud_reserva",
    resumen: `Solicitud #${reserva.id}: ${reserva.experienciaNombre}, ${cuando}, ${reserva.personas} persona(s), ${reserva.nombre}.`,
    telefonoCliente: reserva.telefono,
    textoWhatsapp,
  });

  return {
    ok: true,
    reservaId: reserva.id,
    resumen: {
      creada: true,
      solicitud_id: reserva.id,
      estado: "PENDIENTE",
      equipo_notificado: aviso.enviada,
      ...evaluacionParaModelo(tenant, ev, datos),
      importante:
        "La solicitud quedó PENDIENTE, NO confirmada. El equipo contactará al cliente con las instrucciones del depósito y confirmará la reserva al recibirlo.",
    },
  };
}

const TRANSICIONES: Record<string, string[]> = {
  PENDIENTE: ["CONFIRMADA", "RECHAZADA", "CANCELADA"],
  CONFIRMADA: ["CANCELADA"],
};

export interface ResultadoCambio {
  ok: boolean;
  mensaje: string;
  clienteAvisado?: boolean;
}

/**
 * Cambio de estado hecho por una persona del equipo (por WhatsApp o por /admin).
 * Es el único camino hacia CONFIRMADA.
 */
export async function cambiarEstadoReserva(tenant: Tenant, reservaId: number, nuevo: string): Promise<ResultadoCambio> {
  const zona = tenant.config.zona_horaria;
  const reserva = await prisma.reserva.findFirst({ where: { id: reservaId, tenantId: tenant.id } });
  if (!reserva) return { ok: false, mensaje: `No existe la solicitud #${reservaId}.` };
  if (!TRANSICIONES[reserva.estado]?.includes(nuevo)) {
    return { ok: false, mensaje: `La solicitud #${reservaId} está ${reserva.estado}; no se puede pasar a ${nuevo}.` };
  }

  await prisma.reserva.update({ where: { id: reserva.id }, data: { estado: nuevo } });

  const cita = reserva.profInicio && reserva.noches === 0 ? reserva.profInicio : reserva.inicio;
  let textoCliente: string;

  if (nuevo === "CONFIRMADA") {
    const datosPago = tenant.config.reservas.datos_pago?.trim();
    const bloquePago = datosPago
      ? `\n\nPara asegurar tu cupo, el anticipo es *${formatoPesos(reserva.depositoEstimado ?? 0)}* (50%).\n${datosPago}\nCuando hagas la transferencia, mándanos el comprobante por aquí y lo registramos. 🙏`
      : "";
    textoCliente = `✅ ¡Listo, ${reserva.nombre}! Tu reserva de *${reserva.experienciaNombre}* en ${tenant.config.nombre} quedó *confirmada* para el ${textoHumano(cita, zona)}.${bloquePago} ¡Te esperamos!`;

    const fechaRecordatorio = new Date(cita.getTime() - tenant.config.recordatorios.horas_antes * 3_600_000);
    if (fechaRecordatorio.getTime() > Date.now()) {
      try {
        await programarRecordatorio({
          tenantId: tenant.id,
          telefono: reserva.telefono,
          fechaHora: fechaRecordatorio,
          mensaje: `Hola ${reserva.nombre} 🌿 Te recordamos tu reserva de ${reserva.experienciaNombre} en ${tenant.config.nombre} el ${textoHumano(cita, zona)}. ¡Te esperamos!`,
          reservaId: reserva.id,
        });
      } catch (error) {
        logger.error({ err: error, reserva: reserva.id }, "No se pudo programar el recordatorio de la reserva");
      }
    }
  } else {
    await prisma.recordatorio.updateMany({
      where: { reservaId: reserva.id, estado: "PENDIENTE" },
      data: { estado: "CANCELADO" },
    });
    textoCliente = `Hola ${reserva.nombre}, tu solicitud de *${reserva.experienciaNombre}* para el ${textoHumano(cita, zona)} no pudo ser confirmada. Si quieres, escríbenos y miramos otra fecha. 🙏`;
  }

  const envio = await enviarProactivo(tenant, reserva.telefono, textoCliente, tenant.config.whatsapp.plantilla_notificacion);
  if (envio.ok) await guardarEnHistorialDelCliente(tenant, reserva.telefono, textoCliente);
  const estadoTexto = nuevo.toLowerCase();
  return {
    ok: true,
    clienteAvisado: envio.ok,
    mensaje: envio.ok
      ? `Solicitud #${reserva.id} ${estadoTexto}. Ya le avisé al cliente.`
      : `Solicitud #${reserva.id} ${estadoTexto}, pero NO pude avisarle al cliente (+${reserva.telefono}): ${envio.error ?? "error"}. Escríbele directamente.`,
  };
}

/**
 * Deja en el historial del cliente un mensaje que le mandó el sistema (no el modelo),
 * para que el asistente sepa qué se le dijo: confirmación, datos de pago, rechazo.
 */
async function guardarEnHistorialDelCliente(tenant: Tenant, telefono: string, texto: string): Promise<void> {
  try {
    const conversacion = await prisma.conversacion.findUnique({
      where: { tenantId_telefono: { tenantId: tenant.id, telefono } },
      select: { id: true },
    });
    if (conversacion) {
      await prisma.mensaje.create({ data: { conversacionId: conversacion.id, rol: "assistant", contenido: texto } });
    }
  } catch (error) {
    logger.warn({ err: error, tenant: tenant.id }, "No se pudo guardar el aviso en el historial del cliente");
  }
}

/** Datos de pago del depósito: solo se entregan para reservas que el equipo ya confirmó. */
export async function datosPagoDelCliente(tenant: Tenant, telefono: string): Promise<Record<string, unknown>> {
  const zona = tenant.config.zona_horaria;
  const reservas = await prisma.reserva.findMany({
    where: { tenantId: tenant.id, telefono, fin: { gte: new Date() }, estado: { in: ["CONFIRMADA", "PENDIENTE"] } },
    orderBy: { inicio: "asc" },
    take: 5,
  });
  const describir = (r: (typeof reservas)[number]) => ({
    reserva: r.id,
    experiencia: r.experienciaNombre,
    fecha: textoHumano(r.profInicio && r.noches === 0 ? r.profInicio : r.inicio, zona),
    deposito: r.depositoEstimado != null ? formatoPesos(r.depositoEstimado) : null,
  });
  const confirmadas = reservas.filter((r) => r.estado === "CONFIRMADA").map(describir);
  const pendientes = reservas.filter((r) => r.estado === "PENDIENTE").map(describir);
  const datosPago = tenant.config.reservas.datos_pago?.trim();

  if (confirmadas.length > 0 && datosPago) {
    return {
      disponible: true,
      datos_pago: datosPago,
      reservas_confirmadas: confirmadas,
      reservas_pendientes: pendientes,
      indicacion:
        "Copia `datos_pago` tal cual (no cambies ningún número) e indica el depósito de cada reserva confirmada. " +
        "Pídele que mande el comprobante por este chat. Para las pendientes, aclara que su depósito se paga cuando el equipo las confirme.",
    };
  }
  if (pendientes.length > 0) {
    return {
      disponible: false,
      motivo: "solo_reservas_pendientes",
      reservas_pendientes: pendientes,
      indicacion:
        "Explícale que los datos para el depósito le llegan automáticamente por este chat en cuanto el equipo confirme su solicitud. " +
        "No llames a notificar_humano por esto: el equipo ya tiene la solicitud.",
    };
  }
  return {
    disponible: false,
    motivo: confirmadas.length > 0 ? "sin_datos_de_pago_configurados" : "sin_reservas",
    indicacion:
      confirmadas.length > 0
        ? "No hay datos de pago cargados. Dile que el equipo se los envía y llama a notificar_humano."
        : "El cliente no tiene reservas activas: primero hay que crear la solicitud. No des datos de pago.",
  };
}

/** Reservas activas de un cliente, para darle contexto al modelo. */
export async function reservasDelCliente(tenant: Tenant, telefono: string): Promise<string[]> {
  const zona = tenant.config.zona_horaria;
  const reservas = await prisma.reserva.findMany({
    where: { tenantId: tenant.id, telefono, fin: { gte: new Date() } },
    orderBy: { inicio: "asc" },
    take: 5,
  });
  return reservas.map((r) => {
    const cita = r.profInicio && r.noches === 0 ? r.profInicio : r.inicio;
    return `#${r.id} ${r.experienciaNombre}, ${textoLocal(cita, zona)}, ${r.personas} persona(s), estado ${r.estado}`;
  });
}
