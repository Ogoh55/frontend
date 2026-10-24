import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLeaderboard,
  listCompetitions,
  registerForCompetition,
  setCompetitionDisplayName,
} from "./competitions";

function mockFetch(payload: unknown, { ok = true, status = 200 } = {}) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    json: async () => payload,
    text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function callOf(fn: ReturnType<typeof mockFetch>, index = 0) {
  const [url, init] = fn.mock.calls[index] as unknown as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("competitions API client", () => {
  it("lists competitions from the public endpoint", async () => {
    const fetchMock = mockFetch([{ id: "comp-1" }]);
    const rows = await listCompetitions();

    const { url, init } = callOf(fetchMock);
    expect(url).toBe("http://localhost:8081/api/v1/competitions");
    expect(init.method).toBe("GET");
    expect(rows).toEqual([{ id: "comp-1" }]);
  });

  it("sends a bearer token when one is supplied", async () => {
    const fetchMock = mockFetch([]);
    await listCompetitions("token-123");
    expect(callOf(fetchMock).headers.get("authorization")).toBe("Bearer token-123");
  });

  it("builds a paginated, searched leaderboard URL", async () => {
    const fetchMock = mockFetch({ entries: [] });
    await getLeaderboard("comp 1", { page: 2, pageSize: 10, search: "GABC" });

    const { url } = callOf(fetchMock);
    expect(url).toContain("/api/v1/competitions/comp%201/leaderboard?");
    expect(url).toContain("page=2");
    expect(url).toContain("page_size=10");
    expect(url).toContain("search=GABC");
  });

  it("omits blank search and clamps bad pagination", async () => {
    const fetchMock = mockFetch({ entries: [] });
    await getLeaderboard("comp-1", { page: 0, pageSize: 0, search: "   " });

    const { url } = callOf(fetchMock);
    expect(url).toContain("page=1");
    expect(url).toContain("page_size=1");
    expect(url).not.toContain("search=");
  });

  it("registers with a signed message and nulls a blank display name", async () => {
    const fetchMock = mockFetch({ competition_id: "comp-1" });
    await registerForCompetition({
      competitionId: "comp-1",
      walletAddress: "GABC",
      message: "sign me",
      signature: "c2ln",
      displayName: "   ",
    });

    const { url, init, headers } = callOf(fetchMock);
    expect(url).toBe("http://localhost:8081/api/v1/competitions/comp-1/register");
    expect(init.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      wallet_address: "GABC",
      message: "sign me",
      signature: "c2ln",
      display_name: null,
    });
  });

  it("trims a provided display name", async () => {
    const fetchMock = mockFetch({});
    await registerForCompetition({
      competitionId: "comp-1",
      walletAddress: "GABC",
      message: "m",
      signature: "s",
      displayName: "  aurora  ",
    });
    expect(JSON.parse(String(callOf(fetchMock).init.body)).display_name).toBe("aurora");
  });

  it("clears the display name with an empty string", async () => {
    const fetchMock = mockFetch({});
    await setCompetitionDisplayName("comp-1", "  ", "tok");
    const { init } = callOf(fetchMock);
    expect(JSON.parse(String(init.body))).toEqual({ display_name: null });
  });

  it("throws an ApiError carrying the server message", async () => {
    mockFetch({ error: "competition not found" }, { ok: false, status: 404 });
    await expect(listCompetitions()).rejects.toThrow("competition not found");
  });
});
