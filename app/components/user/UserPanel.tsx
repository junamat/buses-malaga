"use client";

/**
 * Panel de usuario (tarea 15.2): login/logout y lista de favoritos con baja
 * (Requisitos 7.1, 7.3, 7.4, 7.5, 8.5–8.7).
 *
 * El formulario conserva el correo tras un error (credenciales incorrectas o
 * bloqueo) y se abre solo cuando una operación protegida pide sesión (7.6).
 */

import { useState, type FormEvent } from "react";

import { useUser } from "./UserContext";
import { describirFavorito } from "./userApi";

const caja: React.CSSProperties = {
  position: "absolute",
  // Por encima de la atribución de OSM (abajo a la derecha).
  bottom: 28,
  right: 12,
  zIndex: 1000,
  background: "#fff",
  color: "#222",
  borderRadius: 4,
  padding: 8,
  boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
  fontSize: 14,
  width: 240,
  maxHeight: "50vh",
  overflowY: "auto",
};

const boton: React.CSSProperties = {
  cursor: "pointer",
  padding: "4px 8px",
  border: "1px solid #1565c0",
  borderRadius: 4,
  background: "#e3f2fd",
  color: "#0d47a1",
  fontSize: 13,
};

export default function UserPanel(): JSX.Element | null {
  const { sesion, cargando, favoritos, loginRequerido, login, logout, quitarFavorito } = useUser();
  const [abierto, setAbierto] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  if (cargando) return null;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const r = await login(email, password);
    setEnviando(false);
    setPassword("");
    if (r.ok) {
      setAbierto(false);
    } else {
      setError(r.mensaje);
    }
  }

  if (sesion === null) {
    const mostrarForm = abierto || loginRequerido !== null;
    return (
      <div style={caja}>
        {!mostrarForm ? (
          <button type="button" style={boton} onClick={() => setAbierto(true)}>
            Iniciar sesión
          </button>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} aria-label="Iniciar sesión">
            {loginRequerido !== null ? (
              <div role="status" style={{ marginBottom: 6 }}>{loginRequerido}</div>
            ) : null}
            <input
              type="email"
              placeholder="Correo"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ width: "100%", marginBottom: 4, boxSizing: "border-box" }}
            />
            <input
              type="password"
              placeholder="Contraseña"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ width: "100%", marginBottom: 4, boxSizing: "border-box" }}
            />
            <button type="submit" style={boton} disabled={enviando}>
              {enviando ? "Entrando…" : "Entrar"}
            </button>
            {error !== null ? (
              <div role="alert" style={{ marginTop: 6, color: "#b00020" }}>{error}</div>
            ) : null}
          </form>
        )}
      </div>
    );
  }

  return (
    <div style={caja}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{sesion.email ?? "Sesión iniciada"}</span>
        <button type="button" style={boton} onClick={() => void logout()}>
          Salir
        </button>
      </div>
      <strong style={{ display: "block", marginTop: 8 }}>Favoritos</strong>
      {favoritos.length === 0 ? (
        <span style={{ color: "#555" }}>Aún no tienes favoritos. Usa ☆ en una parada o un bus.</span>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {favoritos.map((f) => (
            <li key={f.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
              <span>{describirFavorito(f)}</span>
              <button
                type="button"
                aria-label={`Quitar ${describirFavorito(f)} de favoritos`}
                onClick={() => void quitarFavorito(f.id)}
                style={{ ...boton, padding: "0 6px" }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
