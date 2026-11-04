"use client";

/**
 * Aportaciones de un vehículo dentro del popup del Bus (tarea 15.2): muestra
 * las vigentes (Requisitos 9.3, 9.6) y permite enviar una opción del catálogo
 * (9.1, 9.2). Si el envío pide sesión, la opción elegida se conserva para
 * reenviarla tras iniciar sesión (7.6).
 */

import { useCallback, useEffect, useState } from "react";

import type { OpcionAportacion } from "@/lib/contributions";
import { useUser } from "./UserContext";
import { enviarAportacion, listarAportaciones, type AportacionCliente } from "./userApi";

function haceMinutos(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min === 0 ? "ahora" : `hace ${min} min`;
}

export default function AportacionesBus({ codBus }: { codBus: number }): JSX.Element {
  const { pedirLogin } = useUser();
  const [opciones, setOpciones] = useState<readonly OpcionAportacion[]>([]);
  const [aportaciones, setAportaciones] = useState<readonly AportacionCliente[] | null>(null);
  const [opcion, setOpcion] = useState("");
  const [mensaje, setMensaje] = useState<{ texto: string; error: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const cargar = useCallback(async () => {
    const r = await listarAportaciones(codBus);
    if (r.ok) {
      setOpciones(r.valor.opciones);
      setAportaciones(r.valor.aportaciones);
    } else {
      setAportaciones([]);
    }
  }, [codBus]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function enviar(): Promise<void> {
    if (opcion === "") return;
    setEnviando(true);
    const r = await enviarAportacion(codBus, opcion);
    setEnviando(false);
    if (r.ok) {
      setMensaje({ texto: "Gracias, aportación registrada.", error: false });
      setOpcion("");
      await cargar();
    } else {
      if (r.sesionRequerida) pedirLogin();
      setMensaje({ texto: r.mensaje, error: true });
    }
  }

  if (aportaciones === null) {
    return <span style={{ display: "block" }}>Cargando aportaciones…</span>;
  }

  return (
    <span style={{ display: "block", marginTop: 6 }}>
      <strong>Aportaciones (última hora)</strong>
      {aportaciones.length === 0 ? (
        <span style={{ display: "block", color: "#555" }}>Nadie ha aportado información.</span>
      ) : (
        aportaciones.map((a) => (
          <span key={a.id} style={{ display: "block" }}>
            {a.etiqueta ?? a.opcion} · {haceMinutos(a.created_at)}
          </span>
        ))
      )}
      {opciones.length > 0 ? (
        <span style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <select
            aria-label="Información sobre el bus"
            value={opcion}
            onChange={(e) => setOpcion(e.target.value)}
            style={{ flex: 1, fontSize: 12 }}
          >
            <option value="">¿Cómo va este bus?</option>
            {opciones.map((o) => (
              <option key={o.id} value={o.id}>
                {o.etiqueta}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void enviar()} disabled={opcion === "" || enviando} style={{ fontSize: 12 }}>
            Enviar
          </button>
        </span>
      ) : null}
      {mensaje !== null ? (
        <span role="status" style={{ display: "block", color: mensaje.error ? "#b00020" : "#2e7d32" }}>
          {mensaje.texto}
        </span>
      ) : null}
    </span>
  );
}
