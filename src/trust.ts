/**
 * API Trust capture (docs/10 §10.9), active only when remote config contains `api_trust`.
 * Consumer credentials are HMAC-hashed here; the raw value never leaves your server.
 * Blocking is opt-in and fails open.
 */
import { createHmac } from "node:crypto";
import type { Client } from "./client.js";

export type ConsumerSource =
  | { type: "header"; name: string; scheme?: string }
  | { type: "query"; name: string }
  | { type: "jwt"; header?: string; claims?: string[] }
  | { type: "mtls"; header: string };

export type TrustConfig = { enabled: boolean; salt?: string; consumer_sources?: ConsumerSource[]; trust_proxy?: boolean; blocking?: boolean; verdicts_path?: string };
export type HeaderGet = (name: string) => string | undefined | null;
type Inspection = { extra: Record<string, unknown>; blocked: boolean };

const VERDICT_REFRESH_MS = 60_000;

export class Trust {
  active = false;
  private sources: ConsumerSource[] = [];
  private salt = "";
  private trustProxy = true;
  private blocking = false;
  private verdictsPath = "/v1/trust/verdicts";
  private blocked = new Set<string>();
  private verdictEtag: string | null = null;
  private verdictsAt = 0;
  private refreshing = false;

  constructor(private client: Client) {}

  async configure(cfg: TrustConfig): Promise<void> {
    this.active = Boolean(cfg.enabled && cfg.salt);
    this.sources = Array.isArray(cfg.consumer_sources) ? cfg.consumer_sources : [];
    this.salt = cfg.salt ?? "";
    this.trustProxy = this.client.options.trustProxy ?? cfg.trust_proxy ?? true;
    this.blocking = Boolean(cfg.blocking);
    this.verdictsPath = cfg.verdicts_path ?? "/v1/trust/verdicts";
    if (!this.blocking) this.blocked.clear();
    else if (!this.verdictsAt) await this.fetchVerdicts();
  }

  private hash(raw: string) {
    return createHmac("sha256", this.salt).update(raw).digest("hex").slice(0, 32);
  }

  consumer(req: unknown, h: HeaderGet, q: (k: string) => string | undefined | null) {
    const resolver = this.client.options.apiTrustResolver;
    if (resolver) {
      try {
        const raw = resolver(req);
        if (raw) return { id_hash: this.hash(String(raw)), auth_type: "custom", source: "resolver" };
      } catch { /* fall through to configured sources */ }
    }
    for (const s of this.sources) {
      let raw: string | null | undefined;
      let auth = "api_key";
      let label = "";
      if (s.type === "header") {
        raw = h(s.name);
        if (raw && s.scheme) raw = raw.toLowerCase().startsWith(`${s.scheme.toLowerCase()} `) ? raw.slice(s.scheme.length + 1) : null;
        label = `header:${s.name}`;
      } else if (s.type === "query") {
        raw = q(s.name);
        label = `query:${s.name}`;
      } else if (s.type === "jwt") {
        raw = jwtClaim(h(s.header ?? "Authorization"), s.claims ?? ["sub"]);
        auth = "jwt"; label = "jwt";
      } else if (s.type === "mtls") {
        raw = h(s.header);
        auth = "mtls"; label = `mtls:${s.header}`;
      }
      if (raw) return { id_hash: this.hash(String(raw).trim()), auth_type: auth, source: label.slice(0, 80) };
    }
    return null;
  }

  clientIp(h: HeaderGet, peer?: string | null): string | null {
    if (this.trustProxy) {
      const fwd = h("x-forwarded-for");
      if (fwd) return fwd.split(",")[0].trim().slice(0, 64);
      const forwarded = h("forwarded");
      if (forwarded?.includes("for=")) return forwarded.split("for=")[1].split(/[;,]/)[0].trim().replace(/^"|"$/g, "").replace(/^\[|\](:\d+)?$/g, "").slice(0, 64);
      const real = h("x-real-ip");
      if (real) return real.trim().slice(0, 64);
    }
    return peer ? peer.replace(/^::ffff:/, "") : null;
  }

  inspect(req: unknown, h: HeaderGet, q: (k: string) => string | undefined | null, peer?: string | null): Inspection {
    const safe: HeaderGet = (n) => { try { return h(n) ?? undefined; } catch { return undefined; } };
    const extra: Record<string, unknown> = {};
    const consumer = this.consumer(req, safe, q);
    if (consumer) extra.consumer = consumer;
    const client = Object.fromEntries(Object.entries({
      ip: this.clientIp(safe, peer),
      user_agent: (safe("user-agent") ?? "").slice(0, 300),
      origin: (safe("origin") ?? "").slice(0, 300),
      referer: (safe("referer") ?? "").slice(0, 300),
      requested_with: (safe("x-requested-with") ?? "").slice(0, 200),
    }).filter(([, v]) => v));
    if (Object.keys(client).length) extra.client = client;
    return { extra, blocked: Boolean(consumer && this.blocking && this.isBlocked(consumer.id_hash)) };
  }

  private isBlocked(hash: string): boolean {
    if (Date.now() - this.verdictsAt > VERDICT_REFRESH_MS && !this.refreshing) void this.fetchVerdicts();
    return this.blocked.has(hash);
  }

  private async fetchVerdicts(): Promise<void> {
    this.refreshing = true;
    this.verdictsAt = Date.now();
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.client.options.apiKey}`, "User-Agent": `codeskop-node` };
      if (this.verdictEtag) headers["If-None-Match"] = this.verdictEtag;
      const res = await fetch(this.client.options.endpoint + this.verdictsPath, { headers, signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) {
        const body = (await res.json()) as { blocked?: string[] };
        this.blocked = new Set((body.blocked ?? []).map(String));
        this.verdictEtag = res.headers.get("etag");
      }
    } catch { /* fail open */ } finally {
      this.refreshing = false;
    }
  }
}

function jwtClaim(header: string | null | undefined, claims: string[]): string | null {
  if (!header) return null;
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : header;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    for (const c of claims) if (payload?.[c]) return String(payload[c]);
  } catch { /* not a JWT */ }
  return null;
}
