-- =============================================================================
-- Migración 0002 — Extensiones de ingesta programada (pg_cron, pg_net)
-- Buses de Málaga — Tarea 1.5
--
-- Habilita las extensiones que soportan la ingesta periódica dentro de la base
-- de datos (jobs `pg_cron` que disparan peticiones HTTP con `pg_net`). Los
-- schedules y funciones concretos se definen en el Hito 4 (tarea 17.x).
--
-- ⚠️  SOLO para los modos `supabase-cloud` y `supabase-local`.
--     NO ejecutar en Vía B (`local-postgres`): un Postgres + PostGIS puro no
--     dispone de `pg_cron` ni `pg_net`, por lo que esta migración fallaría.
--     En ese modo la ingesta la dispara el adaptador `node-worker` (tarea 3.2)
--     y estas extensiones no son necesarias.
--
-- Requisitos: 12.1, 12.2
-- =============================================================================

-- Programación de tareas dentro de Postgres (polling de posiciones cada 60 s,
-- recarga GTFS cada 24 h, purga cada 60 s).
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Peticiones HTTP salientes desde Postgres (GET a las fuentes de datos de la
-- EMT con timeout de 30 s).
CREATE EXTENSION IF NOT EXISTS pg_net;
