/**
 * Adaptador de la API Navega de la EMT (`https://navega.emtmalaga.es/api/`).
 *
 * Navega es la API que usa el front "Líneas y Horarios" de la EMT. Sustituye a
 * las tres fuentes anteriores con datos más frescos y estructurados:
 *
 * | Ciclo         | Antes (datos abiertos / web)          | Navega                         |
 * |---------------|---------------------------------------|--------------------------------|
 * | `posiciones`  | `lineasyubicaciones.csv` (1 min)      | `buses_servicios` (10 s)       |
 * | `gtfs`        | CSV GTFS (`routes`, `trips`, …)       | `lineas`, `paradas`, `rutas`   |
 * | `calibracion` | scraping de `informacionParada.html`  | `estimaciones` (JSON)          |
 *
 * La API no tiene documentación oficial y se declara inestable; el mapa de
 * endpoints, campos y enumerados está en `docs/api-navega.md`. Por eso todo el
 * acceso queda aislado en este módulo y **cada respuesta se valida de forma
 * defensiva**: un cambio de forma se convierte en un fallo del ciclo (que
 * conserva los datos previos), nunca en datos corruptos en la BD.
 *
 * El modelo interno no cambia. Este módulo traduce Navega a los mismos tipos
 * que producían las fuentes anteriores (`GtfsDataset`, `PosicionCaptura`,
 * `NuevoMinutoOficial`), de modo que el repositorio, el estimador de ETA y la
 * API REST no distinguen de qué fuente vienen los datos. Las equivalencias de
 * identificadores están comprobadas contra las fuentes anteriores:
 *
 * - `vehicleId` = `codBus` del CSV de posiciones.
 * - `lineId` = `codLinea` / `route_id`.
 * - `codPar` (y `rutas[].nodes[].nodeCode`) = código público de parada.
 * - `direction` 1/2 = `sentido` 1/2; las circulares (`direction` 3) se publican
 *   como `sentido` 1, igual que hacía el CSV.
 *
 * Igual que `lib/gtfs.ts` y `lib/calibrationCycle.ts`, es lógica pura respecto a
 * la plataforma: usa el `HttpTransport` y el `Repository` inyectados y se
 * conecta al núcleo de ingesta por sus puntos de extensión (`LectorPosiciones`,
 * `RecargaGtfs`, `CicloCalibracion`).
 */

import type {
  CicloCalibracion,
  IngestDeps,
  LectorPosiciones,
  RecargaGtfs,
} from "@/lib/ingest";
import type {
  HttpTransport,
  IngestResult,
  NuevoMinutoOficial,
  Repository,
} from "@/lib/ports";
import type {
  FilaDescartada,
  MotivoDescarte,
  ResultadoParseo,
} from "@/lib/normalize";
import type {
  CodBus,
  CodLinea,
  CodParada,
  FormaGtfs,
  GtfsDataset,
  ParadaGtfs,
  PosicionCaptura,
  Position,
  RutaGtfs,
  Sentido,
  StopTimeGtfs,
  ViajeGtfs,
} from "@/lib/types";
import { esMinutoValido } from "@/lib/calibration";
import { derivarDestinos } from "@/lib/gtfs";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Base de la API Navega. */
export const NAVEGA_BASE_URL_DEFECTO = "https://navega.emtmalaga.es/api";

/** Timeout por petición, en ms (el mismo umbral de 30 s del Requisito 12.4). */
export const TIMEOUT_NAVEGA_MS = 30_000;

/**
 * Timeout de las peticiones de geometría (`rutas`), en ms. Es el endpoint más
 * pesado: las rutas que el servidor no tiene en caché tardan decenas de
 * segundos (47 s para las 304 de la red completa en el sondeo).
 */
export const TIMEOUT_RUTAS_MS = 60_000;

/** Rutas por petición a `rutas?routeId=…` (acota el tamaño y el tiempo). */
export const RUTAS_POR_PETICION = 50;

/**
 * Vigencia del contexto de topología que necesita el ciclo de posiciones
 * (líneas a consultar y sentido de cada ruta). `lineas` se publica con una
 * caché de ~15 h; refrescarlo cada hora basta para seguir un cambio de
 * topología sin pedirlo en cada ciclo.
 */
export const TTL_CONTEXTO_POSICIONES_MS = 60 * 60 * 1_000;

/** Paradas por ciclo de calibración: caben en una sola petición. */
export const MAX_PARADAS_CALIBRACION = 50;

/**
 * Precisión del `polyline` de `rutas`: 6 decimales (comprobado contra las
 * coordenadas de las paradas). Ver {@link decodificarPolyline}.
 */
export const PRECISION_POLYLINE = 6;

/**
 * Valores de `vehicleLocationStatus` que representan un bus prestando servicio
 * en su línea y con posición fiable: `LOCALIZADO_LINEA` (5), `DESVIO` (9),
 * `ESPERA_CABECERA` (12) y `ASIGNADO_MANUAL` (14). El resto (cocheras,
 * incorporación, retirada, deslocalizado, recorrido en vacío…) no se publica.
 */
export const ESTADOS_EN_SERVICIO: ReadonlySet<number> = new Set([5, 9, 12, 14]);

/** Bit `SIN_COMUNICACION` de `vehicleStatus`: la posición está congelada. */
export const VEHICLE_STATUS_SIN_COMUNICACION = 16_384;

/** Bit `TEORICA` de `estimaciones[].type`: hora de horario, no de un bus real. */
export const ESTIMACION_TEORICA = 1;

/** Hora (en minutos desde medianoche) a la que cambia la jornada: 04:30. */
const CAMBIO_JORNADA_MINUTOS = 4 * 60 + 30;

// ---------------------------------------------------------------------------
// URLs y jornada
// ---------------------------------------------------------------------------

/**
 * Construye la URL de un endpoint. Los valores son siempre listas de enteros
 * separadas por comas o fechas `DD-MM-YYYY`, que no necesitan codificación (y
 * la API espera las comas literales).
 */
export function urlNavega(
  baseUrl: string,
  endpoint: string,
  params: Record<string, string> = {},
): string {
  const query = Object.entries(params)
    .map(([clave, valor]) => `${clave}=${valor}`)
    .join("&");
  const base = baseUrl.replace(/\/+$/, "");
  return query === "" ? `${base}/${endpoint}` : `${base}/${endpoint}?${query}`;
}

const formateadorJornada = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Jornada de servicio vigente en `ahora`, en el formato `DD-MM-YYYY` del
 * parámetro `day`. La jornada cambia a las 04:30 (hora de Málaga): antes de
 * esa hora sigue vigente la del día anterior.
 */
export function jornadaServicio(ahora: Date): string {
  const desplazado = new Date(
    ahora.getTime() - CAMBIO_JORNADA_MINUTOS * 60_000,
  );
  const partes: Record<string, string> = {};
  for (const p of formateadorJornada.formatToParts(desplazado)) {
    partes[p.type] = p.value;
  }
  return `${partes.day}-${partes.month}-${partes.year}`;
}

// ---------------------------------------------------------------------------
// Lectura defensiva de JSON
// ---------------------------------------------------------------------------

type Objeto = Record<string, unknown>;

function esObjeto(valor: unknown): valor is Objeto {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/** Entero finito, o `null`. No acepta strings: la API publica números. */
function entero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isInteger(valor) ? valor : null;
}

/** Número finito, o `null`. */
function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

/** String no vacío tras recortar, o `undefined`. */
function texto(valor: unknown): string | undefined {
  if (typeof valor !== "string") {
    return undefined;
  }
  const recortado = valor.trim();
  return recortado === "" ? undefined : recortado;
}

/**
 * Parsea el cuerpo de un endpoint. Los errores de la API llegan como página
 * HTML con estado 200 o 4xx, así que un cuerpo no JSON es un fallo de fuente.
 */
export function parsearJsonNavega(cuerpo: string, endpoint: string): unknown {
  try {
    return JSON.parse(cuerpo) as unknown;
  } catch {
    throw new Error(
      `La API Navega devolvió una respuesta no JSON en "${endpoint}".`,
    );
  }
}

/** Lanza el error de "forma inesperada" de un endpoint. */
function formaInesperada(endpoint: string, detalle: string): never {
  throw new Error(
    `Respuesta inesperada de la API Navega en "${endpoint}": ${detalle}.`,
  );
}

/**
 * Instante ISO-8601 a epoch ms, o `null`. `estimaciones` publica el desfase sin
 * dos puntos (`+0100`), que no es ISO estricto: se normaliza antes de parsear.
 */
export function parsearInstante(valor: unknown): number | null {
  const iso = texto(valor);
  if (iso === undefined) {
    return null;
  }
  const ms = Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Sentido
// ---------------------------------------------------------------------------

/**
 * Traduce el `direction` de Navega al `sentido` del modelo interno: 1 = ida,
 * 2 = vuelta. Las rutas circulares (`direction` 3) se publican como sentido 1,
 * que es lo que hacía el CSV de posiciones de datos abiertos (comprobado en
 * vivo) y lo que esperan los filtros Ida/Vuelta del mapa. Devuelve `null` para
 * cualquier otro valor.
 */
export function direccionASentido(direction: unknown): Sentido | null {
  if (direction === 1 || direction === 3) {
    return 1;
  }
  if (direction === 2) {
    return 2;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Polyline
// ---------------------------------------------------------------------------

/**
 * Decodifica el `polyline` de `rutas` a puntos `[lon, lat]`.
 *
 * Usa el algoritmo de Google Encoded Polyline, pero con **la longitud antes que
 * la latitud** en cada par (el formato estándar es latitud, longitud): Navega
 * lo codifica así, comprobado contra las coordenadas de las paradas de la ruta.
 *
 * Tolera una cadena truncada (devuelve los puntos completos previos) y descarta
 * el resultado entero si algún punto cae fuera del rango geográfico válido: es
 * lo que ocurriría si la API cambiara la precisión, y un recorrido desplazado
 * rompería el map-matching sin dar ningún error.
 */
export function decodificarPolyline(
  codificado: string,
  precision: number = PRECISION_POLYLINE,
): Position[] {
  const factor = 10 ** precision;
  const puntos: Position[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;

  const siguienteDelta = (): number | null => {
    let resultado = 0;
    let desplazamiento = 0;
    for (;;) {
      if (i >= codificado.length) {
        return null;
      }
      const trozo = codificado.charCodeAt(i) - 63;
      i += 1;
      // Aritmética en coma flotante: con 6 decimales los valores superan los
      // 32 bits de los operadores de bits de JS.
      resultado += (trozo & 0x1f) * 2 ** desplazamiento;
      desplazamiento += 5;
      if (trozo < 0x20) {
        break;
      }
    }
    return resultado % 2 === 1 ? -(resultado + 1) / 2 : resultado / 2;
  };

  for (;;) {
    const dLon = siguienteDelta();
    const dLat = dLon === null ? null : siguienteDelta();
    if (dLon === null || dLat === null) {
      break;
    }
    lon += dLon;
    lat += dLat;
    const punto: Position = [lon / factor, lat / factor];
    if (Math.abs(punto[0]) > 180 || Math.abs(punto[1]) > 90) {
      return [];
    }
    puntos.push(punto);
  }

  return puntos;
}

// ---------------------------------------------------------------------------
// Topología: `lineas`, `paradas`, `rutas`, `rutasActivas` / `rutasPrevistas`
// ---------------------------------------------------------------------------

/** Una ruta de la jerarquía `lineas` → `configs` → `sublines` → `routes`. */
export interface RutaDeLinea {
  routeId: number;
  codLinea: CodLinea;
  /** Sentido interno (1/2), o `null` si el `direction` no es reconocible. */
  sentido: Sentido | null;
  destino?: string;
}

/** Índice de `lineas`: nombres de línea y rutas por `routeId`. */
export interface IndiceLineas {
  /** `lineId` → nombre legible (`name`), si lo trae. */
  nombres: Map<CodLinea, string | undefined>;
  rutas: Map<number, RutaDeLinea>;
}

/**
 * Indexa la respuesta de `lineas`. Lanza si no trae el array `lineas`; las
 * entradas sueltas malformadas se ignoran.
 */
export function indexarLineas(json: unknown): IndiceLineas {
  if (!esObjeto(json) || !Array.isArray(json.lineas)) {
    formaInesperada("lineas", "falta el array `lineas`");
  }

  const nombres = new Map<CodLinea, string | undefined>();
  const rutas = new Map<number, RutaDeLinea>();

  for (const linea of json.lineas as unknown[]) {
    if (!esObjeto(linea)) {
      continue;
    }
    const codLinea = entero(linea.lineId);
    if (codLinea === null) {
      continue;
    }
    nombres.set(codLinea, texto(linea.name));

    for (const config of listaDe(linea.configs)) {
      for (const sublinea of listaDe(config.sublines)) {
        for (const ruta of listaDe(sublinea.routes)) {
          const routeId = entero(ruta.routeId);
          if (routeId === null) {
            continue;
          }
          const entrada: RutaDeLinea = {
            routeId,
            codLinea,
            sentido: direccionASentido(ruta.direction),
          };
          const destino = texto(ruta.destination);
          if (destino !== undefined) {
            entrada.destino = destino;
          }
          rutas.set(routeId, entrada);
        }
      }
    }
  }

  return { nombres, rutas };
}

/** Elementos objeto de un valor que debería ser un array (vacío si no lo es). */
function listaDe(valor: unknown): Objeto[] {
  return Array.isArray(valor) ? valor.filter(esObjeto) : [];
}

/**
 * Indexa `paradas` por `codPar`. Lanza si no trae el array `paradas`; las
 * paradas sin código, nombre o coordenadas numéricas se descartan.
 */
export function indexarParadas(json: unknown): Map<number, ParadaGtfs> {
  if (!esObjeto(json) || !Array.isArray(json.paradas)) {
    formaInesperada("paradas", "falta el array `paradas`");
  }

  const paradas = new Map<number, ParadaGtfs>();
  for (const parada of listaDe(json.paradas)) {
    const codPar = entero(parada.codPar);
    const nombre = texto(parada.name);
    const lon = numero(parada.lon);
    const lat = numero(parada.lat);
    if (codPar === null || nombre === undefined || lon === null || lat === null) {
      continue;
    }
    if (!paradas.has(codPar)) {
      paradas.set(codPar, { codParada: String(codPar), nombre, lon, lat });
    }
  }
  return paradas;
}

/**
 * Extrae los `routeId` de `rutasActivas` o `rutasPrevistas` (misma estructura:
 * objetos indexados por id `lineas` → `sublineas` → `rutas`). Devuelve un
 * conjunto vacío si la jornada no está disponible (`lineas` vacío o ausente).
 */
export function rutasPlanificadas(json: unknown): Set<number> {
  const ids = new Set<number>();
  if (!esObjeto(json) || !esObjeto(json.lineas)) {
    return ids;
  }
  for (const linea of Object.values(json.lineas)) {
    if (!esObjeto(linea) || !esObjeto(linea.sublineas)) {
      continue;
    }
    for (const sublinea of Object.values(linea.sublineas)) {
      if (!esObjeto(sublinea) || !esObjeto(sublinea.rutas)) {
        continue;
      }
      for (const [clave, ruta] of Object.entries(sublinea.rutas)) {
        const id = (esObjeto(ruta) ? entero(ruta.ruta) : null) ?? Number(clave);
        if (Number.isInteger(id)) {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}

/** Geometría y paradas ordenadas de una ruta, de `rutas?routeId=…`. */
export interface GeometriaRuta {
  routeId: number;
  /** `codPar` de las paradas de la ruta, en orden de recorrido. */
  codParadas: number[];
  /** Recorrido decodificado en `[lon, lat]`. */
  puntos: Position[];
}

/**
 * Normaliza la respuesta de `rutas` (un array sin objeto envolvente). Lanza si
 * no es un array. Solo se toman los nodos de tipo `PARADA` (1), cuyo `nodeCode`
 * es el código público de parada.
 */
export function normalizarRutas(json: unknown): GeometriaRuta[] {
  if (!Array.isArray(json)) {
    formaInesperada("rutas", "se esperaba un array");
  }

  const rutas: GeometriaRuta[] = [];
  for (const ruta of listaDe(json)) {
    const routeId = entero(ruta.routeId);
    if (routeId === null) {
      continue;
    }
    const codParadas: number[] = [];
    for (const nodo of listaDe(ruta.nodes)) {
      const codPar = entero(nodo.nodeCode);
      if (nodo.type === 1 && codPar !== null) {
        codParadas.push(codPar);
      }
    }
    const polyline = texto(ruta.polyline);
    rutas.push({
      routeId,
      codParadas,
      puntos: polyline === undefined ? [] : decodificarPolyline(polyline),
    });
  }
  return rutas;
}

/** Identificador del viaje sintético que representa una ruta de Navega. */
export function tripIdDeRuta(routeId: number): string {
  return `navega-${routeId}`;
}

/** Piezas ya indexadas con las que se ensambla el conjunto estático. */
export interface PiezasTopologia {
  lineas: IndiceLineas;
  paradas: Map<number, ParadaGtfs>;
  rutas: GeometriaRuta[];
  /** Líneas que la EMT no publica (`parametros.lineasOcultas`). */
  lineasOcultas: ReadonlySet<number>;
}

/**
 * Ensambla el `GtfsDataset` interno a partir de la topología de Navega.
 *
 * Navega no publica viajes con horario por parada, así que cada ruta se modela
 * como **un viaje sintético** (`navega-<routeId>`) con sus paradas en orden:
 * es todo lo que el esquema necesita para derivar las líneas por parada, el
 * recorrido ordenado y el Destino por `(codLinea, sentido)`.
 *
 * Solo entran las rutas recibidas en `rutas` (el llamador pide las planificadas
 * para la jornada), de líneas publicadas y con sentido reconocible. Una línea
 * aparece en `routes` solo si conserva alguna ruta; una parada, solo si la
 * sirve alguna de ellas. `calendarDates` queda vacío: Navega no tiene
 * equivalente y ninguna consulta lo lee.
 */
export function ensamblarTopologia(piezas: PiezasTopologia): GtfsDataset {
  const trips: ViajeGtfs[] = [];
  const stopTimes: StopTimeGtfs[] = [];
  const shapes: FormaGtfs[] = [];
  const stops = new Map<CodParada, ParadaGtfs>();
  const lineasConRutas = new Set<CodLinea>();

  for (const geometria of piezas.rutas) {
    const ruta = piezas.lineas.rutas.get(geometria.routeId);
    if (
      ruta === undefined ||
      ruta.sentido === null ||
      piezas.lineasOcultas.has(ruta.codLinea)
    ) {
      continue;
    }

    const tripId = tripIdDeRuta(ruta.routeId);
    const viaje: ViajeGtfs = {
      tripId,
      codLinea: ruta.codLinea,
      sentido: ruta.sentido,
    };
    if (ruta.destino !== undefined) {
      viaje.destino = ruta.destino;
    }
    trips.push(viaje);
    lineasConRutas.add(ruta.codLinea);

    let secuencia = 0;
    for (const codPar of geometria.codParadas) {
      const parada = piezas.paradas.get(codPar);
      if (parada === undefined) {
        continue;
      }
      secuencia += 1;
      stopTimes.push({
        tripId,
        codParada: parada.codParada,
        stopSequence: secuencia,
      });
      stops.set(parada.codParada, parada);
    }

    // Una LINESTRING válida necesita al menos dos puntos.
    if (geometria.puntos.length >= 2) {
      shapes.push({
        codLinea: ruta.codLinea,
        sentido: ruta.sentido,
        puntos: geometria.puntos,
      });
    }
  }

  const routes: RutaGtfs[] = [...lineasConRutas]
    .sort((a, b) => a - b)
    .map((codLinea) => {
      const ruta: RutaGtfs = { codLinea };
      const nombre = piezas.lineas.nombres.get(codLinea);
      if (nombre !== undefined) {
        ruta.nombre = nombre;
      }
      return ruta;
    });

  return {
    routes,
    trips,
    stops: [...stops.values()],
    stopTimes,
    calendarDates: [],
    shapes,
    destinos: derivarDestinos(trips),
  };
}

/** Líneas ocultas de `parametros` (conjunto vacío si el campo no viene). */
export function lineasOcultasDe(parametros: unknown): Set<number> {
  const ocultas = new Set<number>();
  if (esObjeto(parametros) && Array.isArray(parametros.lineasOcultas)) {
    for (const valor of parametros.lineasOcultas as unknown[]) {
      const id = entero(valor);
      if (id !== null) {
        ocultas.add(id);
      }
    }
  }
  return ocultas;
}

// ---------------------------------------------------------------------------
// Ciclo de recarga de topología (job `gtfs`)
// ---------------------------------------------------------------------------

/** Opciones comunes de los ciclos de Navega. */
export interface NavegaOpciones {
  /** Base de la API. Por defecto {@link NAVEGA_BASE_URL_DEFECTO}. */
  baseUrl?: string;
  /** Timeout por petición, en ms. Por defecto {@link TIMEOUT_NAVEGA_MS}. */
  timeoutMs?: number;
}

/** Resultado detallado de la recarga de topología, con el recuento por tabla. */
export interface ResultadoRecargaTopologia {
  resultado: IngestResult;
  recuento: {
    routes: number;
    trips: number;
    stops: number;
    stopTimes: number;
    shapes: number;
  };
}

const RECUENTO_VACIO: ResultadoRecargaTopologia["recuento"] = {
  routes: 0,
  trips: 0,
  stops: 0,
  stopTimes: 0,
  shapes: 0,
};

/** Error de una petición a Navega, con la URL afectada para `ingest_log`. */
class ErrorFuenteNavega extends Error {
  constructor(
    public readonly fuente: string,
    causa: unknown,
  ) {
    super(causa instanceof Error ? causa.message : String(causa));
    this.name = "ErrorFuenteNavega";
  }
}

/** GET + parseo JSON de un endpoint; etiqueta cualquier fallo con su URL. */
async function pedir(
  transport: HttpTransport,
  url: string,
  endpoint: string,
  timeoutMs: number,
): Promise<unknown> {
  try {
    return parsearJsonNavega(await transport.get(url, timeoutMs), endpoint);
  } catch (error) {
    throw new ErrorFuenteNavega(url, error);
  }
}

/**
 * Ejecuta la recarga de datos estáticos desde Navega (job `gtfs`, cada 24 h):
 *
 * 1. `parametros`, `lineas` y `paradas`: líneas ocultas, jerarquía de rutas y
 *    paradas con coordenadas.
 * 2. `rutasPrevistas` y `rutasActivas` de la jornada vigente: qué rutas están
 *    planificadas. Cada línea tiene varias configuraciones y solo una opera
 *    cada jornada; cargar las 304 rutas de la red mezclaría recorridos de feria
 *    y variantes sin servicio. Se usa la unión de ambas (las previstas cubren
 *    varias semanas, así que el conjunto es estable entre recargas).
 * 3. `rutas` de esas rutas, por lotes: paradas ordenadas y geometría.
 *
 * Contrato de errores (Requisitos 12.2, 12.4, 12.5), idéntico al de la recarga
 * GTFS: si cualquier petición falla o la respuesta no tiene la forma esperada,
 * **no se modifica nada** y se devuelve `estado: "fallo"` con la fuente
 * afectada. Tampoco se recarga si el resultado quedaría vacío (jornada no
 * disponible, API devolviendo listas vacías): vaciar las tablas estáticas
 * dejaría el mapa sin líneas ni paradas. Nunca lanza.
 */
export async function ejecutarRecargaTopologia(
  deps: IngestDeps,
  opciones: NavegaOpciones = {},
): Promise<ResultadoRecargaTopologia> {
  const ahora = (deps.now ?? (() => new Date()))();
  const runAt = ahora.toISOString();
  const baseUrl = opciones.baseUrl ?? NAVEGA_BASE_URL_DEFECTO;
  const timeoutMs = opciones.timeoutMs ?? TIMEOUT_NAVEGA_MS;
  const fallo = (fuente: string, error: unknown): ResultadoRecargaTopologia => ({
    resultado: {
      job: "gtfs",
      estado: "fallo",
      fuente,
      error: error instanceof Error ? error.message : String(error),
      runAt,
    },
    recuento: RECUENTO_VACIO,
  });

  let dataset: GtfsDataset;
  try {
    const get = (endpoint: string, params?: Record<string, string>) =>
      pedir(deps.transport, urlNavega(baseUrl, endpoint, params), endpoint, timeoutMs);

    const lineasOcultas = lineasOcultasDe(await get("parametros"));
    const lineas = indexarLineas(await get("lineas"));
    const paradas = indexarParadas(await get("paradas"));

    const day = jornadaServicio(ahora);
    const planificadas = new Set<number>([
      ...rutasPlanificadas(await get("rutasPrevistas", { day })),
      ...rutasPlanificadas(await get("rutasActivas", { day })),
    ]);
    // Solo se piden rutas conocidas en `lineas` y de líneas publicadas.
    const aPedir = [...planificadas]
      .filter((id) => {
        const ruta = lineas.rutas.get(id);
        return ruta !== undefined && !lineasOcultas.has(ruta.codLinea);
      })
      .sort((a, b) => a - b);
    if (aPedir.length === 0) {
      return fallo(
        urlNavega(baseUrl, "rutasPrevistas", { day }),
        `La jornada ${day} no tiene rutas planificadas en la API Navega.`,
      );
    }

    const rutas: GeometriaRuta[] = [];
    for (let i = 0; i < aPedir.length; i += RUTAS_POR_PETICION) {
      const lote = aPedir.slice(i, i + RUTAS_POR_PETICION).join(",");
      const url = urlNavega(baseUrl, "rutas", { routeId: lote });
      rutas.push(
        ...normalizarRutas(
          await pedir(
            deps.transport,
            url,
            "rutas",
            Math.max(timeoutMs, TIMEOUT_RUTAS_MS),
          ),
        ),
      );
    }

    dataset = ensamblarTopologia({ lineas, paradas, rutas, lineasOcultas });
  } catch (error) {
    return fallo(error instanceof ErrorFuenteNavega ? error.fuente : baseUrl, error);
  }

  if (
    dataset.routes.length === 0 ||
    dataset.stops.length === 0 ||
    dataset.shapes.length === 0
  ) {
    return fallo(
      baseUrl,
      "La topología de la API Navega quedó vacía tras normalizar " +
        `(${dataset.routes.length} líneas, ${dataset.stops.length} paradas, ` +
        `${dataset.shapes.length} recorridos); se conservan los datos previos.`,
    );
  }

  try {
    await deps.repository.recargarGtfs(dataset);
  } catch (error) {
    return fallo(baseUrl, error);
  }

  return {
    resultado: { job: "gtfs", estado: "ok", fuente: baseUrl, runAt },
    recuento: {
      routes: dataset.routes.length,
      trips: dataset.trips.length,
      stops: dataset.stops.length,
      stopTimes: dataset.stopTimes.length,
      shapes: dataset.shapes.length,
    },
  };
}

/**
 * Adapta {@link ejecutarRecargaTopologia} a la firma `RecargaGtfs` para
 * conectarlo en `IngestConfig.recargaGtfs`.
 */
export function crearRecargaTopologiaNavega(
  opciones: NavegaOpciones = {},
): RecargaGtfs {
  return async (deps) => {
    const { resultado } = await ejecutarRecargaTopologia(deps, opciones);
    return resultado;
  };
}

// ---------------------------------------------------------------------------
// Posiciones: `buses_servicios`
// ---------------------------------------------------------------------------

/** Topología que hace falta para interpretar un bus de `buses_servicios`. */
export interface ContextoBuses {
  /** `routeId` → sentido interno (1/2). */
  sentidoPorRuta: ReadonlyMap<number, Sentido>;
  /** Líneas que la EMT no publica. */
  lineasOcultas: ReadonlySet<number>;
}

/**
 * Normaliza la respuesta de `buses_servicios` a `PosicionCaptura`, separando
 * los buses que no se publican con su motivo. Lanza solo si falta el array
 * `buses`; un bus suelto malformado va a `descartadas`.
 *
 * Un bus se publica si está prestando servicio en su línea con posición fiable:
 *
 * - `vehicleLocationStatus` en {@link ESTADOS_EN_SERVICIO}; la API omite la
 *   clave en buses que se incorporan o retiran (→ `fuera_de_servicio`).
 * - Sin el bit `SIN_COMUNICACION`: su posición está congelada. Al no insertar
 *   captura, la última conocida envejece (el mapa la marca obsoleta) y sale
 *   del mapa al agotarse la ventana de servicio.
 * - Circulando por su propia línea (`lineId` = `currentLineId`), como hace la
 *   web de la EMT, y en una línea publicada.
 * - Con sentido resoluble por su ruta actual (`currentRouteId`, o `routeId`).
 *
 * `buses_servicios` no trae marca temporal por vehículo (el CSV sí traía
 * `last_update`), así que se usa el instante de ingesta: la respuesta tiene una
 * caché de 10 s, por lo que ese es el error máximo.
 */
export function normalizarBuses(
  json: unknown,
  contexto: ContextoBuses,
  capturedAt: string,
): ResultadoParseo {
  if (!esObjeto(json) || !Array.isArray(json.buses)) {
    formaInesperada("buses_servicios", "falta el array `buses`");
  }

  const validas: PosicionCaptura[] = [];
  const descartadas: FilaDescartada[] = [];

  for (const entrada of json.buses as unknown[]) {
    const bus: Objeto = esObjeto(entrada) ? entrada : {};
    const resultado = normalizarBus(bus, contexto, capturedAt);
    if (typeof resultado === "string") {
      descartadas.push({ fila: bus, motivo: resultado });
    } else {
      validas.push(resultado);
    }
  }

  return { validas, descartadas };
}

/** Normaliza un bus; devuelve la captura o el motivo del descarte. */
function normalizarBus(
  bus: Objeto,
  contexto: ContextoBuses,
  capturedAt: string,
): PosicionCaptura | MotivoDescarte {
  const codBus = entero(bus.vehicleId);
  if (codBus === null || codBus <= 0) {
    return "codBus_invalido";
  }

  const estado = entero(bus.vehicleLocationStatus);
  if (estado === null || !ESTADOS_EN_SERVICIO.has(estado)) {
    return "fuera_de_servicio";
  }

  const vehicleStatus = numero(bus.vehicleStatus) ?? 0;
  // División en vez de `&`: la máscara tiene bits por encima del 31.
  if (Math.floor(vehicleStatus / VEHICLE_STATUS_SIN_COMUNICACION) % 2 === 1) {
    return "sin_comunicacion";
  }

  const posicion = esObjeto(bus.vehiclePosition) ? bus.vehiclePosition : {};
  const lon = numero(posicion.lng);
  const lat = numero(posicion.lat);
  if (lon === null || lat === null) {
    return "coordenadas_invalidas";
  }

  const codLinea = entero(bus.lineId);
  if (codLinea === null || codLinea <= 0) {
    return "codLinea_invalido";
  }
  const lineaActual = entero(bus.currentLineId);
  if (lineaActual !== null && lineaActual !== codLinea) {
    return "fuera_de_servicio";
  }
  if (contexto.lineasOcultas.has(codLinea)) {
    return "linea_oculta";
  }

  const sentido =
    sentidoDeRuta(contexto, bus.currentRouteId) ??
    sentidoDeRuta(contexto, bus.routeId);
  if (sentido === null) {
    return "sentido_invalido";
  }

  const captura: PosicionCaptura = {
    codBus: codBus as CodBus,
    codLinea: codLinea as CodLinea,
    sentido,
    lon,
    lat,
    last_update: capturedAt,
    captured_at: capturedAt,
  };

  // Última parada rebasada (solo si el nodo es de tipo PARADA). Cuando no se
  // conoce, la API envía `[]` en lugar de un objeto.
  if (esObjeto(bus.lastNode) && bus.lastNode.type === 1) {
    const codPar = entero(bus.lastNode.num);
    if (codPar !== null) {
      captura.codParIni = String(codPar);
    }
  }

  return captura;
}

function sentidoDeRuta(contexto: ContextoBuses, routeId: unknown): Sentido | null {
  const id = entero(routeId);
  return id === null ? null : (contexto.sentidoPorRuta.get(id) ?? null);
}

/** Contexto de posiciones: lo de {@link ContextoBuses} más las líneas a pedir. */
export interface ContextoPosiciones extends ContextoBuses {
  /** Líneas publicadas, para el parámetro `lineId` de `buses_servicios`. */
  lineIds: number[];
}

/** Construye el contexto de posiciones a partir de `parametros` y `lineas`. */
export function construirContextoPosiciones(
  parametros: unknown,
  lineas: unknown,
): ContextoPosiciones {
  const lineasOcultas = lineasOcultasDe(parametros);
  const indice = indexarLineas(lineas);

  const sentidoPorRuta = new Map<number, Sentido>();
  for (const ruta of indice.rutas.values()) {
    if (ruta.sentido !== null) {
      sentidoPorRuta.set(ruta.routeId, ruta.sentido);
    }
  }
  const lineIds = [...indice.nombres.keys()]
    .filter((id) => !lineasOcultas.has(id))
    .sort((a, b) => a - b);

  if (lineIds.length === 0) {
    formaInesperada("lineas", "no hay ninguna línea publicada");
  }
  return { sentidoPorRuta, lineasOcultas, lineIds };
}

/**
 * Caché en memoria del {@link ContextoPosiciones} por base de API.
 *
 * El ciclo de posiciones corre cada pocos segundos y necesita saber qué líneas
 * pedir y el sentido de cada ruta; esa topología cambia como mucho una vez al
 * día. Se refresca al caducar el TTL y, si el refresco falla, se sigue con la
 * copia anterior: un fallo puntual de `lineas` no debe parar las posiciones.
 */
export class CacheContextoPosiciones {
  private readonly entradas = new Map<
    string,
    { contexto: ContextoPosiciones; caduca: number }
  >();

  constructor(
    private readonly ttlMs: number = TTL_CONTEXTO_POSICIONES_MS,
    private readonly ahora: () => number = Date.now,
  ) {}

  async obtener(
    transport: HttpTransport,
    baseUrl: string,
    timeoutMs: number,
  ): Promise<ContextoPosiciones> {
    const previa = this.entradas.get(baseUrl);
    if (previa !== undefined && this.ahora() < previa.caduca) {
      return previa.contexto;
    }

    try {
      const contexto = construirContextoPosiciones(
        parsearJsonNavega(
          await transport.get(urlNavega(baseUrl, "parametros"), timeoutMs),
          "parametros",
        ),
        parsearJsonNavega(
          await transport.get(urlNavega(baseUrl, "lineas"), timeoutMs),
          "lineas",
        ),
      );
      this.entradas.set(baseUrl, {
        contexto,
        caduca: this.ahora() + this.ttlMs,
      });
      return contexto;
    } catch (error) {
      if (previa !== undefined) {
        return previa.contexto;
      }
      throw error;
    }
  }
}

/**
 * Caché compartida del proceso. `POST /api/ingest` construye un scheduler por
 * petición; con una caché por instancia cada disparo manual volvería a bajar
 * `lineas`.
 */
const cacheContextoPorDefecto = new CacheContextoPosiciones();

/** Opciones del lector de posiciones de Navega. */
export interface LectorPosicionesNavegaOpciones {
  /** Base de la API. Por defecto {@link NAVEGA_BASE_URL_DEFECTO}. */
  baseUrl?: string;
  /** Caché del contexto. Por defecto, la compartida del proceso. */
  cache?: CacheContextoPosiciones;
}

/** URL con la que el ciclo de posiciones de Navega se registra en `ingest_log`. */
export function urlBusesServicios(
  baseUrl: string = NAVEGA_BASE_URL_DEFECTO,
): string {
  return urlNavega(baseUrl, "buses_servicios");
}

/**
 * Lector de posiciones sobre `buses_servicios`, para conectarlo en
 * `IngestConfig.posiciones.lector`. Pide todas las líneas publicadas en una
 * sola petición (el endpoint lo admite: ~80 KB para toda la flota).
 */
export function crearLectorPosicionesNavega(
  opciones: LectorPosicionesNavegaOpciones = {},
): LectorPosiciones {
  const baseUrl = opciones.baseUrl ?? NAVEGA_BASE_URL_DEFECTO;
  const cache = opciones.cache ?? cacheContextoPorDefecto;

  return async (transport, capturedAt, timeoutMs) => {
    const contexto = await cache.obtener(transport, baseUrl, timeoutMs);
    const url = urlNavega(baseUrl, "buses_servicios", {
      lineId: contexto.lineIds.join(","),
    });
    const cuerpo = await transport.get(url, timeoutMs);
    return normalizarBuses(
      parsearJsonNavega(cuerpo, "buses_servicios"),
      contexto,
      capturedAt,
    );
  };
}

// ---------------------------------------------------------------------------
// Calibración: `estimaciones`
// ---------------------------------------------------------------------------

/**
 * Normaliza la respuesta de `estimaciones` a minutos oficiales por parada y
 * línea. Lanza si falta el array `estimaciones` o el instante `tiempo`.
 *
 * Los minutos son `departureTime − tiempo`, que es la cuenta atrás que muestra
 * la web de la EMT (un valor negativo es "Ahora" → 0). Se descartan:
 *
 * - Las estimaciones `TEORICA`: salen del horario planificado, no de un bus
 *   localizado, y no sirven como verdad de referencia para el estimador.
 * - Los valores fuera de `[0, 120]` (mismo filtro que el scraping).
 *
 * A diferencia del scraping, aquí cada minuto lleva su línea real.
 */
export function normalizarEstimaciones(json: unknown): NuevoMinutoOficial[] {
  if (!esObjeto(json) || !Array.isArray(json.estimaciones)) {
    formaInesperada("estimaciones", "falta el array `estimaciones`");
  }
  const referencia = parsearInstante(json.tiempo);
  if (referencia === null) {
    formaInesperada("estimaciones", "falta el instante `tiempo`");
  }

  const minutos: NuevoMinutoOficial[] = [];
  for (const estimacion of listaDe(json.estimaciones)) {
    const codPar = entero(estimacion.codPar);
    const codLinea = esObjeto(estimacion.line) ? entero(estimacion.line.id) : null;
    const tipo = entero(estimacion.type) ?? 0;
    const salida =
      parsearInstante(estimacion.departureTime) ??
      parsearInstante(estimacion.arrivalTime);
    if (
      codPar === null ||
      codLinea === null ||
      salida === null ||
      tipo % 2 === ESTIMACION_TEORICA
    ) {
      continue;
    }
    const valor = Math.max(0, Math.round((salida - referencia) / 60_000));
    if (esMinutoValido(valor)) {
      minutos.push({ codParada: String(codPar), codLinea, minutos: valor });
    }
  }
  return minutos;
}

/** Opciones del ciclo de calibración sobre Navega. */
export interface CalibracionNavegaOpciones extends NavegaOpciones {
  /** Máximo de paradas por ciclo. Por defecto {@link MAX_PARADAS_CALIBRACION}. */
  maxParadas?: number;
  /**
   * Proveedor de los códigos de parada a muestrear. Por defecto, la primera
   * página de `listParadas` del repositorio.
   */
  obtenerCodParadas?: (
    repository: Repository,
    limite: number,
  ) => Promise<CodParada[]>;
}

async function obtenerCodParadasPorDefecto(
  repository: Repository,
  limite: number,
): Promise<CodParada[]> {
  const pagina = await repository.listParadas(undefined, { limite });
  return pagina.items.map((p) => p.codParada);
}

/**
 * Ciclo de calibración sobre `estimaciones` (job `calibracion`): muestrea las
 * paradas en **una sola petición** y guarda los minutos oficiales en
 * `official_minutes`. Sustituye al scraping de `informacionParada.html`
 * (`lib/calibrationCycle.ts`), que hacía una petición por parada y no podía
 * asociar cada minuto a su línea.
 *
 * Mismo contrato (Requisitos 5.1, 5.2, 5.5): los minutos son solo verdad de
 * referencia offline, nunca entran en las respuestas de producción; si la
 * fuente falla, el muestreo se omite y se devuelve `estado: "fallo"`. Nunca
 * lanza.
 */
export async function ejecutarCalibracionNavega(
  deps: IngestDeps,
  opciones: CalibracionNavegaOpciones = {},
): Promise<IngestResult> {
  const ahora = (deps.now ?? (() => new Date()))();
  const runAt = ahora.toISOString();
  const baseUrl = opciones.baseUrl ?? NAVEGA_BASE_URL_DEFECTO;
  const timeoutMs = opciones.timeoutMs ?? TIMEOUT_NAVEGA_MS;
  const maxParadas = opciones.maxParadas ?? MAX_PARADAS_CALIBRACION;
  const obtener = opciones.obtenerCodParadas ?? obtenerCodParadasPorDefecto;
  const fuente = urlNavega(baseUrl, "estimaciones");
  const fallo = (error: unknown): IngestResult => ({
    job: "calibracion",
    estado: "fallo",
    fuente,
    error: error instanceof Error ? error.message : String(error),
    runAt,
  });

  try {
    // `codPar` es numérico en Navega; un código que no lo sea no existe allí.
    const codParadas = (await obtener(deps.repository, maxParadas)).filter(
      (cod) => /^\d+$/.test(cod),
    );
    if (codParadas.length === 0) {
      return { job: "calibracion", estado: "ok", fuente, runAt };
    }

    const cuerpo = await deps.transport.get(
      urlNavega(baseUrl, "estimaciones", { codPar: codParadas.join(",") }),
      timeoutMs,
    );
    const minutos = normalizarEstimaciones(
      parsearJsonNavega(cuerpo, "estimaciones"),
    );
    if (minutos.length > 0) {
      await deps.repository.insertMinutosOficiales(minutos);
    }
  } catch (error) {
    return fallo(error);
  }

  return { job: "calibracion", estado: "ok", fuente, runAt };
}

/**
 * Adapta {@link ejecutarCalibracionNavega} a la firma `CicloCalibracion` para
 * conectarlo en `IngestConfig.calibracion`.
 */
export function crearCicloCalibracionNavega(
  opciones: CalibracionNavegaOpciones = {},
): CicloCalibracion {
  return async (deps) => ejecutarCalibracionNavega(deps, opciones);
}
