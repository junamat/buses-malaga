#!/usr/bin/env node
/**
 * Crea (o actualiza la contraseña de) un usuario del adaptador `local-auth`
 * en el Postgres local (modo `local-postgres`, migración 0005).
 *
 *   DATABASE_URL=postgresql://... node scripts/crear-usuario-local.mjs <email> <password>
 *
 * El formato del hash coincide con `hashPassword` de `lib/adapters/auth-local.ts`:
 * `scrypt$<saltB64>$<hashB64>` con clave de 64 bytes.
 */

import { randomBytes, scryptSync } from "node:crypto";
import pg from "pg";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Uso: node scripts/crear-usuario-local.mjs <email> <password>");
  process.exit(1);
}

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/buses_malaga";

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);
const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const { rows } = await client.query(
    "INSERT INTO local_auth_users (email, password_hash) VALUES ($1, $2) " +
      "ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash " +
      "RETURNING user_id",
    [email.trim().toLowerCase(), passwordHash],
  );
  console.log(`Usuario ${email.trim().toLowerCase()} → user_id ${rows[0].user_id}`);
} finally {
  await client.end();
}
