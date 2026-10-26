/**
 * Datos de apoyo del panel de filtros del mapa (capa de infraestructura del
 * `Frontend_Mapa`, Requisito 3).
 *
 * El panel de filtros compone sus criterios con la lógica pura de
 * `lib/filters.ts`, que aplica el estado de filtros sobre el **conjunto base**
 * de Buses y Paradas ya cargado en el cliente. Este módulo cubre las dos piezas
 * de datos que esa lógica necesita y que no viven en el conjunto base:
 *
 * - **Catálogo de Líneas** (`fetchLineas`): la lista de Líneas seleccionables
 *   por el usuario, obtenida de `GET /api/lineas`. Cada Línea aporta su
 *   `codLinea` y, si existe, un `nombre` legible para la etiqueta del control.
 *
 * - **Asociación Parada → Líneas** (`fetchParadaLineasLookup`): el filtro por
 *   Línea del Requisito 3.1 oculta también las Paradas no servidas por las
 *   Líneas seleccionadas. El GeoJSON de `GET /api/paradas` solo expone
 *   `codParada` y `nombre` (no las Líneas que atienden a cada Parada), de modo
 *   que la asociación se resuelve consultando `GET /api/paradas?codLinea=X` por
 *   cada Línea seleccionada: el endpoint devuelve exactamente las Paradas
 *   servidas por esa Línea. Con ese resultado se construye el
 *   `ParadaLineasLookup` puro que `lib/filters.apply` inyecta para filtrar
 *   Paradas sin dejar de delegar la semántica del filtro en el módulo puro.
 *
 * Mantener aquí estas consultas deja el componente libre de I/O y conserva la
 * separación entre obtención de datos y presentación que ya sigue
 * `./busLayerData`.
 */

import type { CodLinea, CodParada, Sentido } from "@/lib/types";
import type { ParadaLineasLookup } from "@/lib/filters";
import { fetchLineasFeatures, fetchParadas } from "./busLayerData";

/** Línea seleccionable en el control de filtro por Línea. */
export interface LineaOpcion {
  readonly codLinea: CodLinea;
  /** Nombre legible de la Línea, o `undefined` si el origen no lo aporta. */
  readonly nombre?: string;
  /**
   * Destinos legibles conocidos por Sentido para esta Línea (p. ej.
   * `{1: "San Andrés", 2: "El Palo"}`), derivados de los Features por Sentido
   * que expone `GET /api/lineas` (Requisito 2.8). Un Sentido sin Destino
   * conocido no aparece en el mapa. Vacío cuando la Línea no tiene Destinos.
   */
  readonly destinos: Readonly<Record<Sentido, string>>;
}

/**
 * Obtiene el catálogo de Líneas seleccionables desde `GET /api/lineas`,
 * ordenado por `codLinea` ascendente para una presentación estable. Descarta
 * Líneas sin `codLinea` numérico (no deberían existir, es una salvaguarda).
 *
 * El endpoint expone una Línea con Destinos como varios Features (uno por
 * Sentido con su `sentido` y `destino`); aquí se colapsan en una sola
 * `LineaOpcion` por `codLinea`, acumulando sus Destinos por Sentido. Una Línea
 * sin Destinos aparece como un único Feature sin `sentido`/`destino` y produce
 * una `LineaOpcion` con `destinos` vacío (Requisitos 2.8, 11.10).
 */
export async function fetchLineas(
  signal?: AbortSignal,
): Promise<LineaOpcion[]> {
  const features = await fetchLineasFeatures(signal);
  // codLinea → opción en construcción (con sus destinos por sentido mutables).
  const porCodLinea = new Map<
    CodLinea,
    { codLinea: CodLinea; nombre?: string; destinos: Record<Sentido, string> }
  >();
  for (const feature of features) {
    const { codLinea, nombre, sentido, destino } = feature.properties;
    if (typeof codLinea !== "number") {
      continue;
    }
    let opcion = porCodLinea.get(codLinea);
    if (opcion === undefined) {
      opcion = { codLinea, nombre, destinos: {} };
      porCodLinea.set(codLinea, opcion);
    } else if (opcion.nombre === undefined && nombre !== undefined) {
      // Conserva el primer nombre legible visto para la línea.
      opcion.nombre = nombre;
    }
    if (typeof sentido === "number" && destino !== undefined && destino !== "") {
      opcion.destinos[sentido] = destino;
    }
  }

  const opciones = [...porCodLinea.values()].map(
    (opcion): LineaOpcion => ({
      codLinea: opcion.codLinea,
      nombre: opcion.nombre,
      destinos: opcion.destinos,
    }),
  );
  opciones.sort((a, b) => a.codLinea - b.codLinea);
  return opciones;
}

/** Opción de Sentido ya resuelta para el control de filtro. */
export interface SentidoEtiqueta {
  readonly sentido: Sentido;
  /** Etiqueta base del Sentido (p. ej. "Ida", "Vuelta"). */
  readonly etiqueta: string;
  /**
   * Destino legible a mostrar junto al Sentido, o `undefined` si no hay uno
   * aplicable al conjunto de Líneas seleccionadas (Requisito 2.8).
   */
  readonly destino?: string;
}

/**
 * Resuelve el Destino legible a mostrar para cada Sentido del panel de filtros,
 * en función de las Líneas seleccionadas (Requisito 2.8).
 *
 * El control de Sentido es global (no por Línea), mientras que el Destino es
 * propio de cada `(codLinea, sentido)`. Para un Sentido dado se reúnen los
 * Destinos conocidos de las Líneas seleccionadas; solo cuando todas coinciden
 * en un único Destino se expone ese texto junto al Sentido. Si las Líneas
 * seleccionadas discrepan, o si no hay Línea seleccionada, o si ninguna aporta
 * Destino para ese Sentido, se devuelve solo la etiqueta base sin Destino
 * (comportamiento "Ida/Vuelta" previo). Función pura y determinista.
 */
export function resolverSentidosConDestino(
  sentidosBase: readonly SentidoEtiqueta[],
  lineas: readonly LineaOpcion[],
  lineasSeleccionadas: ReadonlySet<CodLinea>,
): SentidoEtiqueta[] {
  // Solo las Líneas seleccionadas aportan Destino; sin selección, no hay uno
  // aplicable y se conserva el comportamiento base.
  const seleccionadas = lineas.filter((linea) =>
    lineasSeleccionadas.has(linea.codLinea),
  );

  return sentidosBase.map((opcion) => {
    const destinos = new Set<string>();
    for (const linea of seleccionadas) {
      const destino = linea.destinos[opcion.sentido];
      if (destino !== undefined && destino !== "") {
        destinos.add(destino);
      }
    }
    // Un único Destino común ⇒ se muestra; discrepancia o ausencia ⇒ sin texto.
    if (destinos.size === 1) {
      return { ...opcion, destino: [...destinos][0] };
    }
    return { sentido: opcion.sentido, etiqueta: opcion.etiqueta };
  });
}

/**
 * Construye la consulta pura `ParadaLineasLookup` (Parada → Líneas) para el
 * conjunto de Líneas seleccionadas, resolviendo la asociación vía
 * `GET /api/paradas?codLinea=X` por cada Línea.
 *
 * El resultado es un `Map` de `codParada` al conjunto de Líneas seleccionadas
 * que la sirven; el lookup devuelto consulta ese `Map`. Las Líneas se
 * consultan en paralelo. Si no hay Líneas seleccionadas se devuelve un lookup
 * vacío: en ese caso `lib/filters.apply` no filtra Paradas por Línea, por lo
 * que el lookup no llega a invocarse.
 *
 * El lookup resultante es puro y determinista (no hace I/O): toda la obtención
 * de datos ocurre aquí, antes de devolverlo.
 */
export async function fetchParadaLineasLookup(
  codLineas: readonly CodLinea[],
  signal?: AbortSignal,
): Promise<ParadaLineasLookup> {
  if (codLineas.length === 0) {
    return () => [];
  }

  const paradaLineas = new Map<CodParada, Set<CodLinea>>();

  await Promise.all(
    codLineas.map(async (codLinea) => {
      const paradas = await fetchParadas(codLinea, signal);
      for (const parada of paradas) {
        const { codParada } = parada.properties;
        const lineas = paradaLineas.get(codParada);
        if (lineas === undefined) {
          paradaLineas.set(codParada, new Set([codLinea]));
        } else {
          lineas.add(codLinea);
        }
      }
    }),
  );

  return (parada) => paradaLineas.get(parada.codParada) ?? [];
}
