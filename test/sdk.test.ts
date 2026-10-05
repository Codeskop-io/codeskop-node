import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import Fastify from "fastify";
import * as codeskop from "../src/index.js";
import { normalizePath, parseStack, templateRoute } from "../src/events.js";
import { getClient, setClient } from "../src/state.js";
import { KEY, MockIngest } from "./mock-ingest.js";

let ingest: MockIngest;
let upstream: MockIngest;

async function start(options: codeskop.Options = {}) {
  const client = codeskop.init({ apiKey: KEY, endpoint: ingest.url, flushIntervalMs: 50, ...options });
  await client.ready();
  return client;
}

beforeEach(async () => {
  ingest = await new MockIngest().start();
  upstream = await new MockIngest().start();
  upstream.routes["/v1/charges/err"] = [502, { detail: "bad gateway" }];
});

afterEach(async () => {
  await getClient()?.close(500);
  setClient(null);
  await ingest.stop();
  await upstream.stop();
});

function boom(): never {
  throw new TypeError("order total can't be negative");
}

describe("core", () => {
  it("refuses secret and malformed keys without throwing", async () => {
    const warn = console.warn;
    const msgs: string[] = [];
    console.warn = (m: string) => msgs.push(m);
    try {
      expect(codeskop.init({ apiKey: "cs_live_sk_secret123456789", endpoint: ingest.url }).enabled).toBe(false);
      expect(msgs.join(" ")).toContain("secret key");
      codeskop.captureMessage("ignored");
      expect(codeskop.init({ apiKey: "nope", endpoint: ingest.url }).enabled).toBe(false);
    } finally {
      console.warn = warn;
    }
    expect(ingest.events).toEqual([]);
  });

  it("captures exceptions with frames, causes, tags and context", async () => {
    await start({ release: "1.4.2", environment: "test" });
    try {
      try { boom(); } catch (e) { throw new Error("checkout failed", { cause: e }); }
    } catch (err) {
      codeskop.captureException(err, { tags: { area: "checkout" } });
      codeskop.captureException(err); // the same object is sent once
    }
    expect(await codeskop.flush(3000)).toBe(true);
    const [e] = ingest.ofType("exception");
    expect(ingest.ofType("exception")).toHaveLength(1);
    expect(e.payload.exception_class).toBe("Error");
    expect(e.payload.message).toBe("checkout failed");
    expect(e.payload.stacktrace[0].in_app).toBe(true);
    expect(e.payload.stacktrace[0].file).toContain("test/sdk.test.ts");
    expect(e.payload.cause.exception_class).toBe("TypeError");
    expect(e.payload.cause.stacktrace[0].method).toBe("boom");
    expect(e.payload.tags).toEqual({ area: "checkout" });
    const ctx = ingest.batches[0].context;
    expect(ctx.device.platform).toBe("node");
    expect([ctx.app.release, ctx.app.environment, ctx.app.sdk_name]).toEqual(["1.4.2", "test", "codeskop-node"]);
  });

  it("parses V8 stacks and marks dependencies as not in app", () => {
    const frames = parseStack(["Error: x", "    at Object.handler (/app/src/routes.ts:10:5)", "    at run (/app/node_modules/express/lib/router.js:1:1)", "    at node:internal/process/task_queues:95:5"].join("\n"));
    expect([frames[0].class, frames[0].method, frames[0].in_app]).toEqual(["Object", "handler", true]);
    expect([frames[1].method, frames[1].in_app, frames[2].in_app]).toEqual(["run", false, false]);
  });

  it("retries on 429 / 503 and keeps the batch", async () => {
    await start();
    ingest.responses = [[429, { "Retry-After": "0" }], [503, { "Retry-After": "0" }]];
    codeskop.captureMessage("eventually delivered");
    expect(await codeskop.flush(5000)).toBe(true);
    expect(ingest.events.map((e) => e.payload.message)).toEqual(["eventually delivered"]);
    expect(ingest.requests.filter((r) => r.method === "POST")).toHaveLength(3);
  });

  it("drops a batch on a permanent 4xx", async () => {
    await start();
    ingest.responses = [[400, {}]];
    codeskop.captureMessage("bad");
    await codeskop.flush(2000);
    codeskop.captureMessage("next");
    await codeskop.flush(2000);
    expect(ingest.events.map((e) => e.payload.message)).toEqual(["next"]);
  });

  it("sends batches of at most 100", async () => {
    await start();
    for (let i = 0; i < 250; i++) codeskop.captureMessage(`m${i}`);
    expect(await codeskop.flush(5000)).toBe(true);
    const sizes = ingest.batches.map((b) => b.batch.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it("honours the remote kill switch and never samples out failures", async () => {
    ingest.config = { enabled: true, sample_rates: { http_request: 0 }, features: { network: true } };
    const app = express();
    app.use(codeskop.expressMiddleware());
    app.get("/ok", (_q, r) => { r.send("ok"); });
    app.get("/broken", (_q, r) => { r.status(503).send("down"); });
    await start({ captureOutgoing: false });
    await withServer(app, async (base) => { await fetch(`${base}/ok`); await fetch(`${base}/broken`); });
    await codeskop.flush(3000);
    expect(ingest.ofType("http_request").map((e) => e.payload.route)).toEqual(["/broken"]);
  });

  it("route helpers", () => {
    expect(templateRoute("/orders/:id/items/:itemId?")).toBe("/orders/{id}/items/{itemId}");
    expect(templateRoute("/api/orders/[id]")).toBe("/api/orders/{id}");
    expect(normalizePath("/users/42/files/0f8fad5b-d9cb-469f-a165-70867728950e?x=1")).toBe("/users/{id}/files/{id}");
  });
});

async function withServer(app: any, fn: (base: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try { await fn(base); } finally {
    server.closeAllConnections?.(); // Node 18 keeps idle keep-alive sockets open on close()
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("integrations", () => {
  it("express: routes, users and errors", async () => {
    const app = express();
    app.use(codeskop.expressMiddleware());
    app.get("/orders/:id", (req, res) => { codeskop.setUser(42); res.json({ id: req.params.id }); });
    app.get("/boom", () => { throw new RangeError("view exploded"); });
    app.use(codeskop.expressErrorHandler());
    app.use((_err: unknown, _req: unknown, res: any, _next: unknown) => res.status(500).send("error"));
    await start({ captureOutgoing: false });
    await withServer(app, async (base) => {
      await fetch(`${base}/orders/7`);
      await fetch(`${base}/orders/8`);
      await fetch(`${base}/boom`);
      await fetch(`${base}/healthz`);
    });
    await codeskop.flush(3000);
    const reqs = ingest.ofType("http_request").map((e) => [e.payload.route, e.payload.status]).sort();
    expect(reqs).toEqual([["/boom", 500], ["/orders/{id}", 200], ["/orders/{id}", 200]]);
    expect(ingest.ofType("http_request").find((e) => e.payload.status === 200).user).toEqual({ id: "42" });
    const [exc] = ingest.ofType("exception");
    expect([exc.payload.exception_class, exc.payload.mechanism, exc.payload.request.route]).toEqual(["RangeError", "express", "/boom"]);
  });

  it("fastify: routes and errors", async () => {
    const app = Fastify();
    await app.register(codeskop.fastifyPlugin);
    app.get("/items/:itemId", async (req: any) => ({ item: req.params.itemId }));
    app.get("/fail", async () => { throw new Error("missing"); });
    await start({ captureOutgoing: false });
    await app.inject({ method: "GET", url: "/items/5" });
    await app.inject({ method: "GET", url: "/fail" });
    await codeskop.flush(3000);
    const reqs = ingest.ofType("http_request").map((e) => [e.payload.route, e.payload.status]).sort();
    expect(reqs).toEqual([["/fail", 500], ["/items/{itemId}", 200]]);
    expect(ingest.ofType("exception")[0].payload.mechanism).toBe("fastify");
    await app.close();
  });

  it("next.js route handlers", async () => {
    await start({ captureOutgoing: false });
    const GET = codeskop.withCodeskop(async () => Response.json({ ok: true }), { route: "/api/orders/[id]" });
    const POST = codeskop.withCodeskop(async () => { throw new Error("handler failed"); }, { route: "/api/pay" });
    expect((await GET(new Request("http://x/api/orders/9"), {})).status).toBe(200);
    await expect(POST(new Request("http://x/api/pay", { method: "POST" }), {})).rejects.toThrow("handler failed");
    const reqs = ingest.ofType("http_request").map((e) => [e.payload.method, e.payload.route, e.payload.status]).sort();
    expect(reqs).toEqual([["GET", "/api/orders/{id}", 200], ["POST", "/api/pay", 500]]);
    expect(ingest.ofType("exception")[0].payload.mechanism).toBe("nextjs");
  });

  it("outgoing fetch and http calls (never the ingest endpoint)", async () => {
    await start();
    const target = upstream.url.replace("127.0.0.1", "localhost");
    await fetch(`${target}/v1/customers/123?expand=1`);
    await fetch(`${target}/v1/charges/err`);
    await new Promise<void>((r) => http.get(`${target}/v1/legacy/9`, (res) => { res.resume(); res.on("end", () => r()); }));
    await fetch("http://localhost:1/unreachable").catch(() => {});
    await codeskop.flush(3000);
    const timings = ingest.ofType("api_timing").map((e) => [e.payload.path, e.payload.status ?? null]).sort();
    expect(timings).toEqual([["/unreachable", null], ["/v1/charges/err", 502], ["/v1/customers/{id}", 200], ["/v1/legacy/{id}", 200]]);
    expect(ingest.ofType("api_error").map((e) => e.payload.error_kind).sort()).toEqual(["http_5xx", "network_error"]);
    expect(ingest.events.some((e) => e.payload.host === "127.0.0.1")).toBe(false);
  });

  it("sends a crash from an uncaught exception before the process exits", async () => {
    const script = `import("${process.cwd()}/dist/index.js").then((c) => { c.init({ apiKey: "${KEY}", endpoint: "${ingest.url}" }); setTimeout(() => { throw new Error("crash e2e"); }, 50); });`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 15000 });
    expect(r.status).not.toBe(0); // Node still crashes as it would without us
    for (let i = 0; i < 50 && !ingest.ofType("exception").length; i++) await new Promise((x) => setTimeout(x, 100));
    const [e] = ingest.ofType("exception");
    expect([e.payload.message, e.payload.mechanism, e.payload.handled]).toEqual(["crash e2e", "uncaughtException", false]);
  });
});

describe("api trust", () => {
  const SALT = "s".repeat(64);
  const h = (raw: string) => createHmac("sha256", SALT).update(raw).digest("hex").slice(0, 32);
  const cfg = (blocking = false) => ({
    enabled: true, features: { network: true }, sample_rates: { http_request: 0 },
    api_trust: { enabled: true, salt: SALT, trust_proxy: true, blocking, verdicts_path: "/v1/trust/verdicts",
      consumer_sources: [{ type: "header", name: "X-API-Key" }, { type: "jwt", header: "Authorization", claims: ["client_id", "sub"] }, { type: "mtls", header: "X-Client-Cert" }, { type: "query", name: "api_key" }] },
  });
  const jwt = (claims: object) => [{ alg: "RS256" }, claims].map((x) => Buffer.from(JSON.stringify(x)).toString("base64url")).join(".") + ".sig";
  const app = () => {
    const a = express();
    a.use(codeskop.expressMiddleware());
    a.post("/v1/charges", (_q, r) => { r.json({ ok: true }); });
    a.get("/v1/charges", (_q, r) => { r.json({ ok: true }); });
    return a;
  };

  it("hashes consumers, captures client signals, never samples attributed calls", async () => {
    ingest.config = cfg();
    await start({ captureOutgoing: false });
    await withServer(app(), async (base) => {
      await fetch(`${base}/v1/charges`, { method: "POST", headers: { "X-API-Key": "live_secret_123", "X-Forwarded-For": "203.0.113.7, 10.0.0.1", Origin: "https://shop.example.com", "User-Agent": "Shop/2.0 (com.shop.app)" } });
      await fetch(`${base}/v1/charges`, { headers: { Authorization: `Bearer ${jwt({ client_id: "partner-42" })}` } });
      await fetch(`${base}/v1/charges`, { headers: { "X-Client-Cert": "sha256:ab12" } });
      await fetch(`${base}/v1/charges?api_key=qkey`);
      await fetch(`${base}/v1/charges`); // no consumer: sampled out at rate 0
    });
    await codeskop.flush(3000);
    const reqs = ingest.ofType("http_request");
    expect(reqs.map((e) => [e.payload.consumer.auth_type, e.payload.consumer.id_hash])).toEqual([["api_key", h("live_secret_123")], ["jwt", h("partner-42")], ["mtls", h("sha256:ab12")], ["api_key", h("qkey")]]);
    expect([reqs[0].payload.client.ip, reqs[0].payload.client.origin]).toEqual(["203.0.113.7", "https://shop.example.com"]);
    const raw = JSON.stringify(ingest.events);
    expect(raw).not.toContain("live_secret_123");
    expect(raw).not.toContain("partner-42");
  });

  it("blocks consumers from the verdict list, and fails open", async () => {
    ingest.config = cfg(true);
    ingest.routes["/v1/trust/verdicts"] = [200, { blocked: [h("banned-key")] }];
    await start({ captureOutgoing: false });
    await withServer(app(), async (base) => {
      const blocked = await fetch(`${base}/v1/charges`, { method: "POST", headers: { "X-API-Key": "banned-key" } });
      const ok = await fetch(`${base}/v1/charges`, { method: "POST", headers: { "X-API-Key": "good-key" } });
      expect([blocked.status, await blocked.json(), ok.status]).toEqual([403, { error: "consumer_blocked" }, 200]);
    });
    await codeskop.flush(3000);
    expect(ingest.ofType("http_request").map((e) => [e.payload.status, e.payload.blocked ?? false]).sort()).toEqual([[200, false], [403, true]]);

    ingest.routes["/v1/trust/verdicts"] = [503, {}];
    await getClient()?.close(200);
    await start({ captureOutgoing: false });
    await withServer(app(), async (base) => {
      expect((await fetch(`${base}/v1/charges`, { method: "POST", headers: { "X-API-Key": "banned-key" } })).status).toBe(200);
    });
  });
});
