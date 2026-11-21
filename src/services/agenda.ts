import type { Db } from "../db/prisma";
import { buscarExperiencia, listarExperiencias, type ExperienciaResuelta, type Tenant } from "../tenants/loader";
import { diferenciaDias, localAUtc, parsearFechaLocal, sumarDias, textoLocal, utcALocal } from "./tiempo";

// Reglas de agenda:
//  - Varios profesionales (agenda.profesionales): una hora tiene cupo mientras el
//    número de citas que se solapan con ese bloque sea menor que la cantidad de
//    profesionales. Con profesionales=1 equivale a "no se solapan".
//  - Los tratamientos solo pueden INICIAR hasta agenda.ultimo_inicio (si se define;
//    por defecto, hasta el cierre). El spa puede seguir abierto después de esa hora.
//  - Una habitación no se ocupa dos veces en el mismo rango.
//  - Las solicitudes PENDIENTES también bloquean cupo, para no ofrecer el mismo
//    espacio a dos clientes mientras el equipo confirma.

export const ESTADOS_ACTIVOS = ["PENDIENTE", "CONFIRMADA"];

export interface SolicitudAgenda {
  experiencia: string;
  fechaInicio: string;
  fechaFin?: string | null;
  personas: number;
}

export interface Cotizacion {
  moneda: string;
  total: number;
  deposito: number;
  detalle: string;
  notas: string[];
}

export interface Propuesta {
  inicio: Date;
  fin: Date;
  profInicio: Date | null;
  profFin: Date | null;
  habitacionId: string | null;
  noches: number;
}

interface Intervalo {
  inicio: Date;
  fin: Date;
}

type ResultadoDia =
  | { ok: true; propuesta: Propuesta; horasDisponibles: string[]; horaElegida: boolean }
  | { ok: false; motivo: string; horasDisponibles: string[] };

export type Evaluacion =
  | {
      disponible: true;
      experiencia: ExperienciaResuelta;
      propuesta: Propuesta;
      horasDisponibles: string[];
      horaElegida: boolean;
      cotizacion: Cotizacion;
    }
  | {
      disponible: false;
      motivo: string;
      detalle: string;
      experiencia?: ExperienciaResuelta;
      horasDisponibles?: string[];
      alternativas?: { fecha: string; horas_inicio_disponibles?: string[] }[];
    };

const solapan = (a: Intervalo, b: Intervalo): boolean => a.inicio < b.fin && b.inicio < a.fin;

export function cotizar(tenant: Tenant, exp: ExperienciaResuelta, personas: number, noches: number): Cotizacion {
  const precio = exp.item.precio;
  const notas: string[] = [];
  let total: number;
  let detalle: string;

  if (exp.categoria === "experiencias_por_persona") {
    total = precio * personas;
    detalle = `${personas} persona(s) x ${precio}`;
  } else if (exp.tipo === "noche") {
    total = precio * noches;
    detalle = `${noches} noche(s) x ${precio}`;
    if (typeof exp.item.descuento_entre_semana === "number") {
      notas.push(
        `Entre semana puede aplicar un descuento del ${Math.round(exp.item.descuento_entre_semana * 100)}% que NO está incluido en este total; lo confirma el equipo.`,
      );
    }
  } else {
    total = precio;
    detalle = `Tarifa del plan para ${personas} personas`;
  }

  const porcentaje = tenant.config.reservas.deposito_porcentaje;
  return { moneda: exp.item.moneda, total, deposito: Math.round(total * porcentaje), detalle, notas };
}

/** Horas de inicio libres para el profesional en una fecha. */
async function horasLibresProfesional(
  db: Db,
  tenant: Tenant,
  fecha: string,
  minutos: number,
  ahora: Date,
): Promise<{ horas: string[]; ocupados: Intervalo[]; abre: Date; cierra: Date }> {
  const { zona_horaria: zona, agenda } = tenant.config;
  const abre = localAUtc(fecha, agenda.apertura, zona);
  const cierra = localAUtc(fecha, agenda.cierre, zona);
  // Hora límite para iniciar un tratamiento (puede ser anterior al cierre del spa).
  const topeInicio = localAUtc(fecha, agenda.ultimo_inicio ?? agenda.cierre, zona);

  const reservas = await db.reserva.findMany({
    where: { tenantId: tenant.id, estado: { in: ESTADOS_ACTIVOS }, profInicio: { lt: cierra }, profFin: { gt: abre } },
    select: { profInicio: true, profFin: true },
  });
  const ocupados: Intervalo[] = [];
  for (const r of reservas) {
    if (r.profInicio && r.profFin) ocupados.push({ inicio: r.profInicio, fin: r.profFin });
  }

  const minimo = new Date(ahora.getTime() + agenda.anticipacion_min * 60_000);
  const horas: string[] = [];
  // Una hora queda libre mientras haya menos citas solapadas que profesionales.
  for (let t = abre.getTime(); t + minutos * 60_000 <= cierra.getTime() && t <= topeInicio.getTime(); t += agenda.paso_min * 60_000) {
    const bloque = { inicio: new Date(t), fin: new Date(t + minutos * 60_000) };
    if (bloque.inicio < minimo) continue;
    const solapadas = ocupados.filter((o) => solapan(o, bloque)).length;
    if (solapadas >= agenda.profesionales) continue;
    horas.push(utcALocal(bloque.inicio, zona).hora);
  }
  return { horas, ocupados, abre, cierra };
}

async function habitacionLibre(db: Db, tenant: Tenant, estancia: Intervalo, personas: number): Promise<string | null> {
  const candidatas = tenant.catalogo.habitaciones
    .filter((h) => h.capacidad >= personas)
    .sort((a, b) => a.capacidad - b.capacidad);
  if (candidatas.length === 0) return null;

  const ocupadas = await db.reserva.findMany({
    where: {
      tenantId: tenant.id,
      estado: { in: ESTADOS_ACTIVOS },
      habitacionId: { not: null },
      inicio: { lt: estancia.fin },
      fin: { gt: estancia.inicio },
    },
    select: { habitacionId: true },
  });
  const idsOcupados = new Set(ocupadas.map((o) => o.habitacionId));
  return candidatas.find((h) => !idsOcupados.has(h.id))?.id ?? null;
}

async function evaluarFecha(
  db: Db,
  tenant: Tenant,
  exp: ExperienciaResuelta,
  fecha: string,
  hora: string | undefined,
  personas: number,
  noches: number,
  ahora: Date,
): Promise<ResultadoDia> {
  const { zona_horaria: zona, agenda } = tenant.config;
  const hoy = utcALocal(ahora, zona).fecha;
  if (fecha < hoy) return { ok: false, motivo: "fecha_pasada", horasDisponibles: [] };

  const abre = localAUtc(fecha, agenda.apertura, zona);
  const cierra = localAUtc(fecha, agenda.cierre, zona);
  const esNoche = exp.tipo === "noche";

  // 1) Habitación (planes con alojamiento o habitación de día).
  let habitacionId: string | null = null;
  const estancia: Intervalo = esNoche
    ? { inicio: localAUtc(fecha, agenda.checkin, zona), fin: localAUtc(sumarDias(fecha, noches), agenda.checkout, zona) }
    : { inicio: abre, fin: cierra };
  if (exp.tipo !== "pasadia") {
    if (!esNoche && cierra <= ahora) return { ok: false, motivo: "sin_cupo_ese_dia", horasDisponibles: [] };
    habitacionId = await habitacionLibre(db, tenant, estancia, personas);
    if (!habitacionId) return { ok: false, motivo: "sin_habitacion_disponible", horasDisponibles: [] };
  }

  // 2) Profesional.
  if (!exp.regla.requiere_profesional) {
    return {
      ok: true,
      propuesta: { inicio: estancia.inicio, fin: estancia.fin, profInicio: null, profFin: null, habitacionId, noches },
      horasDisponibles: [],
      horaElegida: true,
    };
  }

  const minutos = exp.regla.minutos_profesional * (exp.regla.por_persona ? personas : 1);
  if (minutos * 60_000 > cierra.getTime() - abre.getTime()) {
    return { ok: false, motivo: "grupo_excede_la_jornada", horasDisponibles: [] };
  }

  if (esNoche) {
    // El tratamiento del plan se agenda el día de llegada o, si no cabe, al día siguiente.
    // La hora exacta la coordina el equipo; aquí solo se aparta el bloque del profesional.
    for (const dia of [fecha, sumarDias(fecha, 1)]) {
      const libres = await horasLibresProfesional(db, tenant, dia, minutos, ahora);
      const primera = libres.horas[0];
      if (primera) {
        const profInicio = localAUtc(dia, primera, zona);
        return {
          ok: true,
          propuesta: {
            inicio: estancia.inicio,
            fin: estancia.fin,
            profInicio,
            profFin: new Date(profInicio.getTime() + minutos * 60_000),
            habitacionId,
            noches,
          },
          horasDisponibles: [],
          horaElegida: true,
        };
      }
    }
    return { ok: false, motivo: "sin_cupo_del_profesional", horasDisponibles: [] };
  }

  const libres = await horasLibresProfesional(db, tenant, fecha, minutos, ahora);
  if (libres.horas.length === 0) return { ok: false, motivo: "sin_cupo_ese_dia", horasDisponibles: [] };

  const horaUsada = hora ?? libres.horas[0]!;
  const profInicio = localAUtc(fecha, horaUsada, zona);
  const profFin = new Date(profInicio.getTime() + minutos * 60_000);
  if (hora) {
    const minimo = new Date(ahora.getTime() + agenda.anticipacion_min * 60_000);
    const topeInicio = localAUtc(fecha, agenda.ultimo_inicio ?? agenda.cierre, zona);
    const cabe = profInicio >= abre && profFin <= cierra && profInicio >= minimo && profInicio <= topeInicio;
    const solapadas = libres.ocupados.filter((o) => solapan(o, { inicio: profInicio, fin: profFin })).length;
    const libre = solapadas < agenda.profesionales;
    if (!cabe || !libre) return { ok: false, motivo: "hora_no_disponible", horasDisponibles: libres.horas };
  }

  // Pasadía: la reserva ocupa el bloque de la cita. Con habitación de día: toda la jornada.
  const propuesta: Propuesta =
    exp.tipo === "pasadia"
      ? { inicio: profInicio, fin: profFin, profInicio, profFin, habitacionId: null, noches: 0 }
      : { inicio: estancia.inicio, fin: estancia.fin, profInicio, profFin, habitacionId, noches: 0 };
  return { ok: true, propuesta, horasDisponibles: libres.horas, horaElegida: Boolean(hora) };
}

const DETALLES: Record<string, string> = {
  fecha_pasada: "La fecha solicitada ya pasó.",
  sin_cupo_ese_dia: "Ese día el profesional ya no tiene espacio para esta experiencia.",
  hora_no_disponible: "Esa hora no está disponible; hay otras horas libres ese mismo día.",
  sin_habitacion_disponible: "No hay habitación disponible con esa capacidad para esas fechas.",
  sin_cupo_del_profesional: "No hay espacio del profesional para el tratamiento incluido en esas fechas.",
  grupo_excede_la_jornada:
    "El grupo es muy grande para atenderlo en un solo día con un profesional. El equipo debe revisarlo: usa notificar_humano.",
};

/** Evalúa disponibilidad real (agenda + habitaciones) y cotiza. No escribe nada. */
export async function evaluarDisponibilidad(
  db: Db,
  tenant: Tenant,
  solicitud: SolicitudAgenda,
  ahora: Date = new Date(),
): Promise<Evaluacion> {
  const { zona_horaria: zona, agenda } = tenant.config;

  const exp = buscarExperiencia(tenant, solicitud.experiencia);
  if (!exp) {
    const validas = listarExperiencias(tenant).map((e) => e.item.id).join(", ");
    return {
      disponible: false,
      motivo: "experiencia_no_encontrada",
      detalle: `No existe esa experiencia en el catálogo. Ids válidos: ${validas}.`,
    };
  }

  const inicio = parsearFechaLocal(solicitud.fechaInicio);
  if (!inicio) {
    return { disponible: false, motivo: "fecha_invalida", detalle: "fecha_inicio debe ser YYYY-MM-DD o YYYY-MM-DDTHH:mm.", experiencia: exp };
  }

  if (solicitud.personas < exp.minPersonas || solicitud.personas > exp.maxPersonas) {
    const rango = exp.minPersonas === exp.maxPersonas ? `${exp.minPersonas}` : `entre ${exp.minPersonas} y ${exp.maxPersonas}`;
    return {
      disponible: false,
      motivo: "numero_de_personas_no_valido",
      detalle: `${exp.item.nombre} es para ${rango} persona(s). Si el cliente necesita otra cosa, lo revisa el equipo.`,
      experiencia: exp,
    };
  }

  let noches = 0;
  if (exp.tipo === "noche") {
    noches = 1;
    if (solicitud.fechaFin) {
      const fin = parsearFechaLocal(solicitud.fechaFin);
      if (!fin) {
        return { disponible: false, motivo: "fecha_invalida", detalle: "fecha_fin debe ser YYYY-MM-DD.", experiencia: exp };
      }
      noches = diferenciaDias(inicio.fecha, fin.fecha);
    }
    if (noches < 1 || noches > agenda.max_noches) {
      return {
        disponible: false,
        motivo: "rango_de_fechas_no_valido",
        detalle: `La salida debe ser posterior a la llegada (máximo ${agenda.max_noches} noches por solicitud).`,
        experiencia: exp,
      };
    }
  }

  const r = await evaluarFecha(db, tenant, exp, inicio.fecha, inicio.hora, solicitud.personas, noches, ahora);
  if (r.ok) {
    return {
      disponible: true,
      experiencia: exp,
      propuesta: r.propuesta,
      horasDisponibles: r.horasDisponibles,
      horaElegida: r.horaElegida,
      cotizacion: cotizar(tenant, exp, solicitud.personas, noches),
    };
  }

  // Sin cupo: se buscan las próximas fechas con espacio para sugerirlas.
  const alternativas: { fecha: string; horas_inicio_disponibles?: string[] }[] = [];
  if (r.motivo !== "grupo_excede_la_jornada") {
    const hoy = utcALocal(ahora, zona).fecha;
    const base = inicio.fecha < hoy ? sumarDias(hoy, -1) : inicio.fecha;
    for (let i = 1; i <= agenda.dias_busqueda_alternativas && alternativas.length < 3; i++) {
      const fecha = sumarDias(base, i);
      const alt = await evaluarFecha(db, tenant, exp, fecha, undefined, solicitud.personas, noches, ahora);
      if (alt.ok) {
        alternativas.push(
          alt.horasDisponibles.length > 0 ? { fecha, horas_inicio_disponibles: alt.horasDisponibles.slice(0, 6) } : { fecha },
        );
      }
    }
  }

  return {
    disponible: false,
    motivo: r.motivo,
    detalle: DETALLES[r.motivo] ?? "No hay disponibilidad.",
    experiencia: exp,
    horasDisponibles: r.horasDisponibles,
    alternativas,
  };
}

/** Convierte una evaluación en el JSON que lee el modelo (fechas en hora local). */
export function evaluacionParaModelo(tenant: Tenant, ev: Evaluacion, solicitud: SolicitudAgenda): Record<string, unknown> {
  const zona = tenant.config.zona_horaria;
  if (!ev.disponible) {
    return {
      disponible: false,
      motivo: ev.motivo,
      detalle: ev.detalle,
      ...(ev.horasDisponibles && ev.horasDisponibles.length > 0 ? { horas_inicio_disponibles_ese_dia: ev.horasDisponibles } : {}),
      ...(ev.alternativas ? { fechas_alternativas: ev.alternativas } : {}),
    };
  }

  const { propuesta: p, experiencia: exp } = ev;
  const notas = [...ev.cotizacion.notas];
  const salida: Record<string, unknown> = {
    disponible: true,
    experiencia: { id: exp.item.id, nombre: exp.item.nombre },
    personas: solicitud.personas,
  };

  if (exp.tipo === "noche") {
    salida.llegada = textoLocal(p.inicio, zona);
    salida.salida = textoLocal(p.fin, zona);
    salida.noches = p.noches;
    if (p.profInicio) notas.push("La hora del tratamiento incluido la coordina el equipo al confirmar.");
  } else if (ev.horaElegida && p.profInicio) {
    salida.cita = textoLocal(p.profInicio, zona);
  } else {
    salida.fecha = utcALocal(p.inicio, zona).fecha;
    salida.horas_inicio_disponibles = ev.horasDisponibles;
    notas.push("Falta que el cliente elija una hora de llegada entre las disponibles.");
  }

  if (p.habitacionId) {
    salida.habitacion = tenant.catalogo.habitaciones.find((h) => h.id === p.habitacionId)?.nombre ?? p.habitacionId;
  }
  salida.cotizacion = {
    moneda: ev.cotizacion.moneda,
    total: ev.cotizacion.total,
    deposito_para_reservar: ev.cotizacion.deposito,
    detalle: ev.cotizacion.detalle,
  };
  notas.push("Disponibilidad sujeta a confirmación del equipo: el cupo solo queda asegurado con el depósito.");
  salida.notas = notas;
  return salida;
}
