/**
 * Normalización y recarga de los datos estáticos GTFS (ciclo de 24 h).
 *
 * El portal de datos abiertos de Málaga publica el GTFS de la EMT desglosado en
 * CSVs con nombres de columna GTFS estándar (`routes.csv`, `trips.csv`,
 * `stops.csv`, `stop_times.csv`, `shapes.csv`, `calendar_dates.csv`).
 *
 * Las paradas se toman de `stops.csv` (GTFS estándar). La clave de la tabla
 * `stops` es el código público de parada de la EMT (`stop_code`), no el
 * `stop_id` interno del GTFS; `stop_times.stop_id` se traduce a ese código al
 * normalizar. El JSON propietario `lineasyparadas.geojson` no se descarga: no
 * aporta nada que no esté ya en el GTFS (nombres de línea en `routes.csv`,
 * nombres de parada en `stops.csv`).
 *
 * El `sentido` de `trips`/`shapes` se expresa en la convención de la EMT (1/2),
 * traduciendo el `direction_id` GTFS (0/1), para casar con las posiciones.
 *
 * Este módulo es el borde de entrada de la recarga GTFS. Igual que la ingesta de
 * posiciones (`lib/ingest.ts`, `lib/normalize.ts`), es **lógica pura respecto a
 * la plataforma**: recupera las fuentes a través del `HttpTransport` inyectado,
 * normaliza los CSV a un modelo interno (`GtfsDataset`) descartando filas
 * malformadas, y persiste el conjunto completo a través del puerto `Repository`.
 * No conoce `pg_net`, `fetch` ni la cadena de conexión concreta.
 *
 * Responsabilidades (tarea 3.3, Requisito 12.2):
 *
 * - Recuperar los CSV GTFS (`routes`, `trips`, `stops`, `stop_times`, `shapes`,
 *   `calendar_dates`) vía `HttpTransport`.
 * - Normalizar cada fuente a su modelo interno, descartando entradas
 *   malformadas de forma defensiva (coordenadas no numéricas, campos ausentes)
 *   sin interrumpir la recarga de las válidas.
 * - Resolver el mapeo estructural del GTFS al esquema del proyecto: `shapes` se
 *   asocia a `(route_id, sentido)` vía los `trips` (su `shape_id`/`direction`);
 *   `calendar_dates` se asocia a `route_id` vía el `service_id` de los `trips`.
 * - Persistir el conjunto a través de `Repository.recargarGtfs`, que reconstruye
 *   la LINESTRING PostGIS de `shapes` desde los puntos del recorrido.
 *
 * Contrato de errores (Requisitos 12.2, 12.4, 12.5, por analogía con las
 * posiciones): ante timeout/error o fuente no disponible, **se conservan los
 * datos previos** (no se toca la BD) y se devuelve un `IngestResult` con
 * `estado: "fallo"`, la `fuente` afectada y el `error`. La función nunca lanza
 * por un fallo de fuente: lo devuelve como resultado para que el llamador lo
 * registre en `ingest_log`.
 *
 * La función `recargarGtfs` conforma la firma `RecargaGtfs` de `lib/ingest.ts`,
 * de modo que el adaptador `node-worker` (tarea 3.2) y el `pg_cron` (Hito 4)
 * la conectan en `IngestConfig.recargaGtfs` sin modificar el núcleo de ingesta.
 */

import type { IngestDeps, RecargaGtfs } from "@/lib/ingest";
import type { HttpTransport, IngestResult } from "@/lib/ports";
import type {
  CodLinea,
  CodParada,
  ExcepcionCalendarioGtfs,
  FormaGtfs,
  GtfsDataset,
  ParadaGtfs,
  Position,
  RutaGtfs,
  Sentido,
  StopTimeGtfs,
  ViajeGtfs,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Constantes del contrato de recarga GTFS
// ---------------------------------------------------------------------------

/**
 * Timeout de las descargas GTFS, en milisegundos. El Requisito 12.4 fija el
 * umbral de fuente no disponible en 30 s; se reutiliza aquí para cada fuente.
 */
export const TIMEOUT_GTFS_MS = 30_000;

/** Separador de campos de los CSV GTFS del portal de Málaga. */
const SEPARADOR_CSV = ",";

// ---------------------------------------------------------------------------
// URLs de las fuentes GTFS
// ---------------------------------------------------------------------------

/**
 * URLs de las seis fuentes CSV GTFS estándar. El adaptador de `IngestScheduler`
 * las provee; los valores por defecto apuntan al portal de datos abiertos de
 * Málaga (ver `SPEC.md`).
 */
export interface FuentesGtfs {
  routes: string;
  /** Paradas GTFS estándar; su `stop_id` casa con `stop_times.stop_id`. */
  stops: string;
  trips: string;
  stopTimes: string;
  shapes: string;
  calendarDates: string;
}

/** Base del portal de datos abiertos para los CSV GTFS de la EMT. */
const BASE_GTFS =
  "https://datosabiertos.malaga.eu/recursos/transporte/EMT/lineasYHorarios";


/** Fuentes GTFS por defecto (portal de datos abiertos de Málaga). */
export const FUENTES_GTFS_DEFECTO: FuentesGtfs = {
  routes: `${BASE_GTFS}/routes.csv`,
  stops: `${BASE_GTFS}/stops.csv`,
  trips: `${BASE_GTFS}/trips.csv`,
  stopTimes: `${BASE_GTFS}/stop_times.csv`,
  shapes: `${BASE_GTFS}/shapes.csv`,
  calendarDates: `${BASE_GTFS}/calendar_dates.csv`,
};

/** Opciones del ciclo de recarga GTFS. */
export interface RecargaGtfsOpciones {
  /** URLs de las fuentes. Por defecto {@link FUENTES_GTFS_DEFECTO}. */
  fuentes?: FuentesGtfs;
  /** Timeout por descarga, en ms. Por defecto {@link TIMEOUT_GTFS_MS}. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Parsing numérico defensivo (coherente con lib/normalize.ts)
// ---------------------------------------------------------------------------

/**
 * Convierte un valor de origen a `number` finito, tolerando la coma decimal
 * europea y espacios. Devuelve `null` para valores vacíos o no numéricos.
 */
function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const num = Number(trimmed.replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

/** Convierte un valor de origen a entero finito, o `null` si no lo es. */
function parseInteger(value: unknown): number | null {
  const num = parseNumeric(value);
  if (num === null || !Number.isInteger(num)) {
    return null;
  }
  return num;
}

/** Recorta un string y devuelve `undefined` si queda vacío. */
function textoOpcional(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return value === undefined || value === null ? undefined : String(value);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Parsing de CSV con cabecera
// ---------------------------------------------------------------------------

/**
 * Una fila de CSV ya indexada por nombre de columna. Los CSV GTFS traen
 * cabecera con nombres estándar, por lo que se mapea por nombre y no por
 * posición: así el orden de columnas del portal no rompe la normalización.
 */
export type FilaCsv = Record<string, string>;

/**
 * Parsea un CSV plano (con cabecera en la primera línea) a filas indexadas por
 * nombre de columna. Ignora líneas en blanco, recorta el `\r` final de estilo
 * Windows y no interpreta comillas (los CSV GTFS del portal son planos). Las
 * filas con menos campos que la cabecera rellenan con string vacío; las que
 * tienen más, descartan el excedente. Devuelve `[]` si no hay cabecera.
 */
export function parsearCsvConCabecera(cuerpo: string): FilaCsv[] {
  const lineas: string[] = [];
  for (const linea of cuerpo.split("\n")) {
    const limpia = linea.replace(/\r$/, "");
    if (limpia.trim() === "") {
      continue;
    }
    lineas.push(limpia);
  }

  if (lineas.length === 0) {
    return [];
  }

  const cabecera = lineas[0].split(SEPARADOR_CSV).map(desentrecomillar);
  const filas: FilaCsv[] = [];

  for (let i = 1; i < lineas.length; i++) {
    const campos = lineas[i].split(SEPARADOR_CSV);
    const fila: FilaCsv = {};
    for (let j = 0; j < cabecera.length; j++) {
      fila[cabecera[j]] = campos[j] !== undefined ? desentrecomillar(campos[j]) : "";
    }
    filas.push(fila);
  }

  return filas;
}

/**
 * Recorta las comillas dobles que envuelven un campo CSV, si las tiene, y los
 * espacios alrededor. Tolerante: un campo sin comillas se devuelve solo con el
 * recorte de espacios. Mantiene correcto el parsing tanto si el portal publica
 * los CSV planos (los GTFS actuales) como entrecomillados.
 */
function desentrecomillar(campo: string): string {
  const t = campo.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Normalización de cada fuente GTFS
// ---------------------------------------------------------------------------

/**
 * Normaliza `routes.csv` a `RutaGtfs[]`. `route_id` (= `codLinea`) debe ser un
 * entero; el nombre legible se toma de `route_short_name`, con `route_long_name`
 * como alternativa. Las filas sin `route_id` válido se descartan.
 */
export function normalizarRoutes(filas: FilaCsv[]): RutaGtfs[] {
  const routes: RutaGtfs[] = [];
  for (const fila of filas) {
    const codLinea = parseInteger(fila["route_id"]);
    if (codLinea === null) {
      continue;
    }
    const nombre =
      textoOpcional(fila["route_short_name"]) ??
      textoOpcional(fila["route_long_name"]);
    const ruta: RutaGtfs = { codLinea };
    if (nombre !== undefined) {
      ruta.nombre = nombre;
    }
    routes.push(ruta);
  }
  return routes;
}

/**
 * Fila de `trips` ya normalizada con los campos auxiliares (`service_id`,
 * `shape_id`) que el GTFS usa para resolver `calendar_dates` y `shapes`, pero
 * que no viven en la tabla `trips` del esquema. Se conservan solo durante la
 * normalización para el mapeo estructural.
 */
interface ViajeGtfsNormalizado extends ViajeGtfs {
  serviceId?: string;
  shapeId?: string;
}

/**
 * Normaliza `trips.csv`. `trip_id` y `route_id` son obligatorios; `direction_id`
 * aporta el `sentido` (opcional). Conserva `service_id` y `shape_id` para los
 * mapeos posteriores de `calendar_dates` y `shapes`.
 */
export function normalizarTrips(filas: FilaCsv[]): ViajeGtfsNormalizado[] {
  const trips: ViajeGtfsNormalizado[] = [];
  for (const fila of filas) {
    const tripId = textoOpcional(fila["trip_id"]);
    const codLinea = parseInteger(fila["route_id"]);
    if (tripId === undefined || codLinea === null) {
      continue;
    }
    const viaje: ViajeGtfsNormalizado = { tripId, codLinea };
    const sentido = directionIdASentido(fila["direction_id"]);
    if (sentido !== null) {
      viaje.sentido = sentido;
    }
    const serviceId = textoOpcional(fila["service_id"]);
    if (serviceId !== undefined) {
      viaje.serviceId = serviceId;
    }
    const shapeId = textoOpcional(fila["shape_id"]);
    if (shapeId !== undefined) {
      viaje.shapeId = shapeId;
    }
    trips.push(viaje);
  }
  return trips;
}

/**
 * Traduce el `direction_id` GTFS (0/1) al `sentido` de la EMT (1/2), que es el
 * que publican las posiciones en tiempo real. Verificado contra el feed real:
 * los buses con `sentido` 1 están en paradas de los trips con `direction_id` 0
 * y los de `sentido` 2 en las de `direction_id` 1. Así `trips.sentido` y
 * `shapes.sentido` casan con `bus_positions.sentido` sin conversión posterior.
 * Devuelve `null` para valores ausentes o distintos de 0/1.
 */
export function directionIdASentido(value: unknown): Sentido | null {
  const direction = parseInteger(value);
  if (direction !== 0 && direction !== 1) {
    return null;
  }
  return (direction + 1) as Sentido;
}

/** Proyecta los `trips` normalizados al modelo de la tabla `trips`. */
function aViajesGtfs(trips: ViajeGtfsNormalizado[]): ViajeGtfs[] {
  return trips.map(({ tripId, codLinea, sentido }) => {
    const viaje: ViajeGtfs = { tripId, codLinea };
    if (sentido !== undefined) {
      viaje.sentido = sentido;
    }
    return viaje;
  });
}

/**
 * Normaliza `stop_times.csv`. `trip_id`, `stop_id` y `stop_sequence` (entero)
 * son obligatorios. Las filas malformadas se descartan.
 */
export function normalizarStopTimes(filas: FilaCsv[]): StopTimeGtfs[] {
  const stopTimes: StopTimeGtfs[] = [];
  for (const fila of filas) {
    const tripId = textoOpcional(fila["trip_id"]);
    const codParada = textoOpcional(fila["stop_id"]);
    const stopSequence = parseInteger(fila["stop_sequence"]);
    if (tripId === undefined || codParada === undefined || stopSequence === null) {
      continue;
    }
    stopTimes.push({
      tripId,
      codParada: codParada as CodParada,
      stopSequence,
    });
  }
  return stopTimes;
}

/**
 * Normaliza `calendar_dates.csv` resolviendo el `service_id` a `route_id` vía
 * los `trips`. `date` llega en formato GTFS `YYYYMMDD` y se normaliza a ISO
 * `YYYY-MM-DD`. Las filas cuyo `service_id` no mapea a ninguna línea, o con
 * fecha/`exception_type` inválidos, se descartan. Se deduplican las
 * combinaciones `(route_id, fecha, exception_type)` que el mapeo pueda repetir
 * (varios trips de la misma línea comparten `service_id`).
 */
export function normalizarCalendarDates(
  filas: FilaCsv[],
  serviceIdARutas: Map<string, Set<CodLinea>>,
): ExcepcionCalendarioGtfs[] {
  const vistas = new Set<string>();
  const excepciones: ExcepcionCalendarioGtfs[] = [];

  for (const fila of filas) {
    const serviceId = textoOpcional(fila["service_id"]);
    const fecha = normalizarFechaGtfs(fila["date"]);
    const exceptionType = parseInteger(fila["exception_type"]);
    if (serviceId === undefined || fecha === null || exceptionType === null) {
      continue;
    }

    const rutas = serviceIdARutas.get(serviceId);
    if (rutas === undefined) {
      continue;
    }

    for (const codLinea of rutas) {
      const clave = `${codLinea}|${fecha}|${exceptionType}`;
      if (vistas.has(clave)) {
        continue;
      }
      vistas.add(clave);
      excepciones.push({ codLinea, fecha, exceptionType });
    }
  }

  return excepciones;
}

/**
 * Convierte una fecha GTFS `YYYYMMDD` a ISO `YYYY-MM-DD`. Acepta también un
 * valor ya en formato ISO. Devuelve `null` si no encaja en ninguno de los dos.
 */
function normalizarFechaGtfs(value: unknown): string | null {
  const texto = textoOpcional(value);
  if (texto === undefined) {
    return null;
  }
  // Formato GTFS compacto: YYYYMMDD.
  const compacto = /^(\d{4})(\d{2})(\d{2})$/.exec(texto);
  if (compacto !== null) {
    return `${compacto[1]}-${compacto[2]}-${compacto[3]}`;
  }
  // Formato ISO ya normalizado: YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return texto;
  }
  return null;
}

/**
 * Normaliza `shapes.csv` agrupando los puntos por `shape_id` y ordenándolos por
 * `shape_pt_sequence`, y mapea cada `shape_id` a su `(route_id, sentido)` vía
 * los `trips`. Las coordenadas se convierten a numérico `[lon, lat]` (Requisito
 * 12.3) descartando puntos no numéricos. Solo se conservan recorridos con al
 * menos dos puntos, pues una LINESTRING válida los exige.
 */
export function normalizarShapes(
  filas: FilaCsv[],
  shapeIdARutaSentido: Map<string, { codLinea: CodLinea; sentido: Sentido }>,
): FormaGtfs[] {
  // Agrupa los puntos crudos por shape_id, conservando su secuencia.
  interface PuntoCrudo {
    secuencia: number;
    punto: Position;
  }
  const porShape = new Map<string, PuntoCrudo[]>();

  for (const fila of filas) {
    const shapeId = textoOpcional(fila["shape_id"]);
    const lon = parseNumeric(fila["shape_pt_lon"]);
    const lat = parseNumeric(fila["shape_pt_lat"]);
    const secuencia = parseInteger(fila["shape_pt_sequence"]);
    if (shapeId === undefined || lon === null || lat === null) {
      continue;
    }
    const lista = porShape.get(shapeId) ?? [];
    // Sin secuencia válida, se encola al final preservando el orden de llegada.
    lista.push({ secuencia: secuencia ?? lista.length, punto: [lon, lat] });
    porShape.set(shapeId, lista);
  }

  const shapes: FormaGtfs[] = [];
  for (const [shapeId, puntosCrudos] of porShape) {
    const destino = shapeIdARutaSentido.get(shapeId);
    if (destino === undefined) {
      continue;
    }
    const puntos = puntosCrudos
      .slice()
      .sort((a, b) => a.secuencia - b.secuencia)
      .map((p) => p.punto);
    // Una LINESTRING válida necesita al menos dos puntos.
    if (puntos.length < 2) {
      continue;
    }
    shapes.push({
      codLinea: destino.codLinea,
      sentido: destino.sentido,
      puntos,
    });
  }

  return shapes;
}

// ---------------------------------------------------------------------------
// Normalización de las paradas (stops.csv GTFS estándar)
// ---------------------------------------------------------------------------

/**
 * Normaliza `stops.csv` (GTFS estándar) a `ParadaGtfs[]`, la fuente
 * autoritativa de la tabla `stops`.
 *
 * `codParada` es el **código público de parada de la EMT**: la columna GTFS
 * `stop_code` (p. ej. 103 para Plaza de la Merced, cuyo `stop_id` es 22). Es el
 * código impreso en la parada, el `codParIni` del CSV de posiciones y el
 * `codParada` de `informacionParada.html` (calibración). Si `stop_code` falta se
 * usa `stop_id` como respaldo. `stop_times.stop_id` se traduce a este código en
 * {@link normalizarGtfs} con el mapa de {@link normalizarStopsConIds}.
 *
 * `stop_id`, `stop_name` y las coordenadas `stop_lon`/`stop_lat` (numéricas,
 * orden `[lon, lat]`) son obligatorios; las filas incompletas se descartan. Se
 * deduplica por `codParada` conservando la primera aparición.
 */
export function normalizarStops(filas: FilaCsv[]): ParadaGtfs[] {
  return normalizarStopsConIds(filas).stops;
}

/**
 * Igual que {@link normalizarStops}, pero devuelve además el mapa
 * `stop_id → codParada` necesario para traducir `stop_times.stop_id` al código
 * público de parada.
 */
export function normalizarStopsConIds(filas: FilaCsv[]): {
  stops: ParadaGtfs[];
  stopIdACodParada: Map<string, CodParada>;
} {
  const paradas = new Map<CodParada, ParadaGtfs>();
  const stopIdACodParada = new Map<string, CodParada>();
  for (const fila of filas) {
    const stopId = textoOpcional(fila["stop_id"]);
    const codParada = (textoOpcional(fila["stop_code"]) ?? stopId) as
      | CodParada
      | undefined;
    const nombre = textoOpcional(fila["stop_name"]);
    const lon = parseNumeric(fila["stop_lon"]);
    const lat = parseNumeric(fila["stop_lat"]);
    if (
      stopId === undefined ||
      codParada === undefined ||
      nombre === undefined ||
      lon === null ||
      lat === null
    ) {
      continue;
    }
    if (stopIdACodParada.has(stopId)) {
      continue;
    }
    stopIdACodParada.set(stopId, codParada);
    if (!paradas.has(codParada)) {
      paradas.set(codParada, { codParada, nombre, lon, lat });
    }
  }
  return { stops: [...paradas.values()], stopIdACodParada };
}

// ---------------------------------------------------------------------------
// Ensamblado del GtfsDataset completo
// ---------------------------------------------------------------------------

/**
 * Cuerpos crudos de las seis fuentes GTFS, tal como los devuelve el transporte.
 */
export interface CuerposGtfs {
  routes: string;
  stops: string;
  trips: string;
  stopTimes: string;
  shapes: string;
  calendarDates: string;
}

/**
 * Normaliza los cuerpos crudos de las seis fuentes al `GtfsDataset` interno,
 * resolviendo los mapeos estructurales entre tablas:
 *
 * - `service_id → {route_id}` (desde `trips`) para resolver `calendar_dates`.
 * - `shape_id → {route_id, sentido}` (desde `trips`) para asociar los `shapes`.
 *
 * Las paradas se toman de `stops.csv` (GTFS estándar), cuyo `stop_id` casa con
 * `stop_times.stop_id`, garantizando la integridad referencial de la FK
 * `stop_times.stop_id → stops.cod_parada`.
 */
export function normalizarGtfs(cuerpos: CuerposGtfs): GtfsDataset {
  const routes = normalizarRoutes(parsearCsvConCabecera(cuerpos.routes));
  const tripsNorm = normalizarTrips(parsearCsvConCabecera(cuerpos.trips));
  const { stops, stopIdACodParada } = normalizarStopsConIds(
    parsearCsvConCabecera(cuerpos.stops),
  );

  // `stop_times` referencia `stop_id`; se traduce al código público de parada
  // (`stop_code`) que usa la tabla `stops`. Las filas cuyo `stop_id` no existe
  // en `stops.csv` se descartan para no violar la FK.
  const stopTimes: StopTimeGtfs[] = [];
  for (const st of normalizarStopTimes(parsearCsvConCabecera(cuerpos.stopTimes))) {
    const codParada = stopIdACodParada.get(st.codParada);
    if (codParada !== undefined) {
      stopTimes.push({ ...st, codParada });
    }
  }

  // Mapa service_id → conjunto de route_id (varios trips comparten service_id).
  const serviceIdARutas = new Map<string, Set<CodLinea>>();
  // Mapa shape_id → (route_id, sentido). Un shape pertenece a un recorrido
  // línea/sentido; si varios trips lo comparten, el primero fija el destino.
  const shapeIdARutaSentido = new Map<
    string,
    { codLinea: CodLinea; sentido: Sentido }
  >();

  for (const trip of tripsNorm) {
    if (trip.serviceId !== undefined) {
      const set = serviceIdARutas.get(trip.serviceId) ?? new Set<CodLinea>();
      set.add(trip.codLinea);
      serviceIdARutas.set(trip.serviceId, set);
    }
    // Sin sentido conocido el recorrido no puede asociarse a un (línea, sentido)
    // de las posiciones; se omite en lugar de inventar uno.
    if (
      trip.shapeId !== undefined &&
      trip.sentido !== undefined &&
      !shapeIdARutaSentido.has(trip.shapeId)
    ) {
      shapeIdARutaSentido.set(trip.shapeId, {
        codLinea: trip.codLinea,
        sentido: trip.sentido,
      });
    }
  }

  const calendarDates = normalizarCalendarDates(
    parsearCsvConCabecera(cuerpos.calendarDates),
    serviceIdARutas,
  );
  const shapes = normalizarShapes(
    parsearCsvConCabecera(cuerpos.shapes),
    shapeIdARutaSentido,
  );

  return {
    routes,
    trips: aViajesGtfs(tripsNorm),
    stops,
    stopTimes,
    calendarDates,
    shapes,
  };
}

// ---------------------------------------------------------------------------
// Ciclo de recarga GTFS (cada 24 h) — conforme a RecargaGtfs
// ---------------------------------------------------------------------------

/** Resultado detallado de la recarga GTFS, con el recuento por tabla. */
export interface ResultadoRecargaGtfs {
  resultado: IngestResult;
  /** Recuento de filas normalizadas persistidas por tabla (0 si falló). */
  recuento: {
    routes: number;
    trips: number;
    stops: number;
    stopTimes: number;
    calendarDates: number;
    shapes: number;
  };
}

/** Recuento vacío (todas las tablas a 0), usado en los caminos de fallo. */
const RECUENTO_VACIO: ResultadoRecargaGtfs["recuento"] = {
  routes: 0,
  trips: 0,
  stops: 0,
  stopTimes: 0,
  calendarDates: 0,
  shapes: 0,
};

/**
 * Descarga una fuente por el transporte, devolviendo el resultado de fallo ya
 * construido si la petición falla. Centraliza el contrato de error por fuente.
 */
async function descargarFuente(
  transport: HttpTransport,
  url: string,
  timeoutMs: number,
  runAt: string,
): Promise<{ ok: true; cuerpo: string } | { ok: false; resultado: IngestResult }> {
  try {
    const cuerpo = await transport.get(url, timeoutMs);
    return { ok: true, cuerpo };
  } catch (error) {
    return { ok: false, resultado: resultadoFalloGtfs(url, error, runAt) };
  }
}

/**
 * Ejecuta el ciclo de recarga GTFS (cada 24 h): recupera las seis fuentes por
 * el transporte inyectado, las normaliza a `GtfsDataset` descartando filas
 * malformadas, y repuebla las tablas estáticas a través de
 * `Repository.recargarGtfs` (que reconstruye la LINESTRING PostGIS de `shapes`).
 *
 * Contrato de errores (Requisitos 12.2, 12.4, 12.5): si cualquier fuente no
 * responde dentro del timeout o falla, **no se modifica nada** en la BD y se
 * devuelve un `IngestResult` con `estado: "fallo"`, la `fuente` afectada y el
 * `error`. Nunca lanza por un fallo de fuente ni de escritura: lo devuelve como
 * resultado para que el llamador lo registre en `ingest_log`.
 *
 * Firma compatible con `RecargaGtfs` de `lib/ingest.ts`: ver
 * {@link recargarGtfs}, que la adapta con las opciones por defecto.
 */
export async function ejecutarRecargaGtfs(
  deps: IngestDeps,
  opciones: RecargaGtfsOpciones = {},
): Promise<ResultadoRecargaGtfs> {
  const ahora = (deps.now ?? (() => new Date()))();
  const runAt = ahora.toISOString();
  const fuentes = opciones.fuentes ?? FUENTES_GTFS_DEFECTO;
  const timeoutMs = opciones.timeoutMs ?? TIMEOUT_GTFS_MS;

  // 1. Recuperar las seis fuentes. Un fallo en cualquiera preserva los datos
  //    previos (no se toca la BD) y reporta la fuente afectada.
  const descargas: Array<[keyof CuerposGtfs, string]> = [
    ["routes", fuentes.routes],
    ["stops", fuentes.stops],
    ["trips", fuentes.trips],
    ["stopTimes", fuentes.stopTimes],
    ["shapes", fuentes.shapes],
    ["calendarDates", fuentes.calendarDates],
  ];

  const cuerpos = {} as CuerposGtfs;
  for (const [clave, url] of descargas) {
    const descarga = await descargarFuente(
      deps.transport,
      url,
      timeoutMs,
      runAt,
    );
    if (!descarga.ok) {
      return { resultado: descarga.resultado, recuento: RECUENTO_VACIO };
    }
    cuerpos[clave] = descarga.cuerpo;
  }

  // 2. Normalizar a GtfsDataset (coordenadas numéricas [lon, lat], descarte de
  //    filas malformadas, mapeos estructurales entre tablas).
  const dataset = normalizarGtfs(cuerpos);

  // 3. Persistir el conjunto completo. Un fallo de escritura también se reporta
  //    como fallo del ciclo sin propagar la excepción al disparador.
  try {
    await deps.repository.recargarGtfs(dataset);
  } catch (error) {
    return {
      resultado: resultadoFalloGtfs(fuentes.routes, error, runAt),
      recuento: RECUENTO_VACIO,
    };
  }

  return {
    resultado: { job: "gtfs", estado: "ok", fuente: fuentes.routes, runAt },
    recuento: {
      routes: dataset.routes.length,
      trips: dataset.trips.length,
      stops: dataset.stops.length,
      stopTimes: dataset.stopTimes.length,
      calendarDates: dataset.calendarDates.length,
      shapes: dataset.shapes.length,
    },
  };
}

/**
 * Adaptador de {@link ejecutarRecargaGtfs} a la firma `RecargaGtfs` de
 * `lib/ingest.ts`, para conectarlo en `IngestConfig.recargaGtfs` (tarea 3.2)
 * sin modificar el núcleo de ingesta. Usa las fuentes y el timeout por defecto;
 * para personalizarlos, componer una closure sobre `ejecutarRecargaGtfs`.
 */
export const recargarGtfs: RecargaGtfs = async (deps) => {
  const { resultado } = await ejecutarRecargaGtfs(deps);
  return resultado;
};

/**
 * Construye un `RecargaGtfs` con opciones (fuentes/timeout) personalizadas,
 * manteniendo la firma que espera `IngestConfig.recargaGtfs`.
 */
export function crearRecargaGtfs(opciones: RecargaGtfsOpciones): RecargaGtfs {
  return async (deps) => {
    const { resultado } = await ejecutarRecargaGtfs(deps, opciones);
    return resultado;
  };
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/** Construye un `IngestResult` de fallo del ciclo GTFS con fuente y error. */
function resultadoFalloGtfs(
  fuente: string,
  error: unknown,
  runAt: string,
): IngestResult {
  return {
    job: "gtfs",
    estado: "fallo",
    fuente,
    error: error instanceof Error ? error.message : String(error),
    runAt,
  };
}
