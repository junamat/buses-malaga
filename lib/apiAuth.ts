/**
 * Resolución del `AuthProvider` para los route handlers protegidos.
 *
 * Igual que `lib/apiRepository.ts`: resuelve solo el puerto que necesitan los
 * handlers (aquí, la autenticación) en lugar de `createBackend()`, que también
 * cablea el `IngestScheduler` y aún lanza en los modos `supabase-*`. Se memoiza
 * por proceso para reutilizar el pool de conexiones entre peticiones.
 */

import type { AuthProvider } from "@/lib/ports";
import { loadBackendConfig, createAuthProvider } from "@/lib/config";

let cachedAuthProvider: AuthProvider | null = null;

export function getAuthProvider(
  env: Record<string, string | undefined> = process.env,
): AuthProvider {
  if (cachedAuthProvider === null) {
    cachedAuthProvider = createAuthProvider(loadBackendConfig(env));
  }
  return cachedAuthProvider;
}

/** Reinicia el proveedor memoizado (tests). */
export function resetAuthProviderCache(): void {
  cachedAuthProvider = null;
}
