// Utilidades de fecha con zona horaria del tenant, sin dependencias.
// Convención: "fecha" = "YYYY-MM-DD" y "hora" = "HH:mm", ambas en hora local del negocio.

const formateadores = new Map<string, Intl.DateTimeFormat>();

function formateador(zona: string): Intl.DateTimeFormat {
  let f = formateadores.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zona,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formateadores.set(zona, f);
  }
  return f;
}

function partes(instante: Date, zona: string): Record<string, number> {
  const salida: Record<string, number> = {};
  for (const p of formateador(zona).formatToParts(instante)) {
    if (p.type !== "literal") salida[p.type] = Number(p.value);
  }
  return salida;
}

function desfaseMs(instante: Date, zona: string): number {
  const p = partes(instante, zona);
  const comoUtc = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

function numeros(texto: string, separador: string): number[] {
  return texto.split(separador).map(Number);
}

/** Hora local del negocio → instante UTC. */
export function localAUtc(fecha: string, hora: string, zona: string): Date {
  const [anio = 0, mes = 1, dia = 1] = numeros(fecha, "-");
  const [h = 0, m = 0] = numeros(hora, ":");
  const aproximado = Date.UTC(anio, mes - 1, dia, h, m);
  return new Date(aproximado - desfaseMs(new Date(aproximado), zona));
}

/** Instante UTC → fecha y hora locales del negocio. */
export function utcALocal(instante: Date, zona: string): { fecha: string; hora: string } {
  const p = partes(instante, zona);
  const dos = (n: number | undefined): string => String(n ?? 0).padStart(2, "0");
  return { fecha: `${p.year}-${dos(p.month)}-${dos(p.day)}`, hora: `${dos(p.hour)}:${dos(p.minute)}` };
}

/** "YYYY-MM-DD HH:mm" en hora local (formato que se le entrega al modelo). */
export function textoLocal(instante: Date, zona: string): string {
  const l = utcALocal(instante, zona);
  return `${l.fecha} ${l.hora}`;
}

/** Texto para personas: "viernes, 20 de noviembre de 2026, 10:00 a. m." */
export function textoHumano(instante: Date, zona: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: zona, dateStyle: "full", timeStyle: "short" }).format(instante);
}

export function sumarDias(fecha: string, dias: number): string {
  const [anio = 0, mes = 1, dia = 1] = numeros(fecha, "-");
  return new Date(Date.UTC(anio, mes - 1, dia + dias)).toISOString().slice(0, 10);
}

export function diferenciaDias(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Interpreta "YYYY-MM-DD" o "YYYY-MM-DDTHH:mm" (también con espacio) en hora local.
 * Devuelve null si el texto no es una fecha real.
 */
export function parsearFechaLocal(texto: string): { fecha: string; hora?: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?)?$/.exec(texto.trim());
  if (!m || !m[1]) return null;
  const fecha = m[1];
  if (sumarDias(fecha, 0) !== fecha) return null; // p. ej. 2026-02-31
  const hora = m[2];
  if (hora) {
    const [h = 99, min = 99] = numeros(hora, ":");
    if (h > 23 || min > 59) return null;
  }
  return hora ? { fecha, hora } : { fecha };
}
