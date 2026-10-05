/** A mock Codeskop ingest server (docs/10 §10.10): validates envelopes like the real backend. */
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";

export const KEY = "cs_test_pk_abcdefgh12345678";
const TYPES = new Set(["api_error", "api_timing", "exception", "crash", "crash_native", "anr", "heartbeat", "http_request", "track", "screen", "identify"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

export class MockIngest {
  batches: any[] = [];
  requests: { method: string; path: string; headers: Record<string, any> }[] = [];
  responses: [number, Record<string, string>][] = [];
  config: Record<string, any> = { enabled: true, sample_rates: {}, features: { network: true } };
  routes: Record<string, [number, unknown]> = {};
  errors: string[] = [];
  url = "";
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const path = req.url ?? "/";
        this.requests.push({ method: req.method ?? "GET", path, headers: req.headers });
        const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { "Content-Type": "application/json", ...headers });
          res.end(JSON.stringify(body));
        };
        if (req.method === "GET" && path.startsWith("/v1/config")) return json(200, this.config, { ETag: '"v1"' });
        for (const [prefix, [status, body]] of Object.entries(this.routes)) if (path.startsWith(prefix)) return json(status, body);
        if (req.method !== "POST" || !path.startsWith("/v1/events")) return json(200, { ok: true, path });
        const scripted = this.responses.shift();
        if (scripted && scripted[0] !== 200) return json(scripted[0], { detail: "scripted" }, scripted[1]);
        try {
          let raw = Buffer.concat(chunks);
          if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
          const env = JSON.parse(raw.toString("utf8"));
          this.validate(env, req.headers);
          this.batches.push(env);
          json(200, {});
        } catch (e) {
          this.errors.push(String(e));
          json(400, { errors: String(e) });
        }
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    return this;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  validate(env: any, headers: Record<string, any>) {
    if (headers.authorization !== `Bearer ${KEY}`) throw new Error("bad auth");
    if (!String(headers["user-agent"] ?? "").startsWith("codeskop-node/")) throw new Error("user agent");
    if (typeof env.sent_at !== "string") throw new Error("sent_at");
    if (typeof env.context?.device !== "object" || typeof env.context?.app !== "object") throw new Error("context");
    if (!Array.isArray(env.batch) || env.batch.length < 1 || env.batch.length > 100) throw new Error("batch size");
    for (const e of env.batch) {
      if (typeof e.event_id !== "string") throw new Error("event_id");
      if (!TYPES.has(e.type)) throw new Error(`type ${e.type}`);
      if (!SEVERITIES.has(e.severity)) throw new Error("severity");
      if (typeof e.occurred_at !== "string" || !e.occurred_at.endsWith("Z")) throw new Error("occurred_at");
      if (JSON.stringify(e).length > 64 * 1024) throw new Error("too large");
    }
  }

  get events(): any[] {
    return this.batches.flatMap((b) => b.batch);
  }

  ofType(type: string): any[] {
    return this.events.filter((e) => e.type === type);
  }
}
