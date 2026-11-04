/**
 * Almacenes Postgres de los adaptadores de `AuthProvider`.
 *
 * - {@link createPostgresLoginAttemptStore}: contador de intentos fallidos por
 *   identidad sobre `auth_login_attempts` (migración 0004). Lo usan los dos
 *   adaptadores; al vivir en la base de datos, el bloqueo se comparte entre
 *   instancias serverless.
 * - {@link createPostgresLocalAuthStore}: credenciales y sesiones del adaptador
 *   `local-auth` sobre `local_auth_users`/`local_auth_sessions` (migración 0005).
 */

import type { QueryClient } from "@/lib/adapters/repository-postgres";
import type { LocalAuthStore } from "@/lib/adapters/auth-local";
import { ESTADO_INICIAL, type LoginAttemptStore } from "@/lib/loginLockout";

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function createPostgresLoginAttemptStore(client: QueryClient): LoginAttemptStore {
  return {
    async leer(identidad) {
      const { rows } = await client.query<{ fallos: number; bloqueado_hasta: unknown }>(
        "SELECT fallos, bloqueado_hasta FROM auth_login_attempts WHERE identidad = $1",
        [identidad],
      );
      if (rows.length === 0) return ESTADO_INICIAL;
      return { fallos: Number(rows[0].fallos), bloqueadoHasta: toIso(rows[0].bloqueado_hasta) };
    },
    async guardar(identidad, estado) {
      await client.query(
        "INSERT INTO auth_login_attempts (identidad, fallos, bloqueado_hasta) " +
          "VALUES ($1, $2, $3) ON CONFLICT (identidad) DO UPDATE " +
          "SET fallos = EXCLUDED.fallos, bloqueado_hasta = EXCLUDED.bloqueado_hasta",
        [identidad, estado.fallos, estado.bloqueadoHasta],
      );
    },
  };
}

export function createPostgresLocalAuthStore(client: QueryClient): LocalAuthStore {
  return {
    async buscarUsuario(email) {
      const { rows } = await client.query<{ user_id: string; email: string; password_hash: string }>(
        "SELECT user_id, email, password_hash FROM local_auth_users WHERE lower(email) = $1",
        [email],
      );
      if (rows.length === 0) return null;
      return {
        userId: String(rows[0].user_id),
        email: rows[0].email,
        passwordHash: rows[0].password_hash,
      };
    },
    async crearSesion(tokenHash, userId, ahora) {
      await client.query(
        "INSERT INTO local_auth_sessions (token_hash, user_id, created_at, last_access) " +
          "VALUES ($1, $2, $3, $3)",
        [tokenHash, userId, ahora.toISOString()],
      );
    },
    async buscarSesion(tokenHash) {
      const { rows } = await client.query<{ user_id: string; email: string; last_access: unknown }>(
        "SELECT s.user_id, u.email, s.last_access FROM local_auth_sessions s " +
          "JOIN local_auth_users u ON u.user_id = s.user_id WHERE s.token_hash = $1",
        [tokenHash],
      );
      if (rows.length === 0) return null;
      return {
        userId: String(rows[0].user_id),
        email: rows[0].email,
        lastAccess: new Date(toIso(rows[0].last_access) ?? 0),
      };
    },
    async tocarSesion(tokenHash, ahora) {
      await client.query(
        "UPDATE local_auth_sessions SET last_access = $2 WHERE token_hash = $1",
        [tokenHash, ahora.toISOString()],
      );
    },
    async borrarSesion(tokenHash) {
      await client.query("DELETE FROM local_auth_sessions WHERE token_hash = $1", [tokenHash]);
    },
  };
}
