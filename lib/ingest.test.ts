import { describe, it, expect } from "vitest";

import { parsearLineasCsv } from "@/lib/ingest";
import { parsearPosiciones } from "@/lib/normalize";

// ---------------------------------------------------------------------------
// parsearLineasCsv — el CSV de posiciones de la EMT llega entrecomillado
// ---------------------------------------------------------------------------

/**
 * Muestra real del CSV `lineasyubicaciones.csv`: fila de cabecera y campos
 * entre comillas dobles. La regresión que esto cubre: con los campos
 * entrecomillados sin recortar, `parseInteger('"640"')` daba NaN y TODAS las
 * filas se descartaban (0 inserciones, ciclo "ok" silencioso).
 */
const CSV_POSICIONES_ENTRECOMILLADO = [
  '"codBus","codLinea","sentido","lon","lat","codParIni","last_update"',
  '"640","1.0","2","-4.4215336","36.717857","253","2026-10-25 15:00:10"',
  '"643","1.0","2","-4.422669","36.73691","112","2026-10-25 15:00:10"',
].join("\n");

describe("parsearLineasCsv", () => {
  it("recorta las comillas dobles que envuelven cada campo", () => {
    const filas = parsearLineasCsv(CSV_POSICIONES_ENTRECOMILLADO);
    // Incluye la cabecera como primera fila (la descarta normalize por no numérica).
    expect(filas[1]).toEqual([
      "640",
      "1.0",
      "2",
      "-4.4215336",
      "36.717857",
      "253",
      "2026-10-25 15:00:10",
    ]);
  });

  it("deja intactos los campos sin comillas (CSV plano)", () => {
    const filas = parsearLineasCsv("640,1,2,-4.42,36.71");
    expect(filas[0]).toEqual(["640", "1", "2", "-4.42", "36.71"]);
  });

  it("produce capturas válidas desde el CSV entrecomillado (no 0 filas)", () => {
    const filas = parsearLineasCsv(CSV_POSICIONES_ENTRECOMILLADO);
    const { validas, descartadas } = parsearPosiciones(
      filas,
      "2026-10-25T15:00:10.000Z",
    );
    // La cabecera se descarta; las dos filas de datos son válidas.
    expect(validas).toHaveLength(2);
    expect(validas[0]).toMatchObject({
      codBus: 640,
      codLinea: 1,
      sentido: 2,
      lon: -4.4215336,
      lat: 36.717857,
      codParIni: "253",
    });
    // Solo la cabecera queda descartada.
    expect(descartadas).toHaveLength(1);
  });
});
