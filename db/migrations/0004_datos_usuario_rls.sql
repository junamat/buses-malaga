-- =============================================================================
-- Migración 0004 — Datos de usuario con Row Level Security
-- Buses de Málaga — Tarea 12.1
--
-- Añade las tablas de usuario `favorites` y `vehicle_contributions`, activa RLS
-- sobre ambas con políticas por `auth.uid() = user_id`, y crea la tabla
-- `auth_login_attempts` que sostiene el bloqueo tras 5 intentos fallidos de
-- inicio de sesión (Requisito 7.4) en los dos adaptadores de `AuthProvider`.
--
-- Portabilidad: los tres modos aplican esta migración. Supabase ya trae los
-- roles `anon`/`authenticated` y la función `auth.uid()`; en `local-postgres`
-- (Postgres + PostGIS puro) no existen, así que se crean aquí **solo si faltan**
-- con la misma semántica que Supabase: `auth.uid()` lee el `sub` de los claims
-- de la petición (`request.jwt.claims` / `request.jwt.claim.sub`). El
-- repositorio fija esos claims y hace `SET LOCAL ROLE authenticated` en las
-- operaciones de usuario, de modo que RLS se aplica igual en los tres modos.
--
-- Sin FK hacia `stops`/`routes`: la recarga GTFS diaria repuebla esas tablas y
-- un `ON DELETE CASCADE` borraría los favoritos del usuario. La existencia del
-- elemento referenciado la valida el Servicio_Favoritos al dar de alta
-- (Requisito 8.4). La FK hacia `auth.users` solo se añade cuando esa tabla
-- existe (modos `supabase-*`).
--
-- Requisitos: 7.4, 7.6, 8.1, 8.9, 9.1
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Roles y `auth.uid()` (solo si no existen: en Supabase ya están)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'uid'
    ) THEN
        CREATE SCHEMA IF NOT EXISTS auth;
        GRANT USAGE ON SCHEMA auth TO PUBLIC;
        CREATE FUNCTION auth.uid() RETURNS uuid
            LANGUAGE sql STABLE
        AS $f$
            SELECT coalesce(
                nullif(current_setting('request.jwt.claim.sub', true), ''),
                (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
            )::uuid
        $f$;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- `favorites` — Parada, Linea o combinación Parada+Linea por usuario
-- -----------------------------------------------------------------------------
-- La unicidad por (user_id, tipo, cod_parada, cod_linea) trata los NULL como
-- iguales (NULLS NOT DISTINCT, Postgres ≥ 15): sin ello dos favoritos de tipo
-- `parada` con `cod_linea` NULL no colisionarían (Requisito 8.9).
CREATE TABLE IF NOT EXISTS favorites (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL,
    tipo        text NOT NULL,
    cod_parada  text,
    cod_linea   bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT favorites_tipo_valido CHECK (
        (tipo = 'parada' AND cod_parada IS NOT NULL AND cod_linea IS NULL)
        OR (tipo = 'linea' AND cod_parada IS NULL AND cod_linea IS NOT NULL)
        OR (tipo = 'parada_linea' AND cod_parada IS NOT NULL AND cod_linea IS NOT NULL)
    ),
    CONSTRAINT favorites_unicidad
        UNIQUE NULLS NOT DISTINCT (user_id, tipo, cod_parada, cod_linea)
);

-- -----------------------------------------------------------------------------
-- `vehicle_contributions` — aportaciones por vehículo (vigencia 60 min)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_contributions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL,
    cod_bus     bigint NOT NULL,
    opcion      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Consulta de vigentes por vehículo (Requisitos 9.3, 9.6).
CREATE INDEX IF NOT EXISTS idx_vehicle_contributions_bus_created
    ON vehicle_contributions (cod_bus, created_at);

-- FK hacia `auth.users` solo donde existe (Supabase); en `local-postgres` el
-- `user_id` lo resuelve el adaptador `local-auth`.
DO $$
BEGIN
    IF to_regclass('auth.users') IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'favorites_user_id_fkey'
        ) THEN
            ALTER TABLE favorites ADD CONSTRAINT favorites_user_id_fkey
                FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_contributions_user_id_fkey'
        ) THEN
            ALTER TABLE vehicle_contributions ADD CONSTRAINT vehicle_contributions_user_id_fkey
                FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;
        END IF;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_contributions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON favorites TO authenticated;
GRANT SELECT ON vehicle_contributions TO anon, authenticated;
GRANT INSERT ON vehicle_contributions TO authenticated;

-- Favoritos: cada usuario solo ve, crea y borra los suyos.
DROP POLICY IF EXISTS favorites_select_propios ON favorites;
CREATE POLICY favorites_select_propios ON favorites
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS favorites_insert_propios ON favorites;
CREATE POLICY favorites_insert_propios ON favorites
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS favorites_delete_propios ON favorites;
CREATE POLICY favorites_delete_propios ON favorites
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Aportaciones: la lectura es pública porque cualquier usuario que consulta un
-- Bus ve la información aportada (Requisito 9.3); el alta solo en nombre propio.
-- No hay políticas de UPDATE/DELETE: las aportaciones ya registradas no se
-- modifican (Requisito 9.5).
DROP POLICY IF EXISTS vehicle_contributions_select_todos ON vehicle_contributions;
CREATE POLICY vehicle_contributions_select_todos ON vehicle_contributions
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS vehicle_contributions_insert_propias ON vehicle_contributions;
CREATE POLICY vehicle_contributions_insert_propias ON vehicle_contributions
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- `auth_login_attempts` — intentos fallidos consecutivos por identidad
-- -----------------------------------------------------------------------------
-- RLS activo y sin políticas: solo el dueño de la tabla (la conexión del
-- servidor) la lee y escribe; en Supabase queda oculta a la API pública.
CREATE TABLE IF NOT EXISTS auth_login_attempts (
    identidad        text PRIMARY KEY,
    fallos           integer NOT NULL DEFAULT 0,
    bloqueado_hasta  timestamptz
);

ALTER TABLE auth_login_attempts ENABLE ROW LEVEL SECURITY;
