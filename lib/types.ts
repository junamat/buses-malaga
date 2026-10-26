/**
 * Tipos internos compartidos del dominio "Buses de Málaga".
 *
 * Estos tipos reflejan las entidades de dominio descritas en el diseño y son
 * independientes de la plataforma (no dependen de Supabase, Postgres ni de
 * ningún cliente concreto). Son la representación interna que las capas de
 * lógica pura manipulan antes de serializarse al GeoJSON canónico de salida.
 *
 * Convención de coordenadas: siempre numéricas y en orden `[lon, lat]`.
 */

/**
 * Sentido de una línea. La EMT modela dos sentidos de recorrido por línea.
 * Se representa como entero (p. ej. 1 = ida, 2 = vuelta) tal como aparece en
 * los datos de origen (`trips`, `bus_positions`, `shapes`).
 */
export type Sentido = number;

/**
 * Identificador de línea. Coincide con `route_id` del GTFS y es la clave de
 * join universal (`codLinea`).
 */
export type CodLinea = number;

/** Identificador de parada (`cod_parada`), textual en el origen GTFS. */
export type CodParada = string;

/** Identificador de vehículo (`cod_bus`). */
export type CodBus = number;

/**
 * Línea de autobús (entidad estática GTFS).
 */
export interface Linea {
  /** `route_id` del GTFS; clave de join universal. */
  codLinea: CodLinea;
  /** Nombre legible de la línea (de `routes.csv`: `route_short_name`). */
  nombre?: string;
}

/**
 * Parada de autobús (entidad estática GTFS).
 * Coordenadas numéricas en orden `[lon, lat]`.
 */
export interface Parada {
  codParada: CodParada;
  nombre: string;
  lon: number;
  lat: number;
}

/**
 * Posición de un bus ya resuelta para exponer (última captura por vehículo).
 * Coordenadas numéricas en orden `[lon, lat]`.
 */
export interface Bus {
  codBus: CodBus;
  codLinea: CodLinea;
  sentido: Sentido;
  lon: number;
  lat: number;
  /** Instante de la medición según la fuente (CSV `last_update`). */
  last_update: string;
  /** Instante de ingesta en el sistema. */
  captured_at: string;
}

/**
 * Captura cruda de la posición de un vehículo, tal como se ingiere y almacena
 * en `bus_positions`. Varias capturas por `codBus` coexisten dentro de la
 * ventana de retención; la lógica pura selecciona la más reciente por
 * `last_update`. Coordenadas numéricas en orden `[lon, lat]`.
 */
export interface PosicionCaptura {
  codBus: CodBus;
  codLinea: CodLinea;
  sentido: Sentido;
  lon: number;
  lat: number;
  /** Parada inicial reportada por la fuente (`cod_par_ini`). */
  codParIni?: CodParada;
  /** Instante de la medición según la fuente (CSV `last_update`). */
  last_update: string;
  /** Instante de ingesta en el sistema. */
  captured_at: string;
}

// ---------------------------------------------------------------------------
// Datos estáticos GTFS (recarga diaria)
// ---------------------------------------------------------------------------

/**
 * Fila normalizada de `routes`: una línea GTFS con su nombre legible.
 * `codLinea` es `route_id`, la clave de join universal.
 */
export interface RutaGtfs {
  codLinea: CodLinea;
  /** Nombre legible de la línea (del GTFS o reforzado desde el JSON de paradas). */
  nombre?: string;
}

/**
 * Fila normalizada de `trips`: un servicio que pertenece a una línea y tiene un
 * sentido. `tripId` es la clave primaria; `sentido` puede faltar en el origen.
 */
export interface ViajeGtfs {
  tripId: string;
  codLinea: CodLinea;
  sentido?: Sentido;
  /**
   * Letrero de destino legible del viaje (`trip_headsign` del GTFS), p. ej.
   * "San Andrés". Opcional: puede faltar en el origen. Es la base de la que se
   * deriva el Destino representativo por `(codLinea, sentido)` (ver
   * {@link DestinoGtfs}).
   */
  destino?: string;
}

/**
 * Destino representativo de un recorrido línea/sentido (entidad derivada de los
 * `trip_headsign` de los viajes GTFS). Se agrega por `(codLinea, sentido)`: el
 * headsign más frecuente entre los viajes de ese par, con los empates resueltos
 * por orden lexicográfico para que la derivación sea determinista. Un Bus
 * hereda su Destino de este par. Se persiste en la tabla `route_directions`.
 */
export interface DestinoGtfs {
  codLinea: CodLinea;
  sentido: Sentido;
  /** Letrero de destino legible (headsign representativo del GTFS). */
  destino: string;
}

/**
 * Fila normalizada de `stops`: una parada con nombre legible y coordenadas
 * numéricas en orden `[lon, lat]`. Coincide con {@link Parada}.
 */
export type ParadaGtfs = Parada;

/**
 * Fila normalizada de `stop_times`: el orden de una parada dentro de un viaje
 * (`stop_sequence`). Deriva el recorrido ordenado y las líneas por parada.
 */
export interface StopTimeGtfs {
  tripId: string;
  codParada: CodParada;
  stopSequence: number;
}

/**
 * Fila normalizada de `calendar_dates`: una excepción de servicio por línea y
 * fecha. `fecha` en formato `YYYY-MM-DD`.
 */
export interface ExcepcionCalendarioGtfs {
  codLinea: CodLinea;
  /** Fecha de la excepción en formato ISO `YYYY-MM-DD`. */
  fecha: string;
  /** Tipo de excepción GTFS (1 = servicio añadido, 2 = servicio retirado). */
  exceptionType: number;
}

/**
 * Recorrido normalizado de una línea/sentido: la secuencia ordenada de puntos
 * `[lon, lat]` con la que se reconstruye la LINESTRING PostGIS de `shapes`.
 * Una LINESTRING válida exige al menos dos puntos.
 */
export interface FormaGtfs {
  codLinea: CodLinea;
  sentido: Sentido;
  /** Puntos del recorrido en orden, cada uno numérico `[lon, lat]`. */
  puntos: Position[];
}

/**
 * Conjunto completo de datos estáticos GTFS ya normalizados, listo para que el
 * repositorio repueble las tablas estáticas en una sola recarga transaccional.
 * Es el modelo interno que produce `lib/gtfs.ts` a partir de los CSV de origen
 * y del JSON de paradas, independiente del transporte y de la plataforma.
 */
export interface GtfsDataset {
  routes: RutaGtfs[];
  trips: ViajeGtfs[];
  stops: ParadaGtfs[];
  stopTimes: StopTimeGtfs[];
  calendarDates: ExcepcionCalendarioGtfs[];
  shapes: FormaGtfs[];
  /**
   * Destinos representativos por `(codLinea, sentido)` derivados de los
   * `trip_headsign` de los viajes. Repueblan la tabla `route_directions` en la
   * misma recarga transaccional que el resto de tablas estáticas.
   */
  destinos: DestinoGtfs[];
}

/**
 * Tipo de favorito. Un favorito puede referenciar una parada, una línea o la
 * combinación de ambas (línea en una parada concreta).
 */
export type TipoFavorito = "parada" | "linea" | "parada_linea";

/**
 * Favorito de un usuario. Según `tipo`, estarán presentes `codParada`,
 * `codLinea` o ambos.
 */
export interface Favorito {
  id: string;
  userId: string;
  tipo: TipoFavorito;
  codParada?: CodParada;
  codLinea?: CodLinea;
}

/**
 * Aportación de un usuario sobre un vehículo concreto. La `opcion` pertenece a
 * un catálogo predefinido. La vigencia es `created_at` + 60 min.
 */
export interface Aportacion {
  id: string;
  userId: string;
  codBus: CodBus;
  /** Opción del catálogo predefinido de aportaciones. */
  opcion: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Estimación de llegada (ETA)
// ---------------------------------------------------------------------------

/**
 * Estimación de llegada del siguiente bus de una línea a una parada, por línea
 * y sentido. Es el resultado del `Estimador_ETA` (lógica pura en `lib/eta.ts`
 * sobre el map-matching PostGIS). El ETA es una estimación de mejor esfuerzo con
 * un margen de ±1 minuto (Requisitos 4.1, 4.4, 4.5, 4.7).
 */
export interface Eta {
  codLinea: CodLinea;
  sentido: Sentido;
  /**
   * Minutos enteros no negativos hasta la llegada estimada cuando
   * `disponible` es `true`; `null` cuando no hay estimación disponible
   * (Requisitos 4.3, 4.6).
   */
  minutos: number | null;
  /** Indica si hay una estimación disponible para esta línea/sentido. */
  disponible: boolean;
  /**
   * Margen de confianza en minutos de la estimación (±). Fijo en 1 min por el
   * diseño cuando hay estimación; se omite cuando no la hay (Requisito 4.7).
   */
  margenMinutos?: number;
  /**
   * Motivo por el que no hay estimación, cuando `disponible` es `false` (p. ej.
   * posición obsoleta o ningún bus dentro de la cota de 60 min). Presente solo
   * en el caso no disponible (Requisito 11.6).
   */
  motivo?: string;
}

// ---------------------------------------------------------------------------
// GeoJSON canónico de salida
// ---------------------------------------------------------------------------

/** Tipos de geometría GeoJSON soportados por la salida del sistema. */
export type GeoJSONGeometryType = "Point" | "LineString" | "MultiLineString";

/** Par de coordenadas numéricas en orden `[lon, lat]`. */
export type Position = [number, number];

export interface GeoJSONPoint {
  type: "Point";
  coordinates: Position;
}

export interface GeoJSONLineString {
  type: "LineString";
  coordinates: Position[];
}

export interface GeoJSONMultiLineString {
  type: "MultiLineString";
  coordinates: Position[][];
}

export type GeoJSONGeometry =
  | GeoJSONPoint
  | GeoJSONLineString
  | GeoJSONMultiLineString;

/**
 * Feature GeoJSON con propiedades tipadas por entidad. Las propiedades
 * dependen de la entidad representada (Bus, Parada o Linea).
 */
export interface GeoJSONFeature<
  P = Record<string, unknown>,
  G extends GeoJSONGeometry = GeoJSONGeometry,
> {
  type: "Feature";
  geometry: G;
  properties: P;
}

/**
 * Colección de features GeoJSON. Es el modelo de salida canónico de las
 * respuestas geográficas de la API.
 */
export interface GeoJSONFeatureCollection<
  P = Record<string, unknown>,
  G extends GeoJSONGeometry = GeoJSONGeometry,
> {
  type: "FeatureCollection";
  features: GeoJSONFeature<P, G>[];
}

/** Propiedades del Feature de un Bus en el GeoJSON canónico. */
export interface BusFeatureProperties {
  codBus: CodBus;
  codLinea: CodLinea;
  sentido: Sentido;
  last_update: string;
  captured_at: string;
  /** Indicador de obsolescencia derivado de la antigüedad de la captura. */
  obsoleto: boolean;
  /**
   * Destino legible heredado del `(codLinea, sentido)` del Bus. Se omite la
   * propiedad cuando ese par no tiene Destino conocido (Requisitos 2.8, 11.10).
   */
  destino?: string;
}

/** Propiedades del Feature de una Parada en el GeoJSON canónico. */
export interface ParadaFeatureProperties {
  codParada: CodParada;
  nombre: string;
}

/**
 * Propiedades del Feature de una parada cercana: las de una parada más la
 * distancia en metros al punto del usuario (Requisito 6.6).
 */
export interface ParadaCercanaFeatureProperties extends ParadaFeatureProperties {
  distanciaMetros: number;
}

/** Propiedades del Feature de una Linea en el GeoJSON canónico. */
export interface LineaFeatureProperties {
  codLinea: CodLinea;
  nombre?: string;
  sentido?: Sentido;
  /**
   * Destino legible del `(codLinea, sentido)` del Feature. Se omite la
   * propiedad cuando ese par no tiene Destino conocido (Requisitos 2.8, 11.10).
   */
  destino?: string;
}
