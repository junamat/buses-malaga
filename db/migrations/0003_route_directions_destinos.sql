-- =============================================================================
-- Migración 0003 — Destino por (Linea, Sentido) (route_directions)
-- Buses de Málaga — Tarea 22.1
--
-- Añade la tabla `route_directions`, que modela el letrero de Destino legible
-- (p. ej. "San Andrés") asociado a cada `(route_id, sentido)`, derivado del
-- `trip_headsign` del GTFS. Cada Bus hereda el Destino de su `(codLinea,
-- sentido)` y la API/el frontend lo muestran junto al Sentido cuando existe.
--
-- El Destino representativo por par se deriva de forma determinista (headsign
-- más frecuente) durante la recarga GTFS y se repuebla en la misma recarga
-- transaccional (tareas 22.2/22.3). La unicidad por `(route_id, sentido)`
-- garantiza un único Destino por sentido de cada línea.
--
-- Portabilidad: migración incremental sobre el núcleo de 0001. Solo depende de
-- la tabla `routes` (presente en los tres modos `supabase-cloud`,
-- `supabase-local`, `local-postgres`); no requiere `pg_cron`/`pg_net`.
--
-- Requisitos: 2.8, 12.2
-- =============================================================================

-- `route_directions` — Destino legible por `(route_id, sentido)`. `route_id`
-- referencia a `routes`; `sentido` es el entero de dirección (1/2 en la
-- convención de la EMT); `destino` es el headsign representativo del GTFS.
-- La restricción de unicidad por `(route_id, sentido)` asegura un único
-- Destino por sentido de cada línea.
CREATE TABLE IF NOT EXISTS route_directions (
    route_id    bigint  NOT NULL REFERENCES routes (route_id) ON DELETE CASCADE,
    sentido     integer NOT NULL,
    destino     text    NOT NULL,
    UNIQUE (route_id, sentido)
);
