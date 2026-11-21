import { z } from "zod";
import { sinAcentos } from "../services/texto";
import { definirHerramienta } from "./definicion";

const CATEGORIAS = [
  "experiencias_por_persona",
  "experiencias_dos_personas",
  "hospedaje",
  "habitaciones",
  "menu",
  "politicas",
  "informacion_general",
] as const;

const clave = (texto: string): string => sinAcentos(texto).toLowerCase().trim();

export const consultarCatalogo = definirHerramienta({
  nombre: "consultar_catalogo",
  descripcion:
    "Devuelve los datos reales y vigentes del negocio: experiencias, hospedaje, habitaciones, menú de alimentación, políticas e información general (ubicación, horario de atención, redes). Es la única fuente válida de precios, de lo que incluye cada plan, de horarios y de políticas: llámala antes de mencionar cualquiera de esos datos. Sin `id` devuelve la categoría completa; con `id` devuelve solo ese elemento (en `menu`, el id es el de una categoría del menú).",
  esquema: z.object({
    categoria: z.enum(CATEGORIAS).describe("Qué parte del catálogo consultar."),
    id: z
      .string()
      .optional()
      .describe("Opcional. Id o nombre de un elemento, p. ej. 'aurea', 'romantico', o una categoría del menú como 'bebidas'."),
  }),
  async ejecutar(ctx, { categoria, id }) {
    const { catalogo, menu } = ctx.tenant;

    if (categoria === "informacion_general") {
      return { categoria, datos: catalogo.negocio ?? catalogo.spa ?? {} };
    }
    if (categoria === "politicas") {
      return { categoria, datos: catalogo.politicas };
    }

    if (categoria === "menu") {
      const general = { nota_general: menu.nota_general, moneda: menu.moneda, domicilios: menu.domicilios };
      if (menu.categorias.length === 0) {
        return { categoria, encontrado: false, detalle: "El menú no está cargado. Confírmalo con el equipo (notificar_humano)." };
      }
      if (!id) return { categoria, ...general, categorias: menu.categorias };
      const buscada = menu.categorias.find((c) => clave(c.id) === clave(id) || clave(c.nombre) === clave(id));
      if (!buscada) {
        return { categoria, encontrado: false, categorias_disponibles: menu.categorias.map((c) => ({ id: c.id, nombre: c.nombre })) };
      }
      return { categoria, ...general, datos: buscada };
    }

    const elementos: { id: string; nombre: string }[] = catalogo[categoria];
    if (!id) return { categoria, datos: elementos };
    const elemento = elementos.find((e) => clave(e.id) === clave(id) || clave(e.nombre) === clave(id));
    if (!elemento) {
      return {
        categoria,
        encontrado: false,
        detalle: "Ese elemento no existe en esta categoría. No lo inventes.",
        ids_disponibles: elementos.map((e) => e.id),
      };
    }
    return { categoria, datos: elemento };
  },
});
