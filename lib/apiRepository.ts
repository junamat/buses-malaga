/**
 * Resolución del `Repository` para los route handlers de lectura.
 *
 * Los endpoints geográficos (`/api/buses`, `/api/paradas`, `/api/lineas`) solo
 * necesitan el puerto `Repository`; no dependen del `IngestScheduler` ni del
 * `AuthProvider`. Usar `createBackend()` aquí sería incorrecto: esa factoría
 * cablea los tres adaptadores a la vez y, en los modos `supabase-*`, el
 * `IngestScheduler`/`AuthProvider` todavía no están implementados y lanzarían
 * `AdapterNotImplementedError`, rompiendo endpoints de lectura que no los
 * necesitan.
 *
 * Por eso este helper resuelve **solo** el repositorio a partir de la
 * configuración del entorno (`loadBackendConfig` + `createRepository`), ambos
 * válidos para los tres modos sin tocar scheduler ni auth.
 *
 * El repositorio se memoiza por proceso: en el entorno serverless de Vercel, un
 * mismo contenedor atiende varias peticiones y conviene reutilizar el pool de
 * conexiones de `pg` en lugar de abrir uno nuevo por petición.
 */

import type { Repository } from "@/lib/ports";
import { loadBackendConfig, createRepository } from "@/lib/config";

let cachedRepository: Repository | null = null;

/**
 * Devuelve el `Repository` del modo activo, construyéndolo (y memoizándolo) la
 * primera vez. Propaga cualquier error de configuración (p. ej. `DATABASE_URL`
 * ausente) para que el handler lo traduzca a una respuesta de error.
 */
export function getRepository(
  env: Record<string, string | undefined> = process.env,
): Repository {
  if (cachedRepository === null) {
    const config = loadBackendConfig(env);
    cachedRepository = createRepository(config);
  }
  return cachedRepository;
}

/**
 * Reinicia el repositorio memoizado. Pensado para los tests, que inyectan
 * distintos entornos entre casos y no deben compartir el pool entre ellos.
 */
export function resetRepositoryCache(): void {
  cachedRepository = null;
}
