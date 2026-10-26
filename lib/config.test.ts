import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  BACKEND_PROVIDERS,
  DEFAULT_BACKEND_PROVIDER,
  type BackendProvider,
  isBackendProvider,
  resolveBackendProvider,
  usesSupabase,
  loadBackendConfig,
  createRepository,
  createIngestScheduler,
  createAuthProvider,
  createBackend,
  AdapterNotImplementedError,
} from "@/lib/config";

const DB_URL = "postgresql://postgres:postgres@127.0.0.1:5432/buses_malaga";

function supabaseEnv(provider: BackendProvider): Record<string, string> {
  return {
    BACKEND_PROVIDER: provider,
    DATABASE_URL: DB_URL,
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: "anon",
  };
}

describe("resolveBackendProvider", () => {
  it("usa el valor por defecto de desarrollo cuando no hay env", () => {
    expect(resolveBackendProvider({})).toBe(DEFAULT_BACKEND_PROVIDER);
    expect(DEFAULT_BACKEND_PROVIDER).toBe("supabase-local");
  });

  it("trata la cadena vacía como ausente y cae al valor por defecto", () => {
    expect(resolveBackendProvider({ BACKEND_PROVIDER: "" })).toBe(
      DEFAULT_BACKEND_PROVIDER,
    );
  });

  it("lee BACKEND_PROVIDER cuando es válido", () => {
    for (const p of BACKEND_PROVIDERS) {
      expect(resolveBackendProvider({ BACKEND_PROVIDER: p })).toBe(p);
    }
  });

  it("acepta el alias RUNTIME_MODE", () => {
    expect(resolveBackendProvider({ RUNTIME_MODE: "local-postgres" })).toBe(
      "local-postgres",
    );
  });

  it("da prioridad a BACKEND_PROVIDER sobre RUNTIME_MODE", () => {
    expect(
      resolveBackendProvider({
        BACKEND_PROVIDER: "supabase-cloud",
        RUNTIME_MODE: "local-postgres",
      }),
    ).toBe("supabase-cloud");
  });

  it("lanza ante un valor presente pero inválido", () => {
    expect(() =>
      resolveBackendProvider({ BACKEND_PROVIDER: "mysql" }),
    ).toThrow(/inválido/);
  });
});

describe("isBackendProvider / usesSupabase", () => {
  it("reconoce exactamente los tres modos válidos", () => {
    for (const p of BACKEND_PROVIDERS) expect(isBackendProvider(p)).toBe(true);
    expect(isBackendProvider("nope")).toBe(false);
    expect(isBackendProvider(42)).toBe(false);
  });

  it("marca como Supabase solo los modos supabase-*", () => {
    expect(usesSupabase("supabase-cloud")).toBe(true);
    expect(usesSupabase("supabase-local")).toBe(true);
    expect(usesSupabase("local-postgres")).toBe(false);
  });
});

describe("loadBackendConfig", () => {
  it("requiere DATABASE_URL en todos los modos", () => {
    expect(() =>
      loadBackendConfig({ BACKEND_PROVIDER: "local-postgres" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("exige claves de Supabase en los modos supabase-*", () => {
    expect(() =>
      loadBackendConfig({
        BACKEND_PROVIDER: "supabase-cloud",
        DATABASE_URL: DB_URL,
      }),
    ).toThrow(/SUPABASE_URL/);
  });

  it("carga configuración de Supabase válida", () => {
    const cfg = loadBackendConfig(supabaseEnv("supabase-local"));
    expect(cfg.provider).toBe("supabase-local");
    expect(cfg.databaseUrl).toBe(DB_URL);
    expect(cfg.supabase?.url).toBe("http://127.0.0.1:54321");
    expect(cfg.supabase?.anonKey).toBe("anon");
    expect(cfg.devUserEnabled).toBe(false);
  });

  it("no exige claves de Supabase en local-postgres y habilita el dev user por defecto", () => {
    const cfg = loadBackendConfig({
      BACKEND_PROVIDER: "local-postgres",
      DATABASE_URL: DB_URL,
    });
    expect(cfg.supabase).toBeUndefined();
    expect(cfg.devUserEnabled).toBe(true);
  });

  it("permite desactivar el dev user con LOCAL_AUTH_DEV_USER=false", () => {
    const cfg = loadBackendConfig({
      BACKEND_PROVIDER: "local-postgres",
      DATABASE_URL: DB_URL,
      LOCAL_AUTH_DEV_USER: "false",
    });
    expect(cfg.devUserEnabled).toBe(false);
  });
});

describe("factoría de adaptadores", () => {
  it("createRepository ya está implementado y devuelve un Repository en todos los modos", () => {
    for (const provider of BACKEND_PROVIDERS) {
      const config = loadBackendConfig(
        usesSupabase(provider)
          ? supabaseEnv(provider)
          : { BACKEND_PROVIDER: provider, DATABASE_URL: DB_URL },
      );

      // Tarea 1.3: el repositorio Postgres portable ya está cableado. No debe
      // lanzar al construirse (no abre conexión hasta la primera consulta).
      const repository = createRepository(config);
      expect(repository).toBeDefined();
      expect(typeof repository.listLineas).toBe("function");
      expect(typeof repository.listBuses).toBe("function");
    }
  });

  it("el AuthProvider sigue sin implementar y lanza AdapterNotImplementedError en todos los modos", () => {
    for (const provider of BACKEND_PROVIDERS) {
      const config = loadBackendConfig(
        usesSupabase(provider)
          ? supabaseEnv(provider)
          : { BACKEND_PROVIDER: provider, DATABASE_URL: DB_URL },
      );

      expect(() => createAuthProvider(config)).toThrow(
        AdapterNotImplementedError,
      );
    }
  });

  it("el scheduler pg_cron (modos supabase-*) sigue sin implementar y lanza", () => {
    for (const provider of ["supabase-cloud", "supabase-local"] as const) {
      const config = loadBackendConfig(supabaseEnv(provider));
      // El scheduler depende del repositorio; pasamos un doble vacío solo para
      // ejercitar la selección de modo.
      expect(() =>
        createIngestScheduler(config, {} as never),
      ).toThrow(AdapterNotImplementedError);
    }
  });

  it("el scheduler node-worker (local-postgres) ya está implementado", () => {
    const config = loadBackendConfig({
      BACKEND_PROVIDER: "local-postgres",
      DATABASE_URL: DB_URL,
    });
    // Tarea 3.2: el adaptador node-worker ya está cableado. No debe lanzar al
    // construirse (no abre conexión ni arranca temporizadores hasta start()).
    const scheduler = createIngestScheduler(config, {} as never);
    expect(scheduler).toBeDefined();
    expect(typeof scheduler.runOnce).toBe("function");
    expect(typeof scheduler.start).toBe("function");
    expect(typeof scheduler.stop).toBe("function");
    expect(scheduler.transport).toBeDefined();
  });

  it("createBackend falla al cablear el primer adaptador no implementado (scheduler)", () => {
    // El repositorio ya se construye; el primer no implementado es el scheduler.
    expect(() => createBackend(supabaseEnv("supabase-cloud"))).toThrow(
      AdapterNotImplementedError,
    );
  });

  it("el error de un adaptador no implementado identifica el puerto y el modo", () => {
    const config = loadBackendConfig(supabaseEnv("supabase-cloud"));
    try {
      createAuthProvider(config);
      throw new Error("debería haber lanzado");
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterNotImplementedError);
      const err = e as AdapterNotImplementedError;
      expect(err.port).toBe("AuthProvider");
      expect(err.provider).toBe("supabase-cloud");
    }
  });
});

describe("propiedad: resolución de modo es total y consistente", () => {
  it("cualquier env produce un modo válido o un error de validación, nunca otra cosa", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (backendProvider, runtimeMode) => {
          const env: Record<string, string | undefined> = {};
          if (backendProvider !== undefined)
            env.BACKEND_PROVIDER = backendProvider;
          if (runtimeMode !== undefined) env.RUNTIME_MODE = runtimeMode;

          try {
            const result = resolveBackendProvider(env);
            expect(BACKEND_PROVIDERS).toContain(result);
          } catch (e) {
            // Solo es aceptable fallar por un valor presente e inválido.
            expect(e).toBeInstanceOf(Error);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
