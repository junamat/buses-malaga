/**
 * Tests de integración de los datos de usuario contra Postgres real (tarea
 * 12.2): unicidad de `favorites`, aislamiento por `user_id` con RLS, y los
 * almacenes de auth sobre `auth_login_attempts`/`local_auth_*`.
 *
 * Corren contra un Postgres + PostGIS local con las migraciones 0001, 0003,
 * 0004 y 0005 aplicadas (modo `local-postgres`), sin Supabase. Se omiten si
 * `TEST_DATABASE_URL` no está definida. **Vacían** las tablas de usuario, así
 * que nunca deben apuntar a una base con datos reales. Ver `README.dev.md`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";

import {
  PostgresRepository,
  crearQueryClientPool,
} from "@/lib/adapters/repository-postgres";
import {
  createPostgresLocalAuthStore,
  createPostgresLoginAttemptStore,
} from "@/lib/adapters/auth-store-postgres";
import { createLocalAuthProvider, hashPassword } from "@/lib/adapters/auth-local";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BEA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe.skipIf(DATABASE_URL === undefined)("datos de usuario contra Postgres (RLS)", () => {
  let pool: Pool;
  let repo: PostgresRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    repo = new PostgresRepository(crearQueryClientPool(pool));
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE favorites, vehicle_contributions, auth_login_attempts, local_auth_sessions, local_auth_users",
    );
  });

  it("alta idempotente: repetir un favorito devuelve el mismo registro (8.9)", async () => {
    const a = await repo.createFavorito({ userId: ANA, tipo: "parada", codParada: "100" });
    const b = await repo.createFavorito({ userId: ANA, tipo: "parada", codParada: "100" });
    expect(b.id).toBe(a.id);
    expect(await repo.listFavoritos(ANA)).toHaveLength(1);
  });

  it("la restricción de unicidad impide duplicados aunque cod_linea sea NULL", async () => {
    const insertar = (): Promise<unknown> =>
      pool.query("INSERT INTO favorites (user_id, tipo, cod_parada) VALUES ($1, 'parada', '7')", [ANA]);
    await insertar();
    await expect(insertar()).rejects.toMatchObject({ code: "23505" });
  });

  it("RLS aísla por user_id: no se ven ni se borran favoritos ajenos", async () => {
    const deAna = await repo.createFavorito({ userId: ANA, tipo: "linea", codLinea: 3 });
    await repo.createFavorito({ userId: BEA, tipo: "linea", codLinea: 3 });

    expect((await repo.listFavoritos(ANA)).map((f) => f.id)).toEqual([deAna.id]);
    expect(await repo.deleteFavorito(BEA, deAna.id)).toBe(false);
    expect(await repo.deleteFavorito(ANA, deAna.id)).toBe(true);
    expect(await repo.listFavoritos(BEA)).toHaveLength(1);
  });

  it("RLS impide escribir en nombre de otro usuario aunque la consulta no filtre", async () => {
    const cliente = await pool.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [ANA]);
      await cliente.query("SET LOCAL ROLE authenticated");
      await expect(
        cliente.query("INSERT INTO favorites (user_id, tipo, cod_linea) VALUES ($1, 'linea', 1)", [BEA]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await cliente.query("ROLLBACK");
      cliente.release();
    }
  });

  it("como authenticated, una SELECT sin filtro solo devuelve las filas propias", async () => {
    await repo.createFavorito({ userId: ANA, tipo: "linea", codLinea: 1 });
    await repo.createFavorito({ userId: BEA, tipo: "linea", codLinea: 2 });
    const cliente = await pool.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [BEA]);
      await cliente.query("SET LOCAL ROLE authenticated");
      const { rows } = await cliente.query("SELECT user_id FROM favorites");
      expect(rows).toEqual([{ user_id: BEA }]);
    } finally {
      await cliente.query("ROLLBACK");
      cliente.release();
    }
  });

  it("aportaciones: alta en nombre propio y lectura pública de las vigentes", async () => {
    const a = await repo.createAportacion({ userId: ANA, codBus: 501, opcion: "lleno" });
    await pool.query(
      "INSERT INTO vehicle_contributions (user_id, cod_bus, opcion, created_at) VALUES ($1, 501, 'retraso', now() - interval '61 minutes')",
      [BEA],
    );
    const vigentes = await repo.listAportacionesVigentes(501);
    expect(vigentes.map((v) => v.id)).toEqual([a.id]);
  });

  it("local-auth sobre Postgres: login, sesión y bloqueo persistente", async () => {
    await pool.query("INSERT INTO local_auth_users (user_id, email, password_hash) VALUES ($1, $2, $3)", [
      ANA,
      "ana@example.com",
      hashPassword("secreta"),
    ]);
    const client = crearQueryClientPool(pool);
    const auth = createLocalAuthProvider({
      store: createPostgresLocalAuthStore(client),
      intentos: createPostgresLoginAttemptStore(client),
      devUser: false,
    });

    const { token } = await auth.login("Ana@Example.com", "secreta");
    expect(await auth.resolverUserId(token)).toBe(ANA);
    await auth.logout(token);
    expect(await auth.resolverUserId(token)).toBeNull();

    for (let i = 0; i < 5; i++) await auth.login("ana@example.com", "mala").catch(() => undefined);
    await expect(auth.login("ana@example.com", "secreta")).rejects.toMatchObject({ motivo: "bloqueado" });
    const { rows } = await pool.query("SELECT bloqueado_hasta FROM auth_login_attempts");
    expect(rows).toHaveLength(1);
  });
});
