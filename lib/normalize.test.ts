import { describe, it, expect } from "vitest";

import { parseLastUpdate, parsearPosiciones } from "@/lib/normalize";

describe("parseLastUpdate (hora local de Madrid → ISO UTC)", () => {
  it("convierte hora de invierno (CET, UTC+1)", () => {
    expect(parseLastUpdate("2026-10-25 15:45:09")).toBe("2026-10-25T14:45:09.000Z");
    expect(parseLastUpdate("2026-01-15 08:00:00")).toBe("2026-01-15T07:00:00.000Z");
  });

  it("convierte hora de verano (CEST, UTC+2)", () => {
    expect(parseLastUpdate("2026-07-01 12:00:00")).toBe("2026-07-01T10:00:00.000Z");
  });

  it("resuelve la hora ambigua del cambio de otoño a su primera ocurrencia (CEST)", () => {
    // 25-oct-2026: a las 03:00 CEST se vuelve a las 02:00 CET.
    expect(parseLastUpdate("2026-10-25 02:30:00")).toBe("2026-10-25T00:30:00.000Z");
  });

  it("acepta la hora inexistente del cambio de primavera sin fallar", () => {
    // 29-mar-2026: de 02:00 CET se salta a 03:00 CEST.
    expect(parseLastUpdate("2026-03-29 02:30:00")).toBe("2026-03-29T01:30:00.000Z");
  });

  it("respeta una zona explícita", () => {
    expect(parseLastUpdate("2024-01-01T00:00:00Z")).toBe("2024-01-01T00:00:00.000Z");
    expect(parseLastUpdate("2024-01-01T02:00:00+02:00")).toBe(
      "2024-01-01T00:00:00.000Z",
    );
  });

  it("devuelve null para valores ausentes o no válidos", () => {
    expect(parseLastUpdate(undefined)).toBeNull();
    expect(parseLastUpdate("")).toBeNull();
    expect(parseLastUpdate("ayer")).toBeNull();
    expect(parseLastUpdate("2026-13-45 99:00:00")).toBeNull();
  });
});

describe("parsearPosiciones — last_update", () => {
  it("descarta filas sin last_update válido en lugar de insertar un valor vacío", () => {
    const { validas, descartadas } = parsearPosiciones(
      [
        ["640", "1.0", "1", "-4.39", "36.72", "170", "2026-10-25 15:45:09"],
        ["641", "1.0", "1", "-4.39", "36.72", "170", ""],
        ["642", "1.0", "1", "-4.39", "36.72"],
      ],
      "2026-10-25T14:45:20.000Z",
    );
    expect(validas.map((v) => v.codBus)).toEqual([640]);
    expect(validas[0].last_update).toBe("2026-10-25T14:45:09.000Z");
    expect(descartadas.map((d) => d.motivo)).toEqual([
      "last_update_invalido",
      "last_update_invalido",
    ]);
  });
});
