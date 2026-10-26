/**
 * Adaptador `Repository` sobre Postgres estándar (driver `pg`).
 *
 * Única implementación del puerto {@link Repository} para los tres modos de
 * ejecución (`supabase-cloud`, `supabase-local`, `local-postgres`). La lógica
 * SQL/PostGIS es portable —PostGIS es idéntico en los tres backends— y lo único
 * que varía por modo es la cadena de conexión inyectada según
 * `BACKEND_PROVIDER` (ver `lib/config.ts`). Por eso este adaptador no conoce el
 * modo: recibe un `databaseUrl` y abre un pool de conexiones estándar.
 *
 * Organización del módulo:
 *
 * - **Helpers puros** (constructores de SQL y mapeadores de fila a modelo
 *   interno): sin I/O, verificables de forma aislada con tests unitarios sin
 *   base de datos. Concentran la traducción fila ⇄ dominio y el orden de los
 *   parámetros, que es donde se cometen los errores sutiles.
 * - **`PostgresRepository`**: implementa cada método del puerto ejecutando el
 *   SQL construido por los helpers contra el pool.
 * - **`createPostgresRepository`**: factoría fina que construye el pool y
 *   devuelve el repositorio como el puerto `Repository`.
 *
 * Convención de coordenadas: numéricas y en orden `[lon, lat]`, coherente con
 * el GeoJSON canónico de salida y con el resto del sistema (`lib/types.ts`).
 *
 * Nombres de tablas/columnas alineados con `db/migrations/0001_*.sql`
 * (`routes`, `trips`, `stops`, `stop_times`, `shapes`, `bus_positions`,
 * `official_minutes`, `ingest_log`) y con el modelo de datos del diseño para
 * las tablas de usuario (`favorites`, `vehicle_contributions`), que se crean en
 * una migración posterior (Hito 3, tarea 12.1).
 */

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

import type {
  Repository,
  FiltroPosiciones,
  Paginacion,
  Pagina,
  ParadaCercana,
  NuevaAportacion,
  NuevoFavorito,
  IngestResult,
} from "@/lib/ports";
import type {
  Aportacion,
  Bus,
  CodBus,
  CodLinea,
  DestinoGtfs,
  ExcepcionCalendarioGtfs,
  Favorito,
  FormaGtfs,
  GtfsDataset,
  Linea,
  Parada,
  ParadaGtfs,
  PosicionCaptura,
  RutaGtfs,
  StopTimeGtfs,
  TipoFavorito,
  ViajeGtfs,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Constantes de paginación
// ---------------------------------------------------------------------------

/** Tamaño de página por defecto cuando el llamante no indica `limite`. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Tope duro de elementos por página (Requisito de paginación: máx. 200). */
export const MAX_PAGE_LIMIT = 200;

/** Vigencia de una aportación en segundos (60 min, diseño §Servicio_Aportaciones). */
export const APORTACION_VIGENCIA_SEGUNDOS = 60 * 60;

// ---------------------------------------------------------------------------
// Helpers puros: paginación por offset
// ---------------------------------------------------------------------------

/**
 * Normaliza el `limite` solicitado al rango válido `[1, MAX_PAGE_LIMIT]`,
 * aplicando el valor por defecto cuando se omite o no es un entero positivo.
 */
export function normalizeLimit(limite?: number): number {
  if (limite === undefined || !Number.isFinite(limite) || limite <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  // Un valor positivo pero subnormal (p. ej. 5e-324) se trunca a 0 al aplicar
  // `floor`; se garantiza un mínimo de 1 para no violar el rango válido.
  const truncado = Math.max(1, Math.floor(limite));
  return Math.min(truncado, MAX_PAGE_LIMIT);
}

/**
 * Interpreta un cursor opaco como offset entero no negativo. El cursor es la
 * representación textual del offset de la página siguiente; cualquier valor
 * ausente o no parseable se trata como el inicio (offset 0).
 */
export function parseOffsetCursor(cursor?: string | null): number {
  if (cursor === undefined || cursor === null || cursor === "") {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Construye una `Pagina<T>` a partir de las filas devueltas. Se pide una fila
 * de más (`limite + 1`) para saber si existe página siguiente sin una consulta
 * de conteo: si llegan más de `limite` filas, se recorta el excedente y se
 * emite el cursor al siguiente offset; en caso contrario `next` es `null`.
 */
export function buildPagina<T>(
  rows: T[],
  limite: number,
  offset: number,
): Pagina<T> {
  if (rows.length > limite) {
    const items = rows.slice(0, limite);
    return { items, next: String(offset + limite) };
  }
  return { items: rows, next: null };
}

// ---------------------------------------------------------------------------
// Helpers puros: mapeo fila → modelo interno
// ---------------------------------------------------------------------------

/** Convierte a número tolerando valores `string` de ciertos tipos de `pg`. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return Number(value);
}

/** Convierte `timestamptz` (string o `Date`) a ISO-8601 en texto. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Convierte un valor nullable a `CodParada` opcional. */
function toOptionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/** Convierte un valor nullable a número opcional. */
function toOptionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : toNumber(value);
}

export interface LineaRow extends QueryResultRow {
  route_id: number | string;
  nombre: string | null;
}

export function mapLinea(row: LineaRow): Linea {
  return {
    codLinea: toNumber(row.route_id),
    nombre: row.nombre === null ? undefined : row.nombre,
  };
}

export interface ParadaRow extends QueryResultRow {
  cod_parada: string;
  nombre: string;
  lon: number | string;
  lat: number | string;
}

export function mapParada(row: ParadaRow): Parada {
  return {
    codParada: String(row.cod_parada),
    nombre: row.nombre,
    lon: toNumber(row.lon),
    lat: toNumber(row.lat),
  };
}

export interface ParadaCercanaRow extends ParadaRow {
  distancia_metros: number | string;
}

export function mapParadaCercana(row: ParadaCercanaRow): ParadaCercana {
  return {
    ...mapParada(row),
    distanciaMetros: toNumber(row.distancia_metros),
  };
}

export interface BusRow extends QueryResultRow {
  cod_bus: number | string;
  cod_linea: number | string;
  sentido: number | string | null;
  lon: number | string;
  lat: number | string;
  last_update: string | Date;
  captured_at: string | Date;
}

export function mapBus(row: BusRow): Bus {
  return {
    codBus: toNumber(row.cod_bus),
    codLinea: toNumber(row.cod_linea),
    sentido: toNumber(row.sentido),
    lon: toNumber(row.lon),
    lat: toNumber(row.lat),
    last_update: toIso(row.last_update),
    captured_at: toIso(row.captured_at),
  };
}

export interface FavoritoRow extends QueryResultRow {
  id: string;
  user_id: string;
  tipo: string;
  cod_parada: string | null;
  cod_linea: number | string | null;
}

export function mapFavorito(row: FavoritoRow): Favorito {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tipo: row.tipo as TipoFavorito,
    codParada: toOptionalString(row.cod_parada),
    codLinea: toOptionalNumber(row.cod_linea),
  };
}

export interface AportacionRow extends QueryResultRow {
  id: string;
  user_id: string;
  cod_bus: number | string;
  opcion: string;
  created_at: string | Date;
}

export function mapAportacion(row: AportacionRow): Aportacion {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    codBus: toNumber(row.cod_bus),
    opcion: row.opcion,
    created_at: toIso(row.created_at),
  };
}

export interface DestinoRow extends QueryResultRow {
  route_id: number | string;
  sentido: number | string;
  destino: string;
}

export function mapDestino(row: DestinoRow): DestinoGtfs {
  return {
    codLinea: toNumber(row.route_id),
    sentido: toNumber(row.sentido),
    destino: row.destino,
  };
}

// ---------------------------------------------------------------------------
// Helpers puros: construcción de sentencias SQL parametrizadas
// ---------------------------------------------------------------------------

/** Sentencia SQL lista para ejecutar: texto y parámetros posicionales. */
export interface SqlStatement {
  text: string;
  params: unknown[];
}

/**
 * SQL de `listLineas`: lista de líneas paginada por offset. Pide `limite + 1`
 * filas para detectar la página siguiente.
 */
export function buildListLineasSql(limite: number, offset: number): SqlStatement {
  return {
    text:
      "SELECT route_id, nombre FROM routes " +
      "ORDER BY route_id ASC LIMIT $1 OFFSET $2",
    params: [limite + 1, offset],
  };
}

/**
 * SQL de `listParadas`: paginada y, si se indica `codLinea`, restringida a las
 * paradas servidas por esa línea (vía `trips`/`stop_times`). Sin filtro,
 * recorre todas las paradas ordenadas por `cod_parada`.
 */
export function buildListParadasSql(
  filtro: { codLinea?: number } | undefined,
  limite: number,
  offset: number,
): SqlStatement {
  if (filtro?.codLinea !== undefined) {
    return {
      text:
        "SELECT DISTINCT s.cod_parada, s.nombre, s.lon, s.lat FROM stops s " +
        "JOIN stop_times st ON st.stop_id = s.cod_parada " +
        "JOIN trips t ON t.trip_id = st.trip_id " +
        "WHERE t.route_id = $1 " +
        "ORDER BY s.cod_parada ASC LIMIT $2 OFFSET $3",
      params: [filtro.codLinea, limite + 1, offset],
    };
  }
  return {
    text:
      "SELECT cod_parada, nombre, lon, lat FROM stops " +
      "ORDER BY cod_parada ASC LIMIT $1 OFFSET $2",
    params: [limite + 1, offset],
  };
}

/**
 * SQL de `findParadasCercanas`: paradas dentro de `radioMetros` del punto
 * `[lon, lat]`, ordenadas por distancia geodésica ascendente, con la distancia
 * en metros. Usa geografía PostGIS (`ST_DWithin`/`ST_Distance` sobre
 * `geography`), portable entre los tres backends. El punto se construye en
 * orden `[lon, lat]` como exige `ST_MakePoint` (X = lon, Y = lat).
 */
export function buildFindParadasCercanasSql(
  lon: number,
  lat: number,
  radioMetros: number,
  limite: number,
): SqlStatement {
  return {
    text:
      "SELECT s.cod_parada, s.nombre, s.lon, s.lat, " +
      "ST_Distance(" +
      "ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326)::geography, " +
      "ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography" +
      ") AS distancia_metros " +
      "FROM stops s " +
      "WHERE ST_DWithin(" +
      "ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326)::geography, " +
      "ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3" +
      ") " +
      "ORDER BY distancia_metros ASC LIMIT $4",
    params: [lon, lat, radioMetros, limite],
  };
}

/**
 * Ventana (en segundos) que define qué vehículos siguen "en servicio" respecto
 * a la **última ingesta** registrada (`max(captured_at)`). Cada ciclo inserta
 * todos los buses que publica la fuente con el mismo `captured_at`; un bus
 * ausente de los ciclos recientes ha dejado de prestar servicio y no debe
 * mostrarse aunque su captura siga dentro de la ventana de retención de 6 h.
 * 150 s ≈ 2 ciclos de 60 s más margen: tolera que la fuente omita un bus en un
 * ciclo aislado sin que parpadee en el mapa.
 *
 * Se mide contra la última ingesta y no contra `now()` a propósito: si la
 * ingesta falla, la última tanda sigue visible (marcada como obsoleta por su
 * `captured_at`), que es justo lo que pide el Requisito 2.7.
 */
export const VENTANA_SERVICIO_SEGUNDOS = 150;

/**
 * SQL de `listBuses`: posición vigente de cada vehículo en servicio (la captura
 * de `last_update` máximo por `cod_bus`, con `captured_at` como desempate), con
 * filtros AND opcionales por conjunto de líneas y por sentido (Requisito 3.3).
 *
 * 1. Solo se consideran capturas de la última tanda de ingesta (ver
 *    {@link VENTANA_SERVICIO_SEGUNDOS}).
 * 2. La última captura por vehículo se resuelve con `DISTINCT ON (cod_bus)`
 *    ordenando por `last_update DESC, captured_at DESC`, coherente con el
 *    desempate determinista de `lib/positions.ts`.
 * 3. Los filtros se aplican **después** de elegir la última captura: filtrar
 *    antes devolvería, para un bus que cambió de sentido o línea, una captura
 *    antigua que sí cumplía el filtro.
 */
export function buildListBusesSql(
  filtro: FiltroPosiciones | undefined,
  limite: number,
  offset: number,
): SqlStatement {
  const params: unknown[] = [VENTANA_SERVICIO_SEGUNDOS];
  const conds: string[] = [];

  if (filtro?.codLineas !== undefined && filtro.codLineas.length > 0) {
    params.push(filtro.codLineas);
    conds.push(`cod_linea = ANY($${params.length}::bigint[])`);
  }
  if (filtro?.sentido !== undefined) {
    params.push(filtro.sentido);
    conds.push(`sentido = $${params.length}`);
  }

  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")} ` : "";

  params.push(limite + 1);
  const limitPlaceholder = `$${params.length}`;
  params.push(offset);
  const offsetPlaceholder = `$${params.length}`;

  const text =
    "SELECT cod_bus, cod_linea, sentido, lon, lat, last_update, captured_at FROM (" +
    "SELECT DISTINCT ON (bp.cod_bus) " +
    "bp.cod_bus, bp.cod_linea, bp.sentido, bp.lon, bp.lat, bp.last_update, bp.captured_at " +
    "FROM bus_positions bp " +
    "WHERE bp.captured_at >= " +
    "(SELECT max(captured_at) FROM bus_positions) - make_interval(secs => $1) " +
    "ORDER BY bp.cod_bus, bp.last_update DESC, bp.captured_at DESC" +
    ") latest " +
    where +
    `ORDER BY cod_bus ASC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`;

  return { text, params };
}

/**
 * SQL de `listDestinos`: Destinos por `(route_id, sentido)` de
 * `route_directions`, opcionalmente restringidos a un conjunto de líneas. Sin
 * filtro (o con un conjunto vacío) devuelve todos los destinos conocidos. El
 * orden por `(route_id, sentido)` ascendente hace el resultado estable para que
 * el llamador construya un mapa determinista. (Requisitos 2.8, 11.10)
 */
export function buildListDestinosSql(filtro?: {
  codLineas?: CodLinea[];
}): SqlStatement {
  if (filtro?.codLineas !== undefined && filtro.codLineas.length > 0) {
    return {
      text:
        "SELECT route_id, sentido, destino FROM route_directions " +
        "WHERE route_id = ANY($1::bigint[]) " +
        "ORDER BY route_id ASC, sentido ASC",
      params: [filtro.codLineas],
    };
  }
  return {
    text:
      "SELECT route_id, sentido, destino FROM route_directions " +
      "ORDER BY route_id ASC, sentido ASC",
    params: [],
  };
}

/**
 * SQL de `insertPosiciones`: inserción múltiple en `bus_positions` con una sola
 * sentencia (desenrollando `unnest` sobre arrays columnares). Devuelve `null`
 * cuando no hay capturas que insertar.
 */
export function buildInsertPosicionesSql(
  capturas: PosicionCaptura[],
): SqlStatement | null {
  if (capturas.length === 0) {
    return null;
  }

  const codBus: number[] = [];
  const codLinea: number[] = [];
  const sentido: number[] = [];
  const lon: number[] = [];
  const lat: number[] = [];
  const codParIni: (string | null)[] = [];
  const lastUpdate: string[] = [];
  const capturedAt: string[] = [];

  for (const c of capturas) {
    codBus.push(c.codBus);
    codLinea.push(c.codLinea);
    sentido.push(c.sentido);
    lon.push(c.lon);
    lat.push(c.lat);
    codParIni.push(c.codParIni ?? null);
    lastUpdate.push(c.last_update);
    capturedAt.push(c.captured_at);
  }

  return {
    text:
      "INSERT INTO bus_positions " +
      "(cod_bus, cod_linea, sentido, lon, lat, cod_par_ini, last_update, captured_at) " +
      "SELECT * FROM unnest(" +
      "$1::bigint[], $2::bigint[], $3::integer[], " +
      "$4::double precision[], $5::double precision[], " +
      "$6::text[], $7::timestamptz[], $8::timestamptz[])",
    params: [
      codBus,
      codLinea,
      sentido,
      lon,
      lat,
      codParIni,
      lastUpdate,
      capturedAt,
    ],
  };
}

/**
 * SQL de `purgePosicionesAntiguas`: elimina las capturas cuya antigüedad supera
 * la ventana de retención (en segundos) medida contra `now()` sobre
 * `last_update` (Requisito 12.6). `$1` son los segundos de la ventana.
 */
export function buildPurgePosicionesSql(ventanaSegundos: number): SqlStatement {
  return {
    text:
      "DELETE FROM bus_positions " +
      "WHERE last_update < now() - make_interval(secs => $1)",
    params: [ventanaSegundos],
  };
}

// ---------------------------------------------------------------------------
// Helpers puros: recarga GTFS (repoblado de tablas estáticas)
// ---------------------------------------------------------------------------

/**
 * Orden de borrado de las tablas estáticas GTFS antes de repoblarlas. Respeta
 * las claves foráneas (`ON DELETE CASCADE` en el esquema): se borran primero las
 * tablas hijas y al final las padres (`routes`, `stops`). `route_directions`
 * referencia a `routes`, por lo que se borra antes que ella. `bus_positions` no
 * se toca: la recarga GTFS solo afecta a los datos estáticos.
 */
export const ORDEN_BORRADO_GTFS = [
  "stop_times",
  "shapes",
  "calendar_dates",
  "route_directions",
  "trips",
  "stops",
  "routes",
] as const;

/**
 * SQL de inserción múltiple de `routes` vía `unnest`. Devuelve `null` si no hay
 * filas. `nombre` admite `null` (línea sin nombre legible).
 */
export function buildInsertRoutesSql(routes: RutaGtfs[]): SqlStatement | null {
  if (routes.length === 0) {
    return null;
  }
  const routeId: number[] = [];
  const nombre: (string | null)[] = [];
  for (const r of routes) {
    routeId.push(r.codLinea);
    nombre.push(r.nombre ?? null);
  }
  return {
    text:
      "INSERT INTO routes (route_id, nombre) " +
      "SELECT * FROM unnest($1::bigint[], $2::text[])",
    params: [routeId, nombre],
  };
}

/**
 * SQL de inserción múltiple de `stops` vía `unnest`. Coordenadas numéricas en
 * orden `[lon, lat]`, coherentes con el esquema y el GeoJSON de salida.
 */
export function buildInsertStopsSql(stops: ParadaGtfs[]): SqlStatement | null {
  if (stops.length === 0) {
    return null;
  }
  const codParada: string[] = [];
  const nombre: string[] = [];
  const lon: number[] = [];
  const lat: number[] = [];
  for (const s of stops) {
    codParada.push(s.codParada);
    nombre.push(s.nombre);
    lon.push(s.lon);
    lat.push(s.lat);
  }
  return {
    text:
      "INSERT INTO stops (cod_parada, nombre, lon, lat) " +
      "SELECT * FROM unnest($1::text[], $2::text[], " +
      "$3::double precision[], $4::double precision[])",
    params: [codParada, nombre, lon, lat],
  };
}

/**
 * SQL de inserción múltiple de `trips` vía `unnest`. `sentido` admite `null`.
 * Las filas cuyo `route_id` no exista en `routes` las rechaza la FK; el llamador
 * normaliza antes para evitarlo.
 */
export function buildInsertTripsSql(trips: ViajeGtfs[]): SqlStatement | null {
  if (trips.length === 0) {
    return null;
  }
  const tripId: string[] = [];
  const routeId: number[] = [];
  const sentido: (number | null)[] = [];
  for (const t of trips) {
    tripId.push(t.tripId);
    routeId.push(t.codLinea);
    sentido.push(t.sentido ?? null);
  }
  return {
    text:
      "INSERT INTO trips (trip_id, route_id, sentido) " +
      "SELECT * FROM unnest($1::text[], $2::bigint[], $3::integer[])",
    params: [tripId, routeId, sentido],
  };
}

/** SQL de inserción múltiple de `stop_times` vía `unnest`. */
export function buildInsertStopTimesSql(
  stopTimes: StopTimeGtfs[],
): SqlStatement | null {
  if (stopTimes.length === 0) {
    return null;
  }
  const tripId: string[] = [];
  const stopId: string[] = [];
  const stopSequence: number[] = [];
  for (const st of stopTimes) {
    tripId.push(st.tripId);
    stopId.push(st.codParada);
    stopSequence.push(st.stopSequence);
  }
  return {
    text:
      "INSERT INTO stop_times (trip_id, stop_id, stop_sequence) " +
      "SELECT * FROM unnest($1::text[], $2::text[], $3::integer[])",
    params: [tripId, stopId, stopSequence],
  };
}

/** SQL de inserción múltiple de `calendar_dates` vía `unnest`. */
export function buildInsertCalendarDatesSql(
  calendarDates: ExcepcionCalendarioGtfs[],
): SqlStatement | null {
  if (calendarDates.length === 0) {
    return null;
  }
  const routeId: number[] = [];
  const fecha: string[] = [];
  const exceptionType: number[] = [];
  for (const c of calendarDates) {
    routeId.push(c.codLinea);
    fecha.push(c.fecha);
    exceptionType.push(c.exceptionType);
  }
  return {
    text:
      "INSERT INTO calendar_dates (route_id, fecha, exception_type) " +
      "SELECT * FROM unnest($1::bigint[], $2::date[], $3::integer[])",
    params: [routeId, fecha, exceptionType],
  };
}

/**
 * SQL de inserción múltiple de `shapes`, reconstruyendo `geom_linestring` como
 * PostGIS LINESTRING (SRID 4326) desde los puntos de cada recorrido.
 *
 * Cada recorrido se envía como un array plano de coordenadas intercaladas
 * `[lon0, lat0, lon1, lat1, ...]` junto a su número de puntos, de modo que el
 * SQL pueda reagrupar los pares sin arrays anidados (que `unnest` no desenrolla
 * directamente). La LINESTRING se construye con `ST_MakeLine` sobre los puntos
 * `ST_SetSRID(ST_MakePoint(lon, lat), 4326)` en orden, portable entre los tres
 * backends PostGIS. Devuelve `null` si no hay recorridos.
 */
export function buildInsertShapesSql(shapes: FormaGtfs[]): SqlStatement | null {
  if (shapes.length === 0) {
    return null;
  }

  const valores: string[] = [];
  const params: unknown[] = [];

  for (const forma of shapes) {
    // Aplana los puntos a [lon0, lat0, lon1, lat1, ...] para un único parámetro
    // de array por recorrido. PostGIS reconstruye los pares con generate_series.
    const coords: number[] = [];
    for (const [lon, lat] of forma.puntos) {
      coords.push(lon, lat);
    }

    params.push(forma.codLinea);
    const pRoute = `$${params.length}`;
    params.push(forma.sentido);
    const pSentido = `$${params.length}`;
    params.push(coords);
    // El array de coordenadas se castea explícitamente a `double precision[]`:
    // sin el cast, Postgres no puede inferir el tipo de elemento del parámetro
    // (se envía como array sin anotar) y falla con "could not determine
    // polymorphic type". El cast se aplica en cada uso del parámetro.
    const pCoords = `$${params.length}::double precision[]`;

    // Reagrupa el array plano en puntos (índices impares = lon, pares = lat en
    // base 1) y construye la LINESTRING ordenada.
    valores.push(
      `(${pRoute}::bigint, ${pSentido}::integer, ` +
        `(SELECT ST_SetSRID(ST_MakeLine(` +
        `ST_MakePoint((${pCoords})[i], (${pCoords})[i + 1]) ORDER BY i` +
        `), 4326) ` +
        `FROM generate_series(1, array_length(${pCoords}, 1) - 1, 2) AS i))`,
    );
  }

  return {
    text:
      "INSERT INTO shapes (route_id, sentido, geom_linestring) VALUES " +
      valores.join(", "),
    params,
  };
}

/**
 * SQL de inserción múltiple de `route_directions` vía `unnest`: el Destino
 * representativo por `(route_id, sentido)` derivado del GTFS. Devuelve `null`
 * si no hay destinos. La FK sobre `route_id` rechaza pares sin línea en
 * `routes`; el llamador deriva los destinos desde los mismos trips que repueblan
 * `routes`, por lo que no se produce. (Requisito 2.8)
 */
export function buildInsertRouteDirectionsSql(
  destinos: DestinoGtfs[],
): SqlStatement | null {
  if (destinos.length === 0) {
    return null;
  }
  const routeId: number[] = [];
  const sentido: number[] = [];
  const destino: string[] = [];
  for (const d of destinos) {
    routeId.push(d.codLinea);
    sentido.push(d.sentido);
    destino.push(d.destino);
  }
  return {
    text:
      "INSERT INTO route_directions (route_id, sentido, destino) " +
      "SELECT * FROM unnest($1::bigint[], $2::integer[], $3::text[])",
    params: [routeId, sentido, destino],
  };
}

/** SQL de `listFavoritos`: favoritos de un usuario, orden estable por `id`. */
export function buildListFavoritosSql(userId: string): SqlStatement {
  return {
    text:
      "SELECT id, user_id, tipo, cod_parada, cod_linea FROM favorites " +
      "WHERE user_id = $1 ORDER BY id ASC",
    params: [userId],
  };
}

/**
 * SQL de `createFavorito`: alta de favorito. El `id` lo genera la base de datos
 * (`gen_random_uuid()`/`DEFAULT`); se devuelve la fila insertada.
 */
export function buildCreateFavoritoSql(fav: NuevoFavorito): SqlStatement {
  return {
    text:
      "INSERT INTO favorites (user_id, tipo, cod_parada, cod_linea) " +
      "VALUES ($1, $2, $3, $4) " +
      "RETURNING id, user_id, tipo, cod_parada, cod_linea",
    params: [fav.userId, fav.tipo, fav.codParada ?? null, fav.codLinea ?? null],
  };
}

/**
 * SQL de `deleteFavorito`: baja por `id` restringida al `user_id` dueño (la baja
 * es idempotente: no es error que no exista).
 */
export function buildDeleteFavoritoSql(
  userId: string,
  id: string,
): SqlStatement {
  return {
    text: "DELETE FROM favorites WHERE user_id = $1 AND id = $2",
    params: [userId, id],
  };
}

/**
 * SQL de `listAportacionesVigentes`: aportaciones de un vehículo dentro de la
 * ventana de vigencia de 60 min (`created_at` > now() − ventana), más recientes
 * primero (Requisito 9.3, 9.6).
 */
export function buildListAportacionesVigentesSql(
  codBus: CodBus,
): SqlStatement {
  return {
    text:
      "SELECT id, user_id, cod_bus, opcion, created_at FROM vehicle_contributions " +
      "WHERE cod_bus = $1 AND created_at > now() - make_interval(secs => $2) " +
      "ORDER BY created_at DESC",
    params: [codBus, APORTACION_VIGENCIA_SEGUNDOS],
  };
}

/**
 * SQL de `createAportacion`: alta de aportación. El `id` y `created_at` los
 * asigna la base de datos; se devuelve la fila insertada.
 */
export function buildCreateAportacionSql(
  aportacion: NuevaAportacion,
): SqlStatement {
  return {
    text:
      "INSERT INTO vehicle_contributions (user_id, cod_bus, opcion) " +
      "VALUES ($1, $2, $3) " +
      "RETURNING id, user_id, cod_bus, opcion, created_at",
    params: [aportacion.userId, aportacion.codBus, aportacion.opcion],
  };
}

/**
 * SQL de `logIngesta`: inserta una fila en `ingest_log` con la fuente, el
 * estado (`ok`/`fallo`) y el instante de ejecución (`run_at`). La columna
 * `fuente` es `NOT NULL` en el esquema; cuando el `IngestResult` no la aporta
 * (p. ej. el ciclo de purga, que no tiene fuente externa) se usa el nombre del
 * `job` como fuente, de modo que el registro siga identificando el ciclo
 * afectado (Requisito 12.5). `run_at` se toma del propio resultado para que el
 * instante coincida con la ejecución del ciclo.
 */
export function buildLogIngestaSql(result: IngestResult): SqlStatement {
  const fuente = result.fuente ?? result.job;
  return {
    text:
      "INSERT INTO ingest_log (fuente, estado, run_at) VALUES ($1, $2, $3)",
    params: [fuente, result.estado, result.runAt],
  };
}

// ---------------------------------------------------------------------------
// Repositorio Postgres
// ---------------------------------------------------------------------------

/**
 * Abstracción mínima del cliente de consultas que necesita el repositorio.
 * `pg.Pool` la satisface; también la satisface cualquier doble en tests, de
 * modo que la clase no queda acoplada al `Pool` concreto.
 */
export interface QueryClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;

  /**
   * Ejecuta `fn` dentro de una transacción sobre una **única** conexión, de modo
   * que un fallo revierta todo lo escrito (atomicidad de la recarga GTFS). El
   * `QueryClient` que se pasa a `fn` debe emitir sus consultas por esa misma
   * conexión. Opcional: si el cliente no lo implementa (p. ej. un doble de
   * test), el repositorio degrada a ejecución secuencial sin transacción.
   */
  withTransaction?<T>(fn: (tx: QueryClient) => Promise<T>): Promise<T>;
}

/**
 * Implementación del puerto {@link Repository} sobre un cliente de consultas
 * Postgres. Toda la lógica SQL/PostGIS vive en los helpers puros de arriba;
 * aquí solo se ejecuta y se mapea el resultado al modelo interno.
 */
export class PostgresRepository implements Repository {
  constructor(private readonly client: QueryClient) {}

  async listLineas(pagina?: Paginacion): Promise<Pagina<Linea>> {
    const limite = normalizeLimit(pagina?.limite);
    const offset = parseOffsetCursor(pagina?.cursor);
    const { text, params } = buildListLineasSql(limite, offset);
    const { rows } = await this.client.query<LineaRow>(text, params);
    return buildPagina(rows.map(mapLinea), limite, offset);
  }

  async listParadas(
    filtro?: { codLinea?: number },
    pagina?: Paginacion,
  ): Promise<Pagina<Parada>> {
    const limite = normalizeLimit(pagina?.limite);
    const offset = parseOffsetCursor(pagina?.cursor);
    const { text, params } = buildListParadasSql(filtro, limite, offset);
    const { rows } = await this.client.query<ParadaRow>(text, params);
    return buildPagina(rows.map(mapParada), limite, offset);
  }

  async findParadasCercanas(
    lon: number,
    lat: number,
    radioMetros: number,
    limite: number,
  ): Promise<ParadaCercana[]> {
    const { text, params } = buildFindParadasCercanasSql(
      lon,
      lat,
      radioMetros,
      limite,
    );
    const { rows } = await this.client.query<ParadaCercanaRow>(text, params);
    return rows.map(mapParadaCercana);
  }

  async listBuses(
    filtro?: FiltroPosiciones,
    pagina?: Paginacion,
  ): Promise<Pagina<Bus>> {
    const limite = normalizeLimit(pagina?.limite);
    const offset = parseOffsetCursor(pagina?.cursor);
    const { text, params } = buildListBusesSql(filtro, limite, offset);
    const { rows } = await this.client.query<BusRow>(text, params);
    return buildPagina(rows.map(mapBus), limite, offset);
  }

  async listDestinos(filtro?: {
    codLineas?: CodLinea[];
  }): Promise<DestinoGtfs[]> {
    const { text, params } = buildListDestinosSql(filtro);
    const { rows } = await this.client.query<DestinoRow>(text, params);
    return rows.map(mapDestino);
  }

  async insertPosiciones(capturas: PosicionCaptura[]): Promise<void> {
    const statement = buildInsertPosicionesSql(capturas);
    if (statement === null) {
      return;
    }
    await this.client.query(statement.text, statement.params);
  }

  async recargarGtfs(dataset: GtfsDataset): Promise<void> {
    // La recarga debe ser atómica: si el cliente soporta transacciones, se
    // ejecuta dentro de una; si no (doble de test), se degrada a secuencial.
    const ejecutar = async (tx: QueryClient): Promise<void> => {
      // 1. Vaciar las tablas estáticas respetando las FKs (hijas primero).
      for (const tabla of ORDEN_BORRADO_GTFS) {
        await tx.query(`DELETE FROM ${tabla}`);
      }

      // 2. Repoblar en orden padre→hijo. Cada builder devuelve null si su
      //    conjunto está vacío, en cuyo caso no se emite SQL para esa tabla.
      const statements: (SqlStatement | null)[] = [
        buildInsertRoutesSql(dataset.routes),
        buildInsertStopsSql(dataset.stops),
        buildInsertTripsSql(dataset.trips),
        buildInsertStopTimesSql(dataset.stopTimes),
        buildInsertCalendarDatesSql(dataset.calendarDates),
        buildInsertShapesSql(dataset.shapes),
        // `route_directions` depende de `routes`: se inserta tras ella en la
        // misma recarga transaccional (Requisito 2.8).
        buildInsertRouteDirectionsSql(dataset.destinos),
      ];
      for (const statement of statements) {
        if (statement !== null) {
          await tx.query(statement.text, statement.params);
        }
      }
    };

    if (this.client.withTransaction !== undefined) {
      await this.client.withTransaction(ejecutar);
    } else {
      await ejecutar(this.client);
    }
  }

  async purgePosicionesAntiguas(ventanaSegundos: number): Promise<number> {
    const { text, params } = buildPurgePosicionesSql(ventanaSegundos);
    const { rowCount } = await this.client.query(text, params);
    return rowCount ?? 0;
  }

  async listFavoritos(userId: string): Promise<Favorito[]> {
    const { text, params } = buildListFavoritosSql(userId);
    const { rows } = await this.client.query<FavoritoRow>(text, params);
    return rows.map(mapFavorito);
  }

  async createFavorito(fav: NuevoFavorito): Promise<Favorito> {
    const { text, params } = buildCreateFavoritoSql(fav);
    const { rows } = await this.client.query<FavoritoRow>(text, params);
    return mapFavorito(rows[0]);
  }

  async deleteFavorito(userId: string, id: string): Promise<void> {
    const { text, params } = buildDeleteFavoritoSql(userId, id);
    await this.client.query(text, params);
  }

  async listAportacionesVigentes(codBus: CodBus): Promise<Aportacion[]> {
    const { text, params } = buildListAportacionesVigentesSql(codBus);
    const { rows } = await this.client.query<AportacionRow>(text, params);
    return rows.map(mapAportacion);
  }

  async createAportacion(aportacion: NuevaAportacion): Promise<Aportacion> {
    const { text, params } = buildCreateAportacionSql(aportacion);
    const { rows } = await this.client.query<AportacionRow>(text, params);
    return mapAportacion(rows[0]);
  }

  async logIngesta(result: IngestResult): Promise<void> {
    const { text, params } = buildLogIngestaSql(result);
    await this.client.query(text, params);
  }
}

// ---------------------------------------------------------------------------
// Factoría
// ---------------------------------------------------------------------------

/**
 * Construye el repositorio Postgres portable a partir de una cadena de conexión.
 *
 * Es el único punto que abre el pool de `pg`. La factoría de `lib/config.ts` lo
 * invoca con `config.databaseUrl` —la única variación entre modos—; el resto
 * del sistema recibe el resultado como el puerto `Repository`, nunca como un
 * cliente de plataforma concreto.
 *
 * @param databaseUrl Cadena de conexión de Postgres (p. ej.
 *   `postgresql://user:pass@host:5432/db`).
 * @param overrides Opciones adicionales del pool (p. ej. `ssl`, `max`).
 */
export function createPostgresRepository(
  databaseUrl: string,
  overrides?: Omit<PoolConfig, "connectionString">,
): Repository {
  const pool = new Pool({ connectionString: databaseUrl, ...overrides });
  return new PostgresRepository(crearQueryClientPool(pool));
}

/**
 * Envuelve un `pg.Pool` como `QueryClient` con soporte de transacciones. Las
 * consultas sueltas usan el pool (una conexión cualquiera); `withTransaction`
 * reserva una **única** conexión con `BEGIN`/`COMMIT`/`ROLLBACK` y la libera
 * siempre, de modo que la recarga GTFS sea atómica (Requisito 12.2/12.4).
 */
export function crearQueryClientPool(pool: Pool): QueryClient {
  return {
    query(text, params) {
      return pool.query(text, params);
    },
    async withTransaction(fn) {
      const conexion: PoolClient = await pool.connect();
      const tx: QueryClient = {
        query(text, params) {
          return conexion.query(text, params);
        },
      };
      try {
        await conexion.query("BEGIN");
        const resultado = await fn(tx);
        await conexion.query("COMMIT");
        return resultado;
      } catch (error) {
        try {
          await conexion.query("ROLLBACK");
        } catch {
          // Un fallo del ROLLBACK no debe enmascarar el error original.
        }
        throw error;
      } finally {
        conexion.release();
      }
    },
  };
}
