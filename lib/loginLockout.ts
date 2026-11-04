/**
 * Bloqueo temporal tras intentos de inicio de sesión fallidos (Requisito 7.4).
 *
 * Lógica pura compartida por los dos adaptadores de `AuthProvider`: tras
 * {@link MAX_INTENTOS_FALLIDOS} fallos consecutivos para la misma identidad, se
 * bloquean nuevos intentos durante {@link BLOQUEO_SEGUNDOS}. Un login correcto
 * reinicia el contador. Mientras dura el bloqueo no se comprueban credenciales,
 * ni siquiera las correctas.
 *
 * El estado por identidad se guarda detrás de {@link LoginAttemptStore}: la
 * tabla `auth_login_attempts` en producción (compartida entre instancias
 * serverless) y un mapa en memoria en los tests.
 */

export const MAX_INTENTOS_FALLIDOS = 5;
export const BLOQUEO_SEGUNDOS = 300;

export interface EstadoIntentos {
  /** Fallos consecutivos desde el último éxito o el último bloqueo. */
  fallos: number;
  /** Fin del bloqueo (ISO-8601) o `null` si no hay bloqueo. */
  bloqueadoHasta: string | null;
}

export const ESTADO_INICIAL: EstadoIntentos = { fallos: 0, bloqueadoHasta: null };

/** Identidad canónica: el correo sin espacios y en minúsculas. */
export function normalizarIdentidad(email: string): string {
  return email.trim().toLowerCase();
}

export function estaBloqueado(estado: EstadoIntentos, ahora: Date): boolean {
  return (
    estado.bloqueadoHasta !== null &&
    Date.parse(estado.bloqueadoHasta) > ahora.getTime()
  );
}

/**
 * Registra un fallo. Al alcanzar el máximo, abre un bloqueo de
 * {@link BLOQUEO_SEGUNDOS} y reinicia el contador para el periodo siguiente.
 */
export function registrarFallo(
  estado: EstadoIntentos,
  ahora: Date,
): EstadoIntentos {
  const fallos = estado.fallos + 1;
  if (fallos >= MAX_INTENTOS_FALLIDOS) {
    return {
      fallos: 0,
      bloqueadoHasta: new Date(ahora.getTime() + BLOQUEO_SEGUNDOS * 1000).toISOString(),
    };
  }
  return { fallos, bloqueadoHasta: null };
}

export interface LoginAttemptStore {
  leer(identidad: string): Promise<EstadoIntentos>;
  guardar(identidad: string, estado: EstadoIntentos): Promise<void>;
}

/** Almacén en memoria (tests y desarrollo sin base de datos). */
export function createMemoryLoginAttemptStore(): LoginAttemptStore {
  const estados = new Map<string, EstadoIntentos>();
  return {
    async leer(identidad) {
      return estados.get(identidad) ?? ESTADO_INICIAL;
    },
    async guardar(identidad, estado) {
      estados.set(identidad, estado);
    },
  };
}

export type ResultadoIntento<T> =
  | { estado: "ok"; valor: T }
  | { estado: "credenciales_invalidas" }
  | { estado: "bloqueado" };

/**
 * Envuelve una comprobación de credenciales con el bloqueo: rechaza sin
 * llamar a `comprobar` si la identidad está bloqueada; registra el fallo
 * cuando `comprobar` devuelve `null` y reinicia el contador cuando acierta.
 * El fallo que alcanza el máximo ya se informa como bloqueo.
 */
export async function intentarLogin<T>(
  store: LoginAttemptStore,
  email: string,
  ahora: Date,
  comprobar: () => Promise<T | null>,
): Promise<ResultadoIntento<T>> {
  const identidad = normalizarIdentidad(email);
  const previo = await store.leer(identidad);
  if (estaBloqueado(previo, ahora)) {
    return { estado: "bloqueado" };
  }
  const valor = await comprobar();
  if (valor === null) {
    const siguiente = registrarFallo(previo, ahora);
    await store.guardar(identidad, siguiente);
    return estaBloqueado(siguiente, ahora)
      ? { estado: "bloqueado" }
      : { estado: "credenciales_invalidas" };
  }
  if (previo.fallos !== 0 || previo.bloqueadoHasta !== null) {
    await store.guardar(identidad, ESTADO_INICIAL);
  }
  return { estado: "ok", valor };
}
