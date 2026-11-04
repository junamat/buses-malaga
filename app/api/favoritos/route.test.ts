/**
 * Tests de los endpoints protegidos de favoritos y aportaciones (tarea 15.1) y
 * property tests del contrato HTTP de errores (tarea 15.3):
 *
 * - Property 35: un recurso inexistente devuelve no encontrado (11.7).
 * - Property 36: una petición malformada devuelve error de cliente (11.8).
 * - Property 37: los parámetros obligatorios ausentes se identifican (11.9).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

import type { AuthProvider } from "@/lib/ports";
import type { Aportacion, Favorito } from "@/lib/types";
import { API_ERROR_CODES } from "@/lib/apiErrors";
import { LIMITE_FAVORITOS } from "@/lib/favorites";

const USER = "11111111-1111-4111-8111-111111111111";

const repo = {
  findParada: vi.fn(),
  existeLinea: vi.fn(),
  existeBus: vi.fn(),
  listFavoritos: vi.fn(),
  createFavorito: vi.fn(),
  deleteFavorito: vi.fn(),
  listAportacionesVigentes: vi.fn(),
  createAportacion: vi.fn(),
};

const conSesion: AuthProvider = {
  login: vi.fn(),
  logout: vi.fn(),
  verificarSesion: vi.fn(async () => ({ autenticado: true as const, identidad: { userId: USER } })),
  resolverUserId: vi.fn(async () => USER),
};

vi.mock("@/lib/apiRepository", () => ({ getRepository: () => repo }));
vi.mock("@/lib/apiAuth", () => ({ getAuthProvider: () => conSesion }));

import * as favoritos from "@/app/api/favoritos/route";
import * as favorito from "@/app/api/favoritos/[id]/route";
import * as aportaciones from "@/app/api/buses/[codBus]/aportaciones/route";

function post(url: string, body: string | object): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const get = (url: string): Request => new Request(url, { headers: { authorization: "Bearer t" } });
const del = (url: string): Request =>
  new Request(url, { method: "DELETE", headers: { authorization: "Bearer t" } });

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.findParada.mockResolvedValue({ codParada: "1", nombre: "P", lon: 0, lat: 0 });
  repo.existeLinea.mockResolvedValue(true);
  repo.existeBus.mockResolvedValue(true);
  repo.listFavoritos.mockResolvedValue([]);
  repo.listAportacionesVigentes.mockResolvedValue([]);
});

describe("favoritos", () => {
  it("GET devuelve el conjunto del usuario sin exponer userId; vacío si no tiene (8.5, 8.6)", async () => {
    let res = await favoritos.GET(get("http://x/api/favoritos"));
    expect(await res.json()).toEqual({ favoritos: [] });

    const f: Favorito = { id: "a", userId: USER, tipo: "linea", codLinea: 3 };
    repo.listFavoritos.mockResolvedValue([f]);
    res = await favoritos.GET(get("http://x/api/favoritos"));
    expect(await res.json()).toEqual({ favoritos: [{ id: "a", tipo: "linea", codLinea: 3 }] });
    expect(repo.listFavoritos).toHaveBeenCalledWith(USER);
  });

  it("POST crea (201) y repetir devuelve el existente (200) sin duplicar (8.1, 8.9)", async () => {
    const creado: Favorito = { id: "n", userId: USER, tipo: "parada", codParada: "1" };
    repo.createFavorito.mockResolvedValue(creado);
    let res = await favoritos.POST(post("http://x/api/favoritos", { tipo: "parada", codParada: "1" }));
    expect(res.status).toBe(201);
    expect(repo.createFavorito).toHaveBeenCalledWith({ userId: USER, tipo: "parada", codParada: "1" });

    repo.listFavoritos.mockResolvedValue([creado]);
    repo.createFavorito.mockClear();
    res = await favoritos.POST(post("http://x/api/favoritos", { tipo: "parada", codParada: "1" }));
    expect(res.status).toBe(200);
    expect(repo.createFavorito).not.toHaveBeenCalled();
  });

  it("POST de un elemento inexistente → 422 sin persistir (8.4)", async () => {
    repo.existeLinea.mockResolvedValue(false);
    const res = await favoritos.POST(post("http://x/api/favoritos", { tipo: "linea", codLinea: 999 }));
    expect(res.status).toBe(422);
    expect(repo.createFavorito).not.toHaveBeenCalled();
  });

  it("POST con 500 favoritos → 409 con mensaje de límite (8.10)", async () => {
    repo.listFavoritos.mockResolvedValue(
      Array.from({ length: LIMITE_FAVORITOS }, (_, i) => ({ id: `${i}`, userId: USER, tipo: "linea", codLinea: i + 10 })),
    );
    const res = await favoritos.POST(post("http://x/api/favoritos", { tipo: "linea", codLinea: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(API_ERROR_CODES.favoritesLimit);
    expect(repo.createFavorito).not.toHaveBeenCalled();
  });

  it("DELETE elimina (204) (8.7)", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    repo.deleteFavorito.mockResolvedValue(true);
    const res = await favorito.DELETE(del(`http://x/api/favoritos/${id}`), { params: { id } });
    expect(res.status).toBe(204);
    expect(repo.deleteFavorito).toHaveBeenCalledWith(USER, id);
  });
});

describe("aportaciones", () => {
  it("GET devuelve las vigentes con etiqueta y catálogo, sin userId (9.2, 9.3)", async () => {
    const a: Aportacion = {
      id: "a1",
      userId: "otro",
      codBus: 7,
      opcion: "lleno",
      created_at: new Date().toISOString(),
    };
    repo.listAportacionesVigentes.mockResolvedValue([a]);
    const res = await aportaciones.GET(get("http://x/api/buses/7/aportaciones"), { params: { codBus: "7" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.opciones.length).toBeLessThanOrEqual(10);
    expect(body.aportaciones).toHaveLength(1);
    expect(body.aportaciones[0]).toMatchObject({ id: "a1", opcion: "lleno", etiqueta: "Va lleno" });
    expect(body.aportaciones[0].userId).toBeUndefined();
  });

  it("POST válido → 201 asociado al usuario (9.1)", async () => {
    repo.createAportacion.mockImplementation(async (n) => ({ id: "x", created_at: new Date().toISOString(), ...n }));
    const res = await aportaciones.POST(post("http://x/api/buses/7/aportaciones", { opcion: "retraso" }), {
      params: { codBus: "7" },
    });
    expect(res.status).toBe(201);
    expect(repo.createAportacion).toHaveBeenCalledWith({ userId: USER, codBus: 7, opcion: "retraso" });
  });

  it("POST con opción fuera del catálogo → 422 sin persistir (9.5)", async () => {
    const res = await aportaciones.POST(post("http://x/api/buses/7/aportaciones", { opcion: "fiesta" }), {
      params: { codBus: "7" },
    });
    expect(res.status).toBe(422);
    expect(repo.createAportacion).not.toHaveBeenCalled();
  });
});

describe("contrato HTTP de errores", () => {
  it("Property 35: un recurso inexistente devuelve 404", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.integer({ min: 0, max: 1e9 }), async (id, codBus) => {
        repo.deleteFavorito.mockResolvedValue(false);
        repo.existeBus.mockResolvedValue(false);
        const r1 = await favorito.DELETE(del(`http://x/api/favoritos/${id}`), { params: { id } });
        const r2 = await aportaciones.GET(get(`http://x/api/buses/${codBus}/aportaciones`), {
          params: { codBus: String(codBus) },
        });
        const r3 = await aportaciones.POST(post(`http://x/api/buses/${codBus}/aportaciones`, { opcion: "lleno" }), {
          params: { codBus: String(codBus) },
        });
        for (const r of [r1, r2, r3]) {
          expect(r.status).toBe(404);
          expect((await r.json()).code).toBe(API_ERROR_CODES.notFound);
        }
        expect(repo.createAportacion).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it("Property 36: una petición malformada devuelve 400 indicando que es incorrecta", async () => {
    const arbNoJson = fc.string({ minLength: 1 }).filter((s) => {
      try {
        JSON.parse(s);
        return false;
      } catch {
        return s.trim() !== "";
      }
    });
    const arbNoEntero = fc.string({ minLength: 1 }).filter((s) => s.trim() !== "" && !/^\d+$/.test(s.trim()));
    const arbNoUuid = fc.string({ minLength: 1 }).filter((s) => s.trim() !== "" && !/^[0-9a-f-]{36}$/i.test(s.trim()));

    await fc.assert(
      fc.asyncProperty(arbNoJson, arbNoEntero, arbNoUuid, async (noJson, codBus, id) => {
        const respuestas = [
          await favoritos.POST(post("http://x/api/favoritos", noJson)),
          await aportaciones.POST(post("http://x/api/buses/1/aportaciones", noJson), { params: { codBus: "1" } }),
          await aportaciones.GET(get("http://x/api/buses/x/aportaciones"), { params: { codBus } }),
          await favorito.DELETE(del("http://x/api/favoritos/x"), { params: { id } }),
        ];
        for (const r of respuestas) {
          expect(r.status).toBe(400);
          expect((await r.json()).code).toBe(API_ERROR_CODES.malformedRequest);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 37: los parámetros obligatorios ausentes se identifican", async () => {
    const arbCaso = fc.constantFrom(
      { body: {}, ausentes: ["tipo"] },
      { body: { tipo: "parada" }, ausentes: ["codParada"] },
      { body: { tipo: "linea", codLinea: "" }, ausentes: ["codLinea"] },
      { body: { tipo: "parada_linea" }, ausentes: ["codParada", "codLinea"] },
      { body: { tipo: "parada_linea", codParada: "4" }, ausentes: ["codLinea"] },
    );
    await fc.assert(
      fc.asyncProperty(arbCaso, fc.dictionary(fc.constantFrom("extra", "nota"), fc.string()), async (caso, extra) => {
        const res = await favoritos.POST(post("http://x/api/favoritos", { ...extra, ...caso.body }));
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe(API_ERROR_CODES.missingParams);
        expect(body.params).toEqual(caso.ausentes);
      }),
      { numRuns: 100 },
    );

    const res = await aportaciones.POST(post("http://x/api/buses/1/aportaciones", {}), { params: { codBus: "1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).params).toEqual(["opcion"]);
  });
});
