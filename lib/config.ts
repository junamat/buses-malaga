/**
 * Configuración de backend y factoría de adaptadores.
 *
 * El modo de ejecución se selecciona por la variable de entorno
 * `BACKEND_PROVIDER` (alias aceptado `RUNTIME_MODE`), con tres valores posibles:
 *
 * - `supabase-cloud`  — producción (Supabase cloud; `pg_cron`/`pg_net`; GoTrue).
 * - `supabase-local`  — Vía A: Supabase CLI local sobre Docker (misma pila que
 *                       producción). Valor por defecto en desarrollo.
 * - `local-postgres`  — Vía B: Postgres + PostGIS puro, sin `pg_cron`/`pg_net`;
 *                       ingesta por `node-worker`/`fetch`; `local-auth`.
 *
 * La lógica de negocio depende de los puertos (`@/lib/ports`), nunca de la
 * plataforma concreta. Esta factoría es el único lugar que conoce qué adaptador
 * corresponde a cada modo y cablea la cadena de conexión y las claves.
 *
 * Nota de alcance (tarea 1.2): los adaptadores concretos todavía no existen
 * (llegan en tareas posteriores: repositorio 1.3, scheduler/auth 3.2 y 14.x).
 * Aquí se fija la selección de modo, la carga/validación de configuración y los
 * puntos de cableado. Instanciar un adaptador antes de que exista lanza un error
 * explícito de "no implementado" en lugar de fallar de forma opaca.
 */

import type { Repository, IngestScheduler, AuthProvider } from "@/lib/ports";
import { createPostgresRepository } from "@/lib/adapters/repository-postgres";
import {
  NodeWorkerIngestScheduler,
  type IntervalosWorker,
} from "@/lib/adapters/ingest-node-worker";
import type { IngestConfig } from "@/lib/ingest";
import { recargarGtfs } from "@/lib/gtfs";
import { cicloCalibracion } from "@/lib/calibrationCycle";

// ---------------------------------------------------------------------------
// Modo de backend
// ---------------------------------------------------------------------------

export const BACKEND_PROVIDERS = [
  "supabase-cloud",
  "supabase-local",
  "local-postgres",
] as const;

export type BackendProvider = (typeof BACKEND_PROVIDERS)[number];

/** Valor por defecto en desarrollo cuando no se especifica el modo. */
export const DEFAULT_BACKEND_PROVIDER: BackendProvider = "supabase-local";

/** Comprueba si un string arbitrario es un `BackendProvider` válido. */
export function isBackendProvider(value: unknown): value is BackendProvider {
  return (
    typeof value === "string" &&
    (BACKEND_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Resuelve el modo de backend a partir de `BACKEND_PROVIDER` (o su alias
 * `RUNTIME_MODE`). Si ninguna está definida, usa el valor por defecto de
 * desarrollo. Un valor presente pero inválido es un error de configuración.
 */
export function resolveBackendProvider(
  env: Record<string, string | undefined> = process.env,
): BackendProvider {
  const raw = env.BACKEND_PROVIDER ?? env.RUNTIME_MODE;

  if (raw === undefined || raw === "") {
    return DEFAULT_BACKEND_PROVIDER;
  }

  if (!isBackendProvider(raw)) {
    throw new Error(
      `BACKEND_PROVIDER/RUNTIME_MODE inválido: "${raw}". ` +
        `Valores admitidos: ${BACKEND_PROVIDERS.join(", ")}.`,
    );
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Configuración resuelta por modo
// ---------------------------------------------------------------------------

/** Configuración efectiva derivada del entorno para el modo activo. */
export interface BackendConfig {
  provider: BackendProvider;
  /**
   * Cadena de conexión de Postgres. Única fuente de variación del repositorio
   * entre modos (la lógica SQL/PostGIS es portable). Obligatoria.
   */
  databaseUrl: string;
  /** Configuración de Supabase, presente solo en los modos `supabase-*`. */
  supabase?: {
    url: string;
    anonKey: string;
    /** Clave de servicio (solo servidor; nunca debe exponerse al cliente). */
    serviceRoleKey?: string;
  };
  /**
   * En `local-postgres`: habilita el usuario de desarrollo "sin login" en el
   * adaptador `local-auth`. Ignorado en los modos `supabase-*`.
   */
  devUserEnabled: boolean;
  /**
   * En `local-postgres`: parámetros del disparador de ingesta `node-worker`
   * (URL de la fuente de posiciones y periodo del worker). Ausente en los modos
   * `supabase-*`, donde la ingesta la programa `pg_cron`/`pg_net`.
   */
  ingest?: {
    /** URL del CSV de posiciones (`lineasyubicaciones.csv`). */
    posicionesFuenteUrl: string;
    /** Periodo del worker de posiciones/purga en ms (opcional). */
    pollIntervalMs?: number;
    /**
     * Arrancar el worker periódico al iniciar el servidor (`INGEST_WORKER_ENABLED`).
     * Por defecto `false`: solo ingesta manual vía `POST /api/ingest`.
     */
    workerEnabled: boolean;
  };
}

/**
 * URL por defecto del CSV de posiciones de la EMT en el portal de datos
 * abiertos de Málaga (ver `SPEC.md`). Se usa en `local-postgres` cuando
 * `POSICIONES_FUENTE_URL` no está definida.
 */
export const POSICIONES_FUENTE_URL_DEFECTO =
  "https://datosabiertos.malaga.eu/recursos/transporte/EMT/EMTlineasUbicaciones/lineasyubicaciones.csv";

/** ¿El modo usa la pila de Supabase (repositorio + GoTrue + pg_cron/pg_net)? */
export function usesSupabase(provider: BackendProvider): boolean {
  return provider === "supabase-cloud" || provider === "supabase-local";
}

function requireEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new Error(
      `Falta la variable de entorno obligatoria "${key}" para el modo seleccionado.`,
    );
  }
  return value;
}

/**
 * Carga y valida la configuración del modo activo a partir del entorno.
 * Comprueba que estén presentes las variables obligatorias de cada modo.
 */
export function loadBackendConfig(
  env: Record<string, string | undefined> = process.env,
): BackendConfig {
  const provider = resolveBackendProvider(env);
  const databaseUrl = requireEnv(env, "DATABASE_URL");

  if (usesSupabase(provider)) {
    return {
      provider,
      databaseUrl,
      supabase: {
        url: requireEnv(env, "SUPABASE_URL"),
        anonKey: requireEnv(env, "SUPABASE_ANON_KEY"),
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      },
      devUserEnabled: false,
    };
  }

  // local-postgres
  const pollIntervalMs = parsePositiveInt(env.INGEST_POLL_INTERVAL_MS);
  return {
    provider,
    databaseUrl,
    devUserEnabled: env.LOCAL_AUTH_DEV_USER !== "false",
    ingest: {
      posicionesFuenteUrl:
        env.POSICIONES_FUENTE_URL && env.POSICIONES_FUENTE_URL !== ""
          ? env.POSICIONES_FUENTE_URL
          : POSICIONES_FUENTE_URL_DEFECTO,
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      workerEnabled: env.INGEST_WORKER_ENABLED === "true",
    },
  };
}

/**
 * Parsea un entero positivo de una variable de entorno, devolviendo `undefined`
 * para valores ausentes, vacíos o no numéricos (se usará el valor por defecto).
 */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Factoría de adaptadores
// ---------------------------------------------------------------------------

/**
 * Conjunto de adaptadores cableados para el modo activo. Es lo que la lógica de
 * negocio recibe inyectado, siempre como puertos (interfaces), nunca como tipos
 * de plataforma.
 */
export interface Backend {
  provider: BackendProvider;
  config: BackendConfig;
  repository: Repository;
  ingestScheduler: IngestScheduler;
  authProvider: AuthProvider;
}

/**
 * Error lanzado cuando se solicita instanciar un adaptador cuya implementación
 * aún no existe. Permite que la selección de modo sea verificable antes de que
 * los adaptadores concretos estén disponibles.
 */
export class AdapterNotImplementedError extends Error {
  constructor(
    public readonly port: "Repository" | "IngestScheduler" | "AuthProvider",
    public readonly provider: BackendProvider,
  ) {
    super(
      `Adaptador "${port}" para el modo "${provider}" aún no implementado. ` +
        `Se cablea en una tarea posterior (repositorio 1.3, scheduler/auth 3.2 y 14.x).`,
    );
    this.name = "AdapterNotImplementedError";
  }
}

/**
 * Selecciona y construye el adaptador de `Repository` para el modo dado.
 *
 * Una única implementación sobre Postgres estándar (`repository-postgres`)
 * sirve a los tres modos; lo único que varía es la cadena de conexión
 * (`config.databaseUrl`), inyectada aquí. La lógica SQL/PostGIS es portable
 * entre `supabase-cloud`, `supabase-local` y `local-postgres`.
 */
export function createRepository(config: BackendConfig): Repository {
  switch (config.provider) {
    case "supabase-cloud":
    case "supabase-local":
    case "local-postgres":
      return createPostgresRepository(config.databaseUrl);
    default:
      return assertNever(config.provider);
  }
}

/**
 * Selecciona y construye el adaptador de `IngestScheduler` para el modo dado:
 * `pg_cron`+`pg_net` en los modos `supabase-*`, `node-worker`+`fetch` en
 * `local-postgres`.
 */
export function createIngestScheduler(
  config: BackendConfig,
  repository: Repository,
): IngestScheduler {
  switch (config.provider) {
    case "supabase-cloud":
    case "supabase-local":
      // TODO(Hito 4): scheduler pg_cron + transporte pg_net.
      void repository;
      throw new AdapterNotImplementedError("IngestScheduler", config.provider);
    case "local-postgres": {
      // Adaptador node-worker: disparador con setInterval + transporte fetch de
      // Node. El núcleo de ingesta (`lib/ingest.ts`) y la recarga GTFS
      // (`lib/gtfs.ts`) son compartidos; aquí solo se cablean en IngestConfig.
      const ingestConfig = buildLocalIngestConfig(config);
      const intervalos: IntervalosWorker = {};
      if (config.ingest?.pollIntervalMs !== undefined) {
        intervalos.posicionesMs = config.ingest.pollIntervalMs;
        intervalos.purgaMs = config.ingest.pollIntervalMs;
      }
      return new NodeWorkerIngestScheduler({
        repository,
        config: ingestConfig,
        intervalos,
      });
    }
    default:
      return assertNever(config.provider);
  }
}

/**
 * Construye la `IngestConfig` del modo `local-postgres` a partir de la config
 * resuelta: la fuente de posiciones (URL del CSV), la ventana de purga por
 * defecto, la recarga GTFS compartida de `lib/gtfs.ts` y el ciclo de calibración
 * de `lib/calibrationCycle.ts` (tarea 8.2). Con la calibración conectada, el
 * worker `node-worker` programa su temporizador de muestreo.
 */
export function buildLocalIngestConfig(config: BackendConfig): IngestConfig {
  const posicionesFuenteUrl =
    config.ingest?.posicionesFuenteUrl ?? POSICIONES_FUENTE_URL_DEFECTO;
  return {
    posiciones: { fuenteUrl: posicionesFuenteUrl },
    recargaGtfs: recargarGtfs,
    calibracion: cicloCalibracion,
  };
}

/**
 * Selecciona y construye el adaptador de `AuthProvider` para el modo dado:
 * `supabase-auth` (GoTrue) en los modos `supabase-*`, `local-auth` (usuario de
 * desarrollo) en `local-postgres`.
 */
export function createAuthProvider(config: BackendConfig): AuthProvider {
  switch (config.provider) {
    case "supabase-cloud":
    case "supabase-local":
      // TODO(tarea 3.2): adaptador supabase-auth (GoTrue) con config.supabase.
      throw new AdapterNotImplementedError("AuthProvider", config.provider);
    case "local-postgres":
      // TODO(tarea 3.2): adaptador local-auth con usuario de desarrollo.
      throw new AdapterNotImplementedError("AuthProvider", config.provider);
    default:
      return assertNever(config.provider);
  }
}

/**
 * Factoría principal: resuelve el modo desde el entorno, carga la configuración
 * y cablea los tres adaptadores como puertos. Es el único punto de la app que
 * conoce la correspondencia modo → adaptadores.
 */
export function createBackend(
  env: Record<string, string | undefined> = process.env,
): Backend {
  const config = loadBackendConfig(env);
  const repository = createRepository(config);
  const ingestScheduler = createIngestScheduler(config, repository);
  const authProvider = createAuthProvider(config);

  return {
    provider: config.provider,
    config,
    repository,
    ingestScheduler,
    authProvider,
  };
}

/** Garantía de exhaustividad en los `switch` sobre `BackendProvider`. */
function assertNever(value: never): never {
  throw new Error(`Modo de backend no contemplado: ${String(value)}`);
}
