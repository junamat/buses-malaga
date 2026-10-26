/**
 * Consumo de la API_REST para las capas de Buses y Paradas del mapa, y lógica
 * pura de presentación asociada (capa de infraestructura del `Frontend_Mapa`,
 * Requisito 2).
 *
 * Este módulo concentra las dos responsabilidades de datos de las capas, de
 * modo que `MapaBase.tsx` solo se ocupe de proyectar el resultado sobre Leaflet:
 *
 * - **Obtención de datos** (`fetchBuses`, `fetchParadas`): consume
 *   `GET /api/buses` y `GET /api/paradas`, que devuelven una `FeatureCollection`
 *   canónica (coordenadas `[lon, lat]`) más un cursor `next` de paginación
 *   (≤200 elementos por página; Requisito 11.3). Ambas funciones **siguen el
 *   cursor** hasta agotar las páginas, de forma que el consumidor recibe el
 *   conjunto completo. La API ya resuelve la captura más reciente por bus
 *   (Requisito 2.5), por lo que aquí no se vuelve a seleccionar.
 *
 * - **Lógica pura de obsolescencia** (`maxCaptureAgeMs`, `formatAge`,
 *   `describeStaleness`): deriva, a partir de las propiedades `captured_at` y
 *   `obsoleto` ya presentes en el GeoJSON (ver `lib/geojson.ts`), la antigüedad
 *   de los datos mostrados y su condición de obsoletos (Requisito 2.7). Es
 *   determinista: el instante de referencia `now` se inyecta, no se lee el reloj
 *   dentro de las funciones puras.
 *
 * Convención de coordenadas: la API entrega `[lon, lat]`; la conversión al
 * `[lat, lon]` que espera Leaflet se hace en el componente, en el borde.
 */

import type {
  BusFeatureProperties,
  LineaFeatureProperties,
  ParadaFeatureProperties,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  GeoJSONGeometry,
  GeoJSONLineString,
  GeoJSONPoint,
} from "@/lib/types";

/** Feature canónico de un Bus (`Point` + propiedades de bus). */
export type BusFeature = GeoJSONFeature<BusFeatureProperties, GeoJSONPoint>;

/** Feature canónico de una Parada (`Point` + propiedades de parada). */
export type ParadaFeature = GeoJSONFeature<ParadaFeatureProperties, GeoJSONPoint>;

/**
 * Feature canónico de una Línea (`LineString` + propiedades de línea). El
 * endpoint `GET /api/lineas` serializa la geometría como un `LineString` (sin
 * vértices en este hito; ver `app/api/lineas/route.ts`), por lo que la
 * geometría no se consume aquí: solo interesan las propiedades `codLinea` y
 * `nombre` para el catálogo del panel de filtros.
 */
export type LineaFeature = GeoJSONFeature<
  LineaFeatureProperties,
  GeoJSONLineString
>;

/**
 * Respuesta de los endpoints geográficos: una `FeatureCollection` canónica más
 * el cursor `next` de paginación (`null` cuando no hay más páginas).
 */
type PaginatedFeatureCollection<
  P,
  G extends GeoJSONGeometry = GeoJSONPoint,
> = GeoJSONFeatureCollection<P, G> & {
  next: string | null;
};

/**
 * Recorre todas las páginas de un endpoint geográfico siguiendo el cursor
 * `next` y devuelve la concatenación de sus features.
 *
 * El `path` es la ruta base del endpoint (p. ej. `/api/buses`); los filtros ya
 * resueltos se pasan en `params`. La paginación se añade con el parámetro
 * `cursor`; un `next === null` (o una página sin features) termina el recorrido.
 * Se impone un tope de páginas defensivo para no iterar indefinidamente si el
 * backend devolviera un cursor inconsistente.
 */
async function fetchAllPages<P, G extends GeoJSONGeometry = GeoJSONPoint>(
  path: string,
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<GeoJSONFeature<P, G>[]> {
  const MAX_PAGINAS = 1000;
  const features: GeoJSONFeature<P, G>[] = [];
  let cursor: string | null = null;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
    const query = new URLSearchParams(params);
    if (cursor !== null) {
      query.set("cursor", cursor);
    }
    const sufijo = query.toString();
    const url = sufijo === "" ? path : `${path}?${sufijo}`;

    const respuesta = await fetch(url, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!respuesta.ok) {
      throw new Error(
        `La petición a ${path} falló con estado ${respuesta.status}.`,
      );
    }

    const cuerpo = (await respuesta.json()) as PaginatedFeatureCollection<P, G>;
    features.push(...cuerpo.features);

    cursor = cuerpo.next ?? null;
    if (cursor === null) {
      break;
    }
  }

  return features;
}

/** Filtros de visualización aplicables a la consulta de buses (lógica AND). */
export interface BusFilter {
  /** Conjunto de líneas (`codLinea`) a mostrar; vacío/omitido ⇒ todas. */
  codLineas?: readonly number[];
  /** Sentido a mostrar; omitido ⇒ todos. */
  sentido?: number;
}

/** Construye los `URLSearchParams` de filtro para `GET /api/buses`. */
function busFilterParams(filtro: BusFilter | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (filtro?.codLineas && filtro.codLineas.length > 0) {
    params.set("codLinea", filtro.codLineas.join(","));
  }
  if (filtro?.sentido !== undefined) {
    params.set("sentido", String(filtro.sentido));
  }
  return params;
}

/**
 * Obtiene todas las posiciones de buses vigentes desde `GET /api/buses`,
 * siguiendo la paginación. La API ya devuelve la captura más reciente por bus
 * (Requisito 2.5). Los filtros por línea/sentido se aplican en el servidor.
 */
export async function fetchBuses(
  filtro?: BusFilter,
  signal?: AbortSignal,
): Promise<BusFeature[]> {
  return fetchAllPages<BusFeatureProperties>(
    "/api/buses",
    busFilterParams(filtro),
    signal,
  );
}

/**
 * Obtiene todas las paradas desde `GET /api/paradas`, siguiendo la paginación.
 * El filtro opcional por línea restringe a las paradas servidas por esa línea.
 */
export async function fetchParadas(
  codLinea?: number,
  signal?: AbortSignal,
): Promise<ParadaFeature[]> {
  const params = new URLSearchParams();
  if (codLinea !== undefined) {
    params.set("codLinea", String(codLinea));
  }
  return fetchAllPages<ParadaFeatureProperties>(
    "/api/paradas",
    params,
    signal,
  );
}

/**
 * Obtiene todas las Líneas desde `GET /api/lineas`, siguiendo la paginación.
 * Las Líneas son datos estáticos; el panel de filtros las usa como catálogo de
 * opciones seleccionables. La geometría `LineString` del endpoint no se
 * consume (ver `LineaFeature`); solo interesan las propiedades.
 */
export async function fetchLineasFeatures(
  signal?: AbortSignal,
): Promise<LineaFeature[]> {
  return fetchAllPages<LineaFeatureProperties, GeoJSONLineString>(
    "/api/lineas",
    new URLSearchParams(),
    signal,
  );
}

// ---------------------------------------------------------------------------
// Lógica pura de obsolescencia y antigüedad (Requisito 2.7)
// ---------------------------------------------------------------------------

/** Convierte una marca ISO-8601 o epoch ms a milisegundos epoch, o `NaN`. */
function toEpochMs(value: string | number): number {
  return typeof value === "number" ? value : Date.parse(value);
}

/**
 * Calcula la antigüedad (en ms) de la captura **más antigua** mostrada respecto
 * a `now`: la edad de los datos mostrados la marca el bus que lleva más tiempo
 * sin actualizarse. Devuelve `null` si no hay buses o ninguna marca es válida.
 *
 * Pura y determinista: `now` se inyecta (no se lee el reloj del sistema).
 */
export function maxCaptureAgeMs(
  buses: readonly BusFeature[],
  now: string | number,
): number | null {
  const nowMs = toEpochMs(now);
  if (Number.isNaN(nowMs)) {
    return null;
  }

  let maxAge: number | null = null;
  for (const bus of buses) {
    const capturedMs = toEpochMs(bus.properties.captured_at);
    if (Number.isNaN(capturedMs)) {
      continue;
    }
    const age = nowMs - capturedMs;
    if (maxAge === null || age > maxAge) {
      maxAge = age;
    }
  }
  return maxAge;
}

/** ¿Hay algún bus con la posición marcada como obsoleta en el GeoJSON? */
export function anyStale(buses: readonly BusFeature[]): boolean {
  return buses.some((bus) => bus.properties.obsoleto);
}

/**
 * Formatea una antigüedad en milisegundos como un texto legible breve en
 * español (p. ej. "45 s", "3 min", "1 h 5 min"). Antigüedades negativas (datos
 * con marca futura respecto a `now`) se tratan como `0 s`.
 */
export function formatAge(ageMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * Describe la condición de obsolescencia del conjunto de buses mostrado para el
 * aviso del Requisito 2.7. Devuelve `null` cuando no procede mostrar aviso
 * (sin buses, o ninguno obsoleto). Cuando hay datos obsoletos, devuelve el
 * mensaje con la antigüedad de los datos mostrados.
 *
 * Pura y determinista: `now` se inyecta.
 */
export function describeStaleness(
  buses: readonly BusFeature[],
  now: string | number,
): string | null {
  if (buses.length === 0 || !anyStale(buses)) {
    return null;
  }
  const age = maxCaptureAgeMs(buses, now);
  if (age === null) {
    return "Datos obsoletos: la última actualización de posiciones falló.";
  }
  return `Datos obsoletos (antigüedad: ${formatAge(age)}). La última actualización de posiciones falló.`;
}
