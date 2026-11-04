-- =============================================================================
-- Migración 0005 — Credenciales y sesiones del adaptador `local-auth`
-- Buses de Málaga — Tarea 14.3
--
-- Solo para el modo `local-postgres` (Vía B), donde no hay Supabase Auth
-- (GoTrue). Los modos `supabase-*` la omiten: allí las credenciales y sesiones
-- las gestiona GoTrue en el esquema `auth`.
--
-- - `local_auth_users`: credenciales locales; `password_hash` en formato
--   `scrypt$<saltB64>$<hashB64>` (ver `lib/adapters/auth-local.ts`).
-- - `local_auth_sessions`: sesiones activas. Se guarda el SHA-256 del token,
--   nunca el token en claro. La sesión caduca a los 30 días desde el último
--   acceso (`last_access`, Requisito 7.2).
--
-- Requisitos: 7.1, 7.2, 7.5
-- =============================================================================

CREATE TABLE IF NOT EXISTS local_auth_users (
    user_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email          text NOT NULL UNIQUE,
    password_hash  text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS local_auth_sessions (
    token_hash   text PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES local_auth_users (user_id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_access  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_local_auth_sessions_user_id
    ON local_auth_sessions (user_id);
