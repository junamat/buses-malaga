/**
 * Barrel de los puertos del patrón puertos/adaptadores.
 *
 * La lógica de negocio importa desde `@/lib/ports` y depende únicamente de
 * estas interfaces, nunca de un adaptador concreto ni de un cliente de
 * plataforma. Los adaptadores viven en `@/lib/adapters` y se seleccionan en
 * tiempo de ejecución mediante la factoría de `@/lib/config`.
 */

export type {
  Repository,
  FiltroPosiciones,
  Paginacion,
  Pagina,
  ParadaCercana,
  NuevaAportacion,
  NuevoFavorito,
} from "./repository";

export type {
  IngestScheduler,
  IngestJob,
  IngestResult,
  HttpTransport,
} from "./ingest-scheduler";

export type {
  AuthProvider,
  Identidad,
  Sesion,
  VerificacionSesion,
} from "./auth-provider";

export { AuthError } from "./auth-provider";
