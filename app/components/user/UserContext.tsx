"use client";

/**
 * Estado de usuario del frontend (tarea 15.2): sesión, favoritos y aviso de
 * "inicia sesión" (Requisitos 7.1, 7.5, 7.6, 8.x).
 *
 * Los popups de Leaflet se renderizan con portales de React, así que también
 * leen este contexto. Cuando una operación protegida devuelve 401, se marca
 * `loginRequerido` para abrir el formulario de login; el componente que la
 * lanzó conserva lo que el usuario había introducido y puede reintentar.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { ReferenciaFavorito } from "@/lib/favorites";
import {
  cerrarSesion,
  crearFavorito,
  eliminarFavorito,
  iniciarSesion,
  listarFavoritos,
  obtenerSesion,
  type FavoritoCliente,
  type Resultado,
  type SesionCliente,
} from "./userApi";

export interface UserState {
  sesion: SesionCliente | null;
  cargando: boolean;
  favoritos: readonly FavoritoCliente[];
  /** Mensaje que pide iniciar sesión tras un 401, o `null`. */
  loginRequerido: string | null;
  login(email: string, password: string): Promise<Resultado<SesionCliente>>;
  logout(): Promise<void>;
  /** Favorito existente que referencia `ref`, si lo hay. */
  favoritoDe(ref: ReferenciaFavorito): FavoritoCliente | undefined;
  /** Marca o desmarca `ref`. Devuelve un mensaje de error o `null`. */
  alternarFavorito(ref: ReferenciaFavorito): Promise<string | null>;
  quitarFavorito(id: string): Promise<string | null>;
  /** Avisa de que una operación necesita sesión (abre el login). */
  pedirLogin(mensaje?: string): void;
}

const UserContext = createContext<UserState | null>(null);

export function useUser(): UserState {
  const ctx = useContext(UserContext);
  if (ctx === null) {
    throw new Error("useUser debe usarse dentro de <UserProvider>.");
  }
  return ctx;
}

const MENSAJE_LOGIN = "Inicia sesión para continuar. Lo que habías introducido se conserva.";

export function UserProvider({ children }: { children: ReactNode }): JSX.Element {
  const [sesion, setSesion] = useState<SesionCliente | null>(null);
  const [cargando, setCargando] = useState(true);
  const [favoritos, setFavoritos] = useState<readonly FavoritoCliente[]>([]);
  const [loginRequerido, setLoginRequerido] = useState<string | null>(null);

  const recargarFavoritos = useCallback(async () => {
    const r = await listarFavoritos();
    setFavoritos(r.ok ? r.valor : []);
  }, []);

  useEffect(() => {
    let vivo = true;
    void obtenerSesion().then(async (s) => {
      if (!vivo) return;
      setSesion(s);
      if (s !== null) await recargarFavoritos();
      if (vivo) setCargando(false);
    });
    return () => {
      vivo = false;
    };
  }, [recargarFavoritos]);

  const pedirLogin = useCallback((mensaje: string = MENSAJE_LOGIN) => {
    setSesion(null);
    setLoginRequerido(mensaje);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await iniciarSesion(email, password);
      if (r.ok) {
        setSesion(r.valor);
        setLoginRequerido(null);
        await recargarFavoritos();
      }
      return r;
    },
    [recargarFavoritos],
  );

  const logout = useCallback(async () => {
    await cerrarSesion();
    // En modo usuario de desarrollo la petición sin cookie sigue autenticada.
    const s = await obtenerSesion();
    setSesion(s);
    if (s === null) setFavoritos([]);
    else await recargarFavoritos();
  }, [recargarFavoritos]);

  const favoritoDe = useCallback(
    (ref: ReferenciaFavorito) =>
      favoritos.find(
        (f) => f.tipo === ref.tipo && f.codParada === ref.codParada && f.codLinea === ref.codLinea,
      ),
    [favoritos],
  );

  const quitarFavorito = useCallback(
    async (id: string) => {
      const r = await eliminarFavorito(id);
      if (!r.ok && r.sesionRequerida) {
        pedirLogin();
        return r.mensaje;
      }
      // 404: ya no estaba; en ambos casos se refleja el estado del servidor.
      setFavoritos((prev) => prev.filter((f) => f.id !== id));
      return r.ok || r.status === 404 ? null : r.mensaje;
    },
    [pedirLogin],
  );

  const alternarFavorito = useCallback(
    async (ref: ReferenciaFavorito) => {
      const existente = favoritoDe(ref);
      if (existente !== undefined) {
        return quitarFavorito(existente.id);
      }
      const r = await crearFavorito(ref);
      if (!r.ok) {
        if (r.sesionRequerida) pedirLogin();
        return r.mensaje;
      }
      setFavoritos((prev) => (prev.some((f) => f.id === r.valor.id) ? prev : [...prev, r.valor]));
      return null;
    },
    [favoritoDe, quitarFavorito, pedirLogin],
  );

  const valor = useMemo<UserState>(
    () => ({
      sesion,
      cargando,
      favoritos,
      loginRequerido,
      login,
      logout,
      favoritoDe,
      alternarFavorito,
      quitarFavorito,
      pedirLogin,
    }),
    [sesion, cargando, favoritos, loginRequerido, login, logout, favoritoDe, alternarFavorito, quitarFavorito, pedirLogin],
  );

  return <UserContext.Provider value={valor}>{children}</UserContext.Provider>;
}
