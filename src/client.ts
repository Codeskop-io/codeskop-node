/**
 * The client: options, context, sampling, remote config, transport and the background sender.
 *
 * Nothing blocks the caller: events are queued and sent by an unref'd timer (it never keeps
 * the process alive), in gzip batches of up to 100, honouring Retry-After and backing off on
 * failures. On a crash the pending events are sent synchronously in a short-lived child
 * process, because Node exits right after an uncaught exception.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { hostname, release, type } from "node:os";
import { gzipSync } from "node:zlib";
import { exceptionClass, nowIso, type CodeskopEvent } from "./events.js";
import { Trust, type TrustConfig } from "./trust.js";
import { VERSION } from "./version.js";

export type Options = {
  apiKey?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  captureRequests?: boolean;
  captureOutgoing?: boolean;
  sampleRates?: Record<string, number>;
  ignoreRoutes?: string[];
  ignoreExceptions?: string[];
  beforeSend?: (event: CodeskopEvent) => CodeskopEvent | null | undefined;
  sendUserId?: boolean;
  maxQueueEvents?: number;
  flushIntervalMs?: number;
  debug?: boolean;
  enabled?: boolean;
  /** API Trust: return the calling consumer's ID from a request yourself (overrides configured sources). */
  apiTrustResolver?: (req: unknown) => string | null | undefined;
  trustProxy?: boolean;
};

export type ResolvedOptions = Required<Omit<Options, "release" | "beforeSend" | "apiTrustResolver" | "trustProxy">> & Pick<Options, "release" | "beforeSend" | "apiTrustResolver" | "trustProxy">;

const RELEASE_ENV = ["CODESKOP_RELEASE", "RENDER_GIT_COMMIT", "HEROKU_SLUG_COMMIT", "SOURCE_VERSION", "VERCEL_GIT_COMMIT_SHA", "RAILWAY_GIT_COMMIT_SHA", "K_REVISION", "GITHUB_SHA"];
const PUBLIC_KEY = /^cs_(live|test)_pk_[A-Za-z0-9_-]{8,}$/;
const MAX_BATCH = 100;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const CONFIG_REFRESH_MS = 300_000;
const NEVER_SAMPLED = new Set(["exception", "api_error"]);
export const USER_AGENT = `codeskop-node/${VERSION}`;

type Store = { userId?: string | null };
export const context = new AsyncLocalStorage<Store>();
let framework: string | undefined;
export const setFramework = (name: string) => { framework = name; };

export function resolveOptions(o: Options): ResolvedOptions {
  const env = process.env;
  return {
    apiKey: (o.apiKey ?? env.CODESKOP_API_KEY ?? "").trim(),
    endpoint: (o.endpoint ?? env.CODESKOP_ENDPOINT ?? "https://api.codeskop.com").replace(/\/+$/, ""),
    environment: o.environment ?? env.CODESKOP_ENVIRONMENT ?? "production",
    release: o.release ?? RELEASE_ENV.map((k) => env[k]).find(Boolean)?.slice(0, 64),
    captureRequests: o.captureRequests ?? true,
    captureOutgoing: o.captureOutgoing ?? true,
    sampleRates: o.sampleRates ?? {},
    ignoreRoutes: o.ignoreRoutes ?? ["/health*", "/healthz", "/metrics", "/favicon.ico"],
    ignoreExceptions: o.ignoreExceptions ?? [],
    beforeSend: o.beforeSend,
    sendUserId: o.sendUserId ?? true,
    maxQueueEvents: o.maxQueueEvents ?? 10_000,
    flushIntervalMs: o.flushIntervalMs ?? 5_000,
    debug: o.debug ?? false,
    enabled: o.enabled ?? true,
    apiTrustResolver: o.apiTrustResolver,
    trustProxy: o.trustProxy,
  };
}

export function keyProblem(key: string): string | null {
  if (!key) return "no apiKey (set CODESKOP_API_KEY or pass apiKey)";
  if (key.includes("_sk_")) return "a secret key (_sk_) was given; use the project's public key (cs_..._pk_...)";
  if (!PUBLIC_KEY.test(key)) return "the apiKey doesn't look like a Codeskop public key (cs_live_pk_... or cs_test_pk_...)";
  return null;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

export class Client {
  readonly options: ResolvedOptions;
  enabled: boolean;
  remote: Record<string, any> = {};
  trust: Trust | null = null;
  private queue: CodeskopEvent[] = [];
  private pending: CodeskopEvent[] | null = null;
  private attempt = 0;
  private nextSendAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private sending: Promise<void> | null = null;
  private etag: string | null = null;
  private configAt = 0;
  private configLoading: Promise<void> | null = null;
  private closed = false;
  private ignoreRoutes: RegExp[];

  constructor(options: Options) {
    this.options = resolveOptions(options);
    this.ignoreRoutes = this.options.ignoreRoutes.map(globToRegExp);
    const problem = keyProblem(this.options.apiKey);
    this.enabled = this.options.enabled && !problem;
    if (problem) console.warn(`[codeskop] disabled: ${problem}`);
    if (this.enabled) {
      this.timer = setInterval(() => void this.tick(), this.options.flushIntervalMs);
      this.timer.unref();
      this.configLoading = this.refreshConfig(true);
    }
  }

  log(...args: unknown[]) {
    if (this.options.debug) console.debug("[codeskop]", ...args);
  }

  /** Resolves once the first remote config fetch has finished (tests and serverless start-up). */
  ready(): Promise<void> {
    return this.configLoading ?? Promise.resolve();
  }

  // -- remote config & sampling ----------------------------------------------

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey}`, "User-Agent": USER_AGENT, ...extra };
  }

  async refreshConfig(force = false): Promise<void> {
    if (!force && Date.now() - this.configAt < CONFIG_REFRESH_MS) return;
    this.configAt = Date.now();
    try {
      const res = await fetch(`${this.options.endpoint}/v1/config`, { headers: this.headers(this.etag ? { "If-None-Match": this.etag } : {}), signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) {
        this.remote = (await res.json()) as Record<string, any>;
        this.etag = res.headers.get("etag");
        if (this.remote.enabled === false) { this.queue = []; this.pending = null; }
        const trustCfg = this.remote.api_trust as TrustConfig | undefined;
        if (trustCfg?.enabled && !this.trust) this.trust = new Trust(this);
        if (this.trust) await this.trust.configure(trustCfg ?? ({ enabled: false } as TrustConfig));
      } else if (res.status === 401 || res.status === 403) {
        console.warn(`[codeskop] the API key was refused (HTTP ${res.status}); events won't be accepted`);
      }
    } catch (err) {
      this.log("config fetch failed", err);
    }
  }

  feature(name: string, fallback = true): boolean {
    const f = this.remote.features;
    return f && typeof f === "object" && name in f ? Boolean(f[name]) : fallback;
  }

  sampleRate(type: string): number {
    for (const src of [this.remote.sample_rates ?? {}, this.options.sampleRates]) {
      if (type in src) return clamp(src[type]);
      if (type === "http_request" && "api_timing" in src) return clamp(src.api_timing);
    }
    return 1;
  }

  keep(e: CodeskopEvent): boolean {
    if (NEVER_SAMPLED.has(e.type) || e.severity === "high") return true;
    if (e.type === "http_request" && "consumer" in e.payload) return true; // API Trust audit trail
    const rate = this.sampleRate(e.type);
    return rate >= 1 || Math.random() < rate;
  }

  ignoredRoute(route: string) {
    return this.ignoreRoutes.some((r) => r.test(route));
  }

  ignoredException(err: unknown) {
    return this.options.ignoreExceptions.includes(exceptionClass(err));
  }

  currentUser(): string | null {
    return this.options.sendUserId ? context.getStore()?.userId ?? null : null;
  }

  // -- capture ----------------------------------------------------------------

  envelopeContext() {
    return {
      device: { platform: "node", hostname: hostname(), os: `${type()} ${release()}`, runtime: `Node ${process.version}` },
      app: Object.fromEntries(Object.entries({ release: this.options.release, environment: this.options.environment, framework, sdk_name: "codeskop-node", sdk_version: VERSION }).filter(([, v]) => v)),
    };
  }

  capture(e: CodeskopEvent): void {
    if (!this.enabled || this.closed || this.remote.enabled === false) return;
    try {
      if ((e.type === "http_request" || e.type === "api_timing" || e.type === "api_error") && !this.feature("network")) return;
      if (!this.keep(e)) return;
      let ev: CodeskopEvent | null | undefined = e;
      if (this.options.beforeSend) ev = this.options.beforeSend(e);
      if (!ev) return;
      if (this.queue.length >= this.options.maxQueueEvents) this.queue.shift();
      this.queue.push(ev);
      if (this.queue.length >= MAX_BATCH) void this.tick();
    } catch (err) {
      this.log("capture failed", err);
    }
  }

  // -- sending ------------------------------------------------------------------

  private bodies(batch: CodeskopEvent[]): Buffer[] {
    const events = batch.filter((e) => JSON.stringify(e).length <= MAX_EVENT_BYTES);
    if (!events.length) return [];
    const split = (evs: CodeskopEvent[]): Buffer[] => {
      const body = gzipSync(JSON.stringify({ sent_at: nowIso(), context: this.envelopeContext(), batch: evs }));
      if (body.length <= MAX_BODY_BYTES || evs.length === 1) return [body];
      const mid = Math.floor(evs.length / 2);
      return [...split(evs.slice(0, mid)), ...split(evs.slice(mid))];
    };
    return split(events);
  }

  /** One send attempt for the pending batch: true when done (sent or permanently refused). */
  private async send(body: Buffer): Promise<{ done: boolean; retryAfter: number }> {
    try {
      const res = await fetch(`${this.options.endpoint}/v1/events`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", "Content-Encoding": "gzip" }),
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { done: true, retryAfter: 0 };
      if (res.status === 429 || res.status === 503) return { done: false, retryAfter: retryAfter(res.headers.get("retry-after")) };
      if (res.status >= 500) return { done: false, retryAfter: backoff(this.attempt) };
      console.warn(`[codeskop] ingest refused a batch (HTTP ${res.status}); dropping it`);
      return { done: true, retryAfter: 0 };
    } catch {
      return { done: false, retryAfter: backoff(this.attempt) };
    }
  }

  private async drain(force: boolean): Promise<void> {
    for (;;) {
      if (!force && Date.now() < this.nextSendAt) return;
      if (!this.pending) {
        if (!this.queue.length) return;
        this.pending = this.queue.splice(0, MAX_BATCH);
        this.attempt = 0;
      }
      let failure: { retryAfter: number } | null = null;
      for (const body of this.bodies(this.pending)) {
        const r = await this.send(body);
        if (!r.done) { failure = r; break; }
      }
      if (!failure) { this.pending = null; this.attempt = 0; continue; }
      this.attempt += 1;
      this.nextSendAt = Date.now() + failure.retryAfter * 1000;
      if (force && this.attempt < 3) { await sleep(Math.min(failure.retryAfter, 1) * 1000); continue; }
      return;
    }
  }

  private tick(force = false): Promise<void> {
    if (this.sending) return force ? this.sending.then(() => this.tick(true)) : this.sending;
    this.sending = (async () => {
      try {
        await this.refreshConfig();
        await this.drain(force);
      } catch (err) {
        this.log("send loop failed", err);
      } finally {
        this.sending = null;
      }
    })();
    return this.sending;
  }

  /** Send everything queued; resolves true when the queue is empty, false on timeout. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    if (!this.enabled) return true;
    this.nextSendAt = 0;
    const done = this.tick(true).then(() => !this.queue.length && !this.pending);
    return Promise.race([done, sleep(timeoutMs).then(() => false)]);
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!this.enabled || this.closed) return;
    await this.flush(timeoutMs);
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Crash path: send what's queued synchronously from a child process (Node exits next). */
  flushSync(timeoutMs = 3000): void {
    if (!this.enabled) return;
    const events = [...(this.pending ?? []), ...this.queue];
    if (!events.length) return;
    this.queue = []; this.pending = null;
    const body = JSON.stringify({ sent_at: nowIso(), context: this.envelopeContext(), batch: events.slice(0, MAX_BATCH) });
    const script = `fetch(process.env.U,{method:"POST",headers:JSON.parse(process.env.H),body:require("zlib").gzipSync(require("fs").readFileSync(0))}).catch(()=>{}).finally(()=>process.exit(0))`;
    try {
      spawnSync(process.execPath, ["-e", script], {
        input: body, timeout: timeoutMs, stdio: ["pipe", "ignore", "ignore"],
        env: { U: `${this.options.endpoint}/v1/events`, H: JSON.stringify(this.headers({ "Content-Type": "application/json", "Content-Encoding": "gzip" })), PATH: process.env.PATH ?? "" },
      });
    } catch {
      /* the process is exiting anyway */
    }
  }
}

const clamp = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1; };
const retryAfter = (v: string | null) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 5; };
const backoff = (attempt: number) => Math.min(60, 2 ** Math.max(0, attempt)) * (0.8 + Math.random() * 0.4);
const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });
