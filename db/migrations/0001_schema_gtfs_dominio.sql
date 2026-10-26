-- =============================================================================
-- Migración 0001 — Esquema GTFS + dominio (PostGIS)
-- Buses de Málaga — Tarea 1.5
--
-- Crea el esquema estático GTFS, la geometría de recorridos (PostGIS
-- LINESTRING), las posiciones crudas de vehículos y las tablas de
-- calibración/observabilidad.
--
-- Portabilidad: esta migración es válida para los tres modos de ejecución
-- (`supabase-cloud`, `supabase-local`, `local-postgres`). Solo requiere la
-- extensión `postgis`, disponible en los tres. Las extensiones `pg_cron` y
-- `pg_net` (necesarias únicamente para la ingesta programada en los modos
-- Supabase) se habilitan en la migración incremental 0002, que NO debe
-- ejecutarse en un Postgres puro (Vía B `local-postgres`) donde no existen.
--
-- Las tablas de usuario (`favorites`, `vehicle_contributions`) y su RLS se
-- añaden como migración incremental en el Hito 3 (tarea 12.1).
-- Requisitos: 4.2, 12.1, 12.2, 12.5
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensiones (núcleo portable)
-- -----------------------------------------------------------------------------
-- PostGIS da soporte a la geometría de `shapes` (LINESTRING, SRID 4326) y al
-- map-matching/distancias que viven en SQL (Requisito 4.2).
CREATE EXTENSION IF NOT EXISTS postgis;

-- =============================================================================
-- Tablas estáticas GTFS (+ nombres legibles), recarga diaria
-- =============================================================================

-- `routes` — líneas; `route_id` (= codLinea) es la clave de join universal.
CREATE TABLE IF NOT EXISTS routes (
    route_id    bigint PRIMARY KEY,
    nombre      text
);

-- `trips` — servicios; cada trip pertenece a una línea y tiene un sentido.
CREATE TABLE IF NOT EXISTS trips (
    trip_id     text PRIMARY KEY,
    route_id    bigint NOT NULL REFERENCES routes (route_id) ON DELETE CASCADE,
    sentido     integer
);

CREATE INDEX IF NOT EXISTS idx_trips_route_id ON trips (route_id);

-- `stops` — paradas con nombre legible y coordenadas numéricas [lon, lat].
CREATE TABLE IF NOT EXISTS stops (
    cod_parada  text PRIMARY KEY,
    nombre      text NOT NULL,
    lon         double precision NOT NULL,
    lat         double precision NOT NULL
);

-- `stop_times` — orden de paradas por trip (stop_sequence). Deriva el
-- recorrido ordenado y las líneas que sirven cada parada.
CREATE TABLE IF NOT EXISTS stop_times (
    trip_id       text NOT NULL REFERENCES trips (trip_id) ON DELETE CASCADE,
    stop_id       text NOT NULL REFERENCES stops (cod_parada) ON DELETE CASCADE,
    stop_sequence integer NOT NULL,
    PRIMARY KEY (trip_id, stop_sequence)
);

CREATE INDEX IF NOT EXISTS idx_stop_times_stop_id ON stop_times (stop_id);

-- `calendar_dates` — excepciones de servicio por línea y fecha.
CREATE TABLE IF NOT EXISTS calendar_dates (
    route_id        bigint NOT NULL REFERENCES routes (route_id) ON DELETE CASCADE,
    fecha           date NOT NULL,
    exception_type  integer NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_dates_route_id ON calendar_dates (route_id);

-- `shapes` — geometría de recorrido por línea/sentido como PostGIS LINESTRING
-- (SRID 4326). Usada en map-matching y distancias a lo largo del recorrido.
CREATE TABLE IF NOT EXISTS shapes (
    route_id        bigint NOT NULL REFERENCES routes (route_id) ON DELETE CASCADE,
    sentido         integer NOT NULL,
    geom_linestring geometry(LineString, 4326) NOT NULL
);

-- Índice GiST espacial sobre la geometría de recorrido.
CREATE INDEX IF NOT EXISTS idx_shapes_geom_linestring
    ON shapes USING GIST (geom_linestring);

-- Acceso directo por línea/sentido para el map-matching.
CREATE INDEX IF NOT EXISTS idx_shapes_route_sentido ON shapes (route_id, sentido);

-- =============================================================================
-- Posiciones crudas de vehículos (ventana corta, purgada por job de ingesta)
-- =============================================================================

-- `bus_positions` — una fila por captura de vehículo. Varias capturas por
-- `cod_bus` coexisten dentro de la ventana de retención (≤ 21600 s); la
-- velocidad se infiere comparando capturas consecutivas por `last_update`.
-- Coordenadas numéricas en orden [lon, lat] a la salida.
CREATE TABLE IF NOT EXISTS bus_positions (
    cod_bus     bigint NOT NULL,
    cod_linea   bigint NOT NULL,
    sentido     integer,
    lon         double precision NOT NULL,
    lat         double precision NOT NULL,
    cod_par_ini text,
    last_update timestamptz NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT now()
);

-- Índice por vehículo: selección de la captura más reciente y agrupación de
-- capturas consecutivas para inferir velocidad.
CREATE INDEX IF NOT EXISTS idx_bus_positions_cod_bus ON bus_positions (cod_bus);

-- Índice por antigüedad: purga eficiente de la ventana de retención.
CREATE INDEX IF NOT EXISTS idx_bus_positions_last_update ON bus_positions (last_update);

-- =============================================================================
-- Calibración y observabilidad
-- =============================================================================

-- `official_minutes` — minutos oficiales muestreados por parada/línea, solo
-- para calibración offline del estimador. EXCLUIDOS de las respuestas de
-- producción.
CREATE TABLE IF NOT EXISTS official_minutes (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cod_parada  text NOT NULL,
    cod_linea   bigint NOT NULL,
    minutos     integer NOT NULL,
    sampled_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_official_minutes_parada_linea
    ON official_minutes (cod_parada, cod_linea);

-- `ingest_log` — registro de ejecuciones de ingesta: fuente, estado (ok/fallo)
-- e instante de ejecución (Requisito 12.5). Un fallo de fuente queda aquí
-- registrado sin alterar los datos previos.
CREATE TABLE IF NOT EXISTS ingest_log (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fuente  text NOT NULL,
    estado  text NOT NULL,
    run_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_log_run_at ON ingest_log (run_at);
