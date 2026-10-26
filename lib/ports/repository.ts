/**
 * Puerto `Repository` — acceso a Postgres/PostGIS.
 *
 * Es la única puerta de acceso a la base de datos para toda la lógica de
 * negocio (API_REST, Estimador_ETA, Servicio_Calibracion, Servicio_Favoritos,
 * Servicio_Aportaciones y la función de ingesta). La lógica de negocio depende
 * de esta interfaz, nunca de un cliente de plataforma concreto.
 *
 * Existe una sola implementación sobre un driver de Postgres estándar, válida
 * para los tres modos (`supabase-cloud`, `supabase-local`, `local-postgres`):
 * la lógica SQL/PostGIS (map-matching, distancia, point-in-polygon, purga) es
 * portable porque PostGIS es idéntico en los tres backends. Lo único que varía
 * por modo es la cadena de conexión inyectada según `BACKEND_PROVIDER`.
 *
 * Nota de alcance: la superficie concreta de métodos de consulta y persistencia
 * se irá ampliando en las tareas que implementan cada servicio (ETA, favoritos,
 * aportaciones, ingesta, calibración). Aquí se fija el contrato común mínimo y
 * los puntos de extensión geométricos/de ciclo de vida que el diseño exige.
 */

import type {
  Bus,
  CodBus,
  CodLinea,
  CodParada,
  DestinoGtfs,
  Eta,
  Favorito,
  Aportacion,
  GtfsDataset,
  Linea,
  Parada,
  PosicionCaptura,
  Sentido,
  TipoFavorito,
} from "@/lib/types";
import type { IngestResult } from "@/lib/ports/ingest-scheduler";

/**
 * Criterio de filtrado de buses/paradas. Las Lineas y el Sentido se combinan
 * con lógica AND (Requisito 3.3).
 */
export interface FiltroPosiciones {
  codLineas?: CodLinea[];
  sentido?: Sentido;
}

/** Parámetros de paginación por cursor/offset (máx. 200 por página). */
export interface Paginacion {
  limite?: number;
  cursor?: string | null;
}

/** Página de resultados con cursor a la página siguiente. */
export interface Pagina<T> {
  items: T[];
  /** Cursor/offset de la página siguiente, `null` si no hay más. */
  next: string | null;
}

/** Parada con la distancia (en metros) calculada respecto a un punto. */
export interface ParadaCercana extends Parada {
  /** Distancia a lo largo del terreno en metros, calculada con PostGIS. */
  distanciaMetros: number;
}

/**
 * Datos de alta de una aportación (los campos derivados —`id`, `created_at`—
 * los asigna la implementación).
 */
export interface NuevaAportacion {
  userId: string;
  codBus: CodBus;
  opcion: string;
}

/**
 * Datos de alta de un favorito (el `id` lo asigna la implementación).
 */
export interface NuevoFavorito {
  userId: string;
  tipo: TipoFavorito;
  codParada?: CodParada;
  codLinea?: CodLinea;
}

/**
 * Minuto oficial muestreado por el Servicio_Calibracion para una parada/línea.
 * Es dato de calibración offline: se almacena en `official_minutes` y **nunca**
 * forma parte de las respuestas de producción (Requisito 5.4, Property 16). El
 * `id` y el `sampled_at` los asigna la implementación.
 */
export interface NuevoMinutoOficial {
  codParada: CodParada;
  codLinea: CodLinea;
  /** Minutos oficiales ya filtrados al rango válido `[0, 120]` (Requisito 5.2). */
  minutos: number;
}

/**
 * Repositorio de datos del modelo interno. Todas las coordenadas se manejan en
 * orden `[lon, lat]` numérico, coherente con el GeoJSON canónico de salida.
 */
export interface Repository {
  // --- Lecturas de entidades estáticas (GTFS) -----------------------------

  /** Lista de Lineas, paginada. */
  listLineas(pagina?: Paginacion): Promise<Pagina<Linea>>;

  /** Lista de Paradas, paginada y opcionalmente filtrada por Linea. */
  listParadas(
    filtro?: { codLinea?: CodLinea },
    pagina?: Paginacion,
  ): Promise<Pagina<Parada>>;

  /**
   * Destinos representativos por `(codLinea, sentido)` (tabla
   * `route_directions`), opcionalmente restringidos a un conjunto de líneas.
   * El llamador (la API) construye un mapa `(codLinea, sentido) → destino` para
   * heredar el Destino a cada Bus en `GET /api/buses` y exponerlo por sentido en
   * `GET /api/lineas`. Sin filtro devuelve todos los destinos conocidos. Un par
   * sin Destino simplemente no aparece en el resultado. (Requisitos 2.8, 11.10)
   */
  listDestinos(filtro?: { codLineas?: CodLinea[] }): Promise<DestinoGtfs[]>;

  /**
   * Hasta `limite` paradas dentro de `radioMetros` del punto dado, ordenadas
   * por distancia ascendente, con la distancia en metros (PostGIS).
   * (Requisitos 6.2, 6.6)
   */
  findParadasCercanas(
    lon: number,
    lat: number,
    radioMetros: number,
    limite: number,
  ): Promise<ParadaCercana[]>;

  /**
   * Devuelve la Parada con el `codParada` dado, o `null` si no existe. Lo usa el
   * endpoint de ETA para distinguir "parada inexistente" (404, Requisito 11.7)
   * de "parada existente sin ETA disponible" (200 con `disponible: false`,
   * Requisito 11.6).
   */
  findParada(codParada: CodParada): Promise<Parada | null>;

  // --- Posiciones de buses -------------------------------------------------

  /**
   * Posiciones vigentes de buses (última captura por `codBus`), filtrables y
   * paginadas. (Requisitos 2.x, 3.x, 11.x)
   */
  listBuses(
    filtro?: FiltroPosiciones,
    pagina?: Paginacion,
  ): Promise<Pagina<Bus>>;

  // --- Estimación de llegada (ETA) ----------------------------------------

  /**
   * Estimación de llegada del siguiente bus por línea/sentido a la parada dada.
   *
   * Ejecuta el map-matching PostGIS (proyección de la última posición de cada
   * bus sobre el `shape` con `ST_LineLocatePoint`/`ST_LineSubstring`, distancia
   * a lo largo del recorrido entre bus y parada, velocidad inferida de capturas
   * consecutivas por `last_update`) y aplica la lógica pura de selección de
   * `lib/eta.ts`: ETA mínimo por línea con cota de 60 min, "no disponible" si la
   * posición más reciente supera 120 s, minutos enteros y margen ±1 min
   * (Requisitos 4.1, 4.2, 4.4, 4.6, 4.7).
   *
   * La salida **nunca** incluye los minutos oficiales de `official_minutes`
   * (Requisito 5.4, Property 16). Un `codParada` sin líneas/posiciones vigentes
   * devuelve un conjunto vacío o entradas con `disponible: false`, nunca un
   * error (el "no encontrado" lo decide la existencia de la parada en la API).
   */
  etaPorParada(codParada: CodParada): Promise<Eta[]>;

  // --- Recarga de datos estáticos GTFS (cada 24 h) ------------------------

  /**
   * Repuebla las tablas estáticas GTFS (`routes`, `trips`, `stops`,
   * `stop_times`, `calendar_dates`, `shapes`, `route_directions`) a partir de
   * un conjunto ya normalizado, reconstruyendo la geometría
   * `shapes.geom_linestring` (PostGIS LINESTRING, SRID 4326) desde los puntos de
   * cada recorrido y repoblando los Destinos por `(codLinea, sentido)` en
   * `route_directions` (Requisito 2.8).
   *
   * La recarga es atómica (todo o nada): se ejecuta en una transacción de modo
   * que un fallo a mitad de camino conserva los datos previos sin dejar las
   * tablas en un estado intermedio (Requisitos 12.2, 12.4). Lo invoca la
   * función de recarga GTFS compartida (`lib/gtfs.ts`).
   */
  recargarGtfs(dataset: GtfsDataset): Promise<void>;

  /**
   * Inserta capturas crudas de posición en `bus_positions`. Lo invoca la
   * función de ingesta compartida. (Requisito 12.1)
   */
  insertPosiciones(capturas: PosicionCaptura[]): Promise<void>;

  /**
   * Elimina posiciones crudas con antigüedad mayor que la ventana de retención
   * (en segundos) y devuelve el número de filas purgadas. (Requisito 12.6)
   */
  purgePosicionesAntiguas(ventanaSegundos: number): Promise<number>;

  // --- Observabilidad de la ingesta ---------------------------------------

  /**
   * Registra el resultado de un ciclo de ingesta en `ingest_log` con la fuente
   * afectada, el estado (`ok`/`fallo`) y el instante de ejecución. Lo invocan
   * los adaptadores de `IngestScheduler` tras cada ciclo para dejar constancia
   * del resultado, de modo que un fallo de fuente quede registrado sin alterar
   * los datos previos (Requisito 12.5). No debe propagar su propio fallo de
   * forma que enmascare el resultado del ciclo: el llamador lo aísla.
   */
  logIngesta(result: IngestResult): Promise<void>;

  // --- Calibración (minutos oficiales, offline) ---------------------------

  /**
   * Persiste minutos oficiales muestreados por el Servicio_Calibracion en
   * `official_minutes` (Requisitos 5.1, 5.2). Datos de calibración offline,
   * excluidos de las respuestas de producción (Requisito 5.4, Property 16). Lo
   * invoca el ciclo de calibración (tarea 8.2) con los valores ya filtrados al
   * rango válido por `lib/calibration.ts`. Un conjunto vacío no hace nada.
   */
  insertMinutosOficiales(minutos: NuevoMinutoOficial[]): Promise<void>;

  // --- Favoritos y aportaciones -------------------------------------------

  listFavoritos(userId: string): Promise<Favorito[]>;
  createFavorito(fav: NuevoFavorito): Promise<Favorito>;
  deleteFavorito(userId: string, id: string): Promise<void>;

  listAportacionesVigentes(codBus: CodBus): Promise<Aportacion[]>;
  createAportacion(aportacion: NuevaAportacion): Promise<Aportacion>;
}
