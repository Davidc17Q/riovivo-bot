import type Anthropic from "@anthropic-ai/sdk";
import { consultarCatalogo } from "../tools/consultarCatalogo";
import { consultarDisponibilidad } from "../tools/consultarDisponibilidad";
import { crearSolicitudReserva } from "../tools/crearSolicitudReserva";
import type { Herramienta } from "../tools/definicion";
import { guardarDatosCliente } from "../tools/guardarDatosCliente";
import { notificarHumano } from "../tools/notificarHumano";
import { programarRecordatorio } from "../tools/programarRecordatorio";

// El orden es fijo: cambiarlo invalida la caché de prompts de Anthropic.
const HERRAMIENTAS: Herramienta[] = [
  consultarCatalogo,
  consultarDisponibilidad,
  crearSolicitudReserva,
  notificarHumano,
  programarRecordatorio,
  guardarDatosCliente,
];

export const definicionesTools: Anthropic.Tool[] = HERRAMIENTAS.map((h) => h.definicion);

export function buscarHerramienta(nombre: string): Herramienta | undefined {
  return HERRAMIENTAS.find((h) => h.nombre === nombre);
}
