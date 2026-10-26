/**
 * Puerto `AuthProvider` — identidad y verificación de sesión en el borde de la API.
 *
 * Define el contrato de identidad y sesión que consume la API_REST: iniciar
 * sesión, cerrar sesión, verificar la sesión en el borde de una petición y
 * resolver el `user_id`. El contrato de los Requisitos 7.1–7.6 es independiente
 * del adaptador:
 *
 * - Adaptador `supabase-auth` (`supabase-cloud`, `supabase-local`): delega en
 *   Supabase Auth (GoTrue); la verificación comprueba el JWT de Supabase.
 * - Adaptador `local-auth` (`local-postgres`): implementación local simple con
 *   credenciales en el Postgres local, e incluye un modo "sin login" / usuario
 *   de desarrollo que resuelve un `user_id` fijo.
 *
 * Cambia la implementación, no el contrato ni el comportamiento observable.
 */

/** Identidad resuelta de un usuario autenticado. */
export interface Identidad {
  userId: string;
  /** Correo o identificador legible, cuando el proveedor lo expone. */
  email?: string;
}

/** Sesión activa devuelta tras un login correcto. */
export interface Sesion {
  identidad: Identidad;
  /** Token opaco de sesión (p. ej. JWT de Supabase). */
  token: string;
  /** Expiración de la sesión (ISO-8601). Hasta 30 días desde el último acceso. */
  expiraEn: string;
}

/** Resultado de verificar una petición entrante en el borde de la API. */
export type VerificacionSesion =
  | { autenticado: true; identidad: Identidad }
  | { autenticado: false; motivo: "sin_sesion" | "sesion_invalida" | "expirada" };

/** Error de autenticación con causa discriminable. */
export class AuthError extends Error {
  constructor(
    public readonly motivo:
      | "credenciales_invalidas"
      | "bloqueado"
      | "no_disponible",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Proveedor de autenticación. La API protege las operaciones que requieren
 * sesión a través de `verificarSesion`/`resolverUserId`; si no hay sesión, la
 * operación se rechaza conservando los datos introducidos (Requisito 7.6).
 */
export interface AuthProvider {
  /**
   * Inicia sesión con credenciales. Debe devolver sesión + identidad en ≤ 5 s;
   * rechaza con `AuthError("credenciales_invalidas")` ante credenciales
   * inválidas y con `AuthError("bloqueado")` tras 5 intentos fallidos
   * consecutivos (bloqueo ≥ 300 s). (Requisitos 7.1, 7.3, 7.4)
   */
  login(email: string, password: string): Promise<Sesion>;

  /** Invalida la sesión asociada al token en ≤ 5 s. (Requisito 7.5) */
  logout(token: string): Promise<void>;

  /**
   * Verifica la sesión en el borde de una petición a partir de su token
   * (p. ej. cabecera `Authorization`). No lanza por ausencia de sesión: la
   * señala en el resultado. (Requisito 7.2, 7.6)
   */
  verificarSesion(token: string | null | undefined): Promise<VerificacionSesion>;

  /**
   * Resuelve el `user_id` de la petición, o `null` si no hay sesión válida.
   * En el adaptador `local-auth` con modo "sin login" devuelve el `user_id`
   * fijo del usuario de desarrollo.
   */
  resolverUserId(token: string | null | undefined): Promise<string | null>;
}
