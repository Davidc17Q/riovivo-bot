import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env, leerEnv } from "../config/env";
import { logger } from "../config/logger";
import { prisma } from "../db/prisma";
import { normalizarTelefono, sinAcentos } from "../services/texto";

// ---------- Esquemas de los archivos de cada tenant ----------

const horaSchema = z.string().regex(/^\d{2}:\d{2}$/);

const itemSchema = z.looseObject({
  id: z.string(),
  nombre: z.string(),
  precio: z.number().int().nonnegative(),
  moneda: z.string().default("COP"),
  tipo: z.string().optional(),
  personas: z.union([z.number(), z.string()]).optional(),
});

const catalogoSchema = z.looseObject({
  tenant: z.string(),
  experiencias_por_persona: z.array(itemSchema).default([]),
  experiencias_dos_personas: z.array(itemSchema).default([]),
  hospedaje: z.array(itemSchema).default([]),
  habitaciones: z
    .array(z.looseObject({ id: z.string(), nombre: z.string(), capacidad: z.number().int().positive() }))
    .default([]),
  politicas: z.record(z.string(), z.unknown()).default({}),
});

const menuSchema = z.looseObject({
  categorias: z
    .array(
      z.looseObject({
        id: z.string(),
        nombre: z.string(),
        items: z.array(z.looseObject({ nombre: z.string(), precio: z.number() })).default([]),
      }),
    )
    .default([]),
});

const reglaExperienciaSchema = z.object({
  requiere_profesional: z.boolean(),
  minutos_profesional: z.number().int().nonnegative(),
  por_persona: z.boolean(),
});

const configSchema = z.object({
  id: z.string(),
  nombre: z.string(),
  zona_horaria: z.string().default(env.TIMEZONE),
  codigo_pais: z.string().default("57"),
  whatsapp: z.object({
    phone_number_id_env: z.string().default("WHATSAPP_PHONE_NUMBER_ID"),
    token_env: z.string().default("WHATSAPP_TOKEN"),
    owner_env: z.string().default("OWNER_WHATSAPP"),
    owner_por_defecto: z.string().nullish(),
    plantilla_recordatorio: z.string().nullish(),
    plantilla_notificacion: z.string().nullish(),
    idioma_plantilla: z.string().default("es_CO"),
  }),
  agenda: z.object({
    apertura: horaSchema,
    cierre: horaSchema,
    // Cuántos profesionales atienden en paralelo: cuántas citas pueden solaparse.
    // El equipo lo ajusta aquí sin tocar código.
    profesionales: z.number().int().positive().default(1),
    // Hora límite para INICIAR un tratamiento (puede ser antes del cierre del spa).
    // Si se omite, se usa `cierre`. El equipo lo ajusta aquí sin tocar código.
    ultimo_inicio: horaSchema.optional(),
    paso_min: z.number().int().positive().default(30),
    anticipacion_min: z.number().int().nonnegative().default(60),
    dias_busqueda_alternativas: z.number().int().positive().default(14),
    checkin: horaSchema.default("15:00"),
    checkout: horaSchema.default("12:00"),
    max_noches: z.number().int().positive().default(14),
    experiencias: z.record(z.string(), reglaExperienciaSchema),
  }),
  reservas: z.object({
    deposito_porcentaje: z.number().min(0).max(1).default(0.5),
    // Instrucciones de pago del depósito (Nequi/cuenta/titular). El bot las entrega
    // SOLO cuando el equipo confirma la reserva. Vacío = el bot no da datos de pago.
    datos_pago: z.string().default(""),
  }),
  recordatorios: z.object({ horas_antes: z.number().positive().default(24) }),
});

export type ItemCatalogo = z.infer<typeof itemSchema>;
export type Catalogo = z.infer<typeof catalogoSchema>;
export type Menu = z.infer<typeof menuSchema>;
export type ConfigTenant = z.infer<typeof configSchema>;
export type ReglaExperiencia = z.infer<typeof reglaExperienciaSchema>;

export type TipoExperiencia = "pasadia" | "dia_con_habitacion" | "noche";

export interface ExperienciaResuelta {
  item: ItemCatalogo;
  categoria: "experiencias_por_persona" | "experiencias_dos_personas" | "hospedaje";
  tipo: TipoExperiencia;
  regla: ReglaExperiencia;
  minPersonas: number;
  maxPersonas: number;
}

export interface CredencialesWhatsapp {
  token?: string;
  phoneNumberId?: string;
  owner?: string;
}

export interface Tenant {
  id: string;
  config: ConfigTenant;
  catalogo: Catalogo;
  menu: Menu;
  prompt: string;
  credenciales(): CredencialesWhatsapp;
}

// ---------- Carga ----------

const tenants = new Map<string, Tenant>();

function leerJson(ruta: string): unknown {
  return JSON.parse(fs.readFileSync(ruta, "utf8"));
}

function cargarTenant(id: string): Tenant {
  const dir = path.join(env.tenantsDir, id);
  const config = configSchema.parse(leerJson(path.join(dir, "config.json")));
  if (config.id !== id) throw new Error(`config.json de "${id}" declara id "${config.id}"`);

  const catalogo = catalogoSchema.parse(leerJson(path.join(dir, "catalogo.json")));
  const rutaMenu = path.join(dir, "menu.json");
  const menu = menuSchema.parse(fs.existsSync(rutaMenu) ? leerJson(rutaMenu) : { categorias: [] });
  const prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8").trim();

  return {
    id,
    config,
    catalogo,
    menu,
    prompt,
    credenciales() {
      const owner = leerEnv(config.whatsapp.owner_env) ?? config.whatsapp.owner_por_defecto ?? undefined;
      return {
        token: leerEnv(config.whatsapp.token_env),
        phoneNumberId: leerEnv(config.whatsapp.phone_number_id_env),
        owner: owner ? normalizarTelefono(owner, config.codigo_pais) : undefined,
      };
    },
  };
}

/** Lee del disco todos los tenants (una carpeta por negocio). */
export function cargarTenants(): Tenant[] {
  tenants.clear();
  const carpetas = fs
    .readdirSync(env.tenantsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const id of carpetas) {
    try {
      tenants.set(id, cargarTenant(id));
    } catch (error) {
      // Un tenant mal configurado no debe tumbar a los demás.
      logger.error({ err: error, tenant: id }, "No se pudo cargar el tenant");
    }
  }
  return [...tenants.values()];
}

export function obtenerTenant(id: string): Tenant | undefined {
  if (tenants.size === 0) cargarTenants();
  return tenants.get(id);
}

/** Registra/actualiza los tenants en la base de datos (lo usan el seed y el arranque). */
export async function sincronizarTenants(): Promise<string[]> {
  const lista = cargarTenants();
  for (const tenant of lista) {
    const cred = tenant.credenciales();
    const datos = {
      nombre: tenant.config.nombre,
      phoneNumberId: cred.phoneNumberId ?? null,
      ownerWhatsapp: cred.owner ?? null,
      zonaHoraria: tenant.config.zona_horaria,
      catalogoJson: JSON.stringify(tenant.catalogo),
      menuJson: JSON.stringify(tenant.menu),
    };
    await prisma.tenant.upsert({ where: { id: tenant.id }, create: { id: tenant.id, ...datos }, update: datos });
  }
  return lista.map((t) => t.id);
}

/** Resuelve el tenant por el phone_number_id de Meta que recibió el mensaje. */
export async function tenantPorPhoneNumberId(phoneNumberId: string): Promise<Tenant | undefined> {
  const fila = await prisma.tenant.findUnique({ where: { phoneNumberId } });
  if (!fila || !fila.activo) return undefined;
  return obtenerTenant(fila.id);
}

// ---------- Consultas sobre el catálogo ----------

function rangoPersonas(item: ItemCatalogo, categoria: ExperienciaResuelta["categoria"]): [number, number] {
  if (categoria === "experiencias_por_persona") return [1, 50];
  if (typeof item.personas === "number") return [item.personas, item.personas];
  if (typeof item.personas === "string") {
    const numeros = item.personas.match(/\d+/g)?.map(Number) ?? [];
    if (numeros.length >= 2) return [Math.min(...numeros), Math.max(...numeros)];
    if (numeros.length === 1) return [numeros[0]!, numeros[0]!];
  }
  return [2, 2];
}

export function listarExperiencias(tenant: Tenant): ExperienciaResuelta[] {
  const categorias = ["experiencias_por_persona", "experiencias_dos_personas", "hospedaje"] as const;
  const salida: ExperienciaResuelta[] = [];
  for (const categoria of categorias) {
    for (const item of tenant.catalogo[categoria]) {
      const regla = tenant.config.agenda.experiencias[item.id];
      if (!regla) continue; // sin regla de agenda no se puede reservar por el bot
      const tipo: TipoExperiencia =
        categoria === "hospedaje" || item.tipo === "noche"
          ? "noche"
          : item.tipo === "dia_con_habitacion"
            ? "dia_con_habitacion"
            : "pasadia";
      const [minPersonas, maxPersonas] = rangoPersonas(item, categoria);
      salida.push({ item, categoria, tipo, regla, minPersonas, maxPersonas });
    }
  }
  return salida;
}

/** Busca una experiencia por id o por nombre (sin distinguir mayúsculas ni tildes). */
export function buscarExperiencia(tenant: Tenant, idONombre: string): ExperienciaResuelta | undefined {
  const clave = sinAcentos(idONombre).toLowerCase().trim();
  return listarExperiencias(tenant).find(
    (e) => e.item.id.toLowerCase() === clave || sinAcentos(e.item.nombre).toLowerCase() === clave,
  );
}
