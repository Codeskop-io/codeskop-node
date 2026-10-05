/** Event builders (docs/10 §10.6): exceptions, incoming requests, outgoing calls. */
import { randomUUID } from "node:crypto";
import { sep } from "node:path";

export type Severity = "low" | "medium" | "high" | "critical";
export type Frame = { class: string; method: string; file: string; line?: number; column?: number; in_app: boolean };
export type CodeskopEvent = {
  event_id: string;
  type: "exception" | "http_request" | "api_timing" | "api_error";
  severity: Severity;
  occurred_at: string;
  payload: Record<string, unknown>;
  user?: { id: string };
};

const MAX_MESSAGE = 2048;
const MAX_FRAMES = 100;
const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;

export const nowIso = () => new Date().toISOString();

/** Same templating as the server: drop the query, numeric/UUID/long-hex segments → {id}. */
export function normalizePath(path: string): string {
  const clean = (path || "/").split("?")[0].split("#")[0];
  const out = clean.split("/").map((s) => (s && (NUMERIC.test(s) || UUID.test(s) || HEX.test(s)) ? "{id}" : s)).join("/");
  return out.startsWith("/") ? out : `/${out}`;
}

/** A framework route in our `{name}` form: `/users/:id` → `/users/{id}`, `/files/*` stays. */
export function templateRoute(route: string): string {
  const out = (route || "/").replace(/:([A-Za-z0-9_]+)(\([^)]*\))?\??/g, "{$1}").replace(/\[\.\.\.([^\]]+)\]/g, "{$1}").replace(/\[([^\]]+)\]/g, "{$1}");
  return out.startsWith("/") ? out : `/${out}`;
}

// ---------------------------------------------------------------------------
// Stack traces (V8 format)
// ---------------------------------------------------------------------------

const FRAME_RE = /^\s*at (?:(.+?) \()?(.*?):(\d+):(\d+)\)?$/;
const cwd = process.cwd();

export function isInApp(file: string): boolean {
  if (!file || file.startsWith("node:") || file.startsWith("internal/") || !file.includes("/") && !file.includes("\\")) return false;
  if (file.includes(`${sep}node_modules${sep}`) || file.includes("/node_modules/")) return false;
  if (file.includes("@codeskop/node") || file.includes(`${sep}codeskop-node${sep}dist`)) return false;
  return true;
}

function shortPath(file: string): string {
  const f = file.replace(/^file:\/\//, "");
  return f.startsWith(cwd + sep) ? f.slice(cwd.length + 1) : f;
}

export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    const fn = (m[1] || "<anonymous>").replace(/^async /, "");
    const file = m[2].replace(/^file:\/\//, "");
    const dot = fn.lastIndexOf(".");
    const module = shortPath(file).replace(/\.(m|c)?[jt]sx?$/, "").replace(/[\\/]/g, ".");
    frames.push({
      class: dot > 0 && !fn.startsWith("new ") ? fn.slice(0, dot) : module,
      method: dot > 0 ? fn.slice(dot + 1) : fn,
      file: shortPath(file),
      line: Number(m[3]),
      column: Number(m[4]),
      in_app: isInApp(file),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames; // V8 already lists the innermost frame first
}

export function exceptionClass(err: unknown): string {
  if (err instanceof Error) return err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";
  return typeof err === "string" ? "Error" : typeof err;
}

function exceptionPayload(err: unknown, depth = 0): Record<string, unknown> {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err));
  const payload: Record<string, unknown> = {
    exception_class: exceptionClass(err),
    message: String(e.message ?? "").slice(0, MAX_MESSAGE),
    stacktrace: parseStack(e.stack),
  };
  const cause = (e as { cause?: unknown }).cause;
  if (cause && depth < 3) payload.cause = exceptionPayload(cause, depth + 1);
  return payload;
}

function event(type: CodeskopEvent["type"], severity: Severity, payload: Record<string, unknown>, userId?: string | null): CodeskopEvent {
  const e: CodeskopEvent = { event_id: randomUUID(), type, severity, occurred_at: nowIso(), payload };
  if (userId) e.user = { id: String(userId).slice(0, 128) };
  return e;
}

export function exceptionEvent(err: unknown, opts: { handled: boolean; mechanism: string; request?: Record<string, unknown>; userId?: string | null; tags?: Record<string, unknown>; severity?: Severity }): CodeskopEvent {
  const payload = exceptionPayload(err);
  payload.handled = opts.handled;
  payload.mechanism = opts.mechanism;
  if (opts.request) payload.request = opts.request;
  if (opts.tags) payload.tags = Object.fromEntries(Object.entries(opts.tags).slice(0, 20).map(([k, v]) => [k.slice(0, 64), String(v).slice(0, 256)]));
  return event("exception", opts.severity ?? (opts.handled ? "medium" : "high"), payload, opts.userId);
}

export function messageEvent(message: string, severity: Severity = "medium", userId?: string | null): CodeskopEvent {
  return event("exception", severity, { exception_class: "Message", message: String(message).slice(0, MAX_MESSAGE), stacktrace: [], handled: true, mechanism: "message" }, userId);
}

export function requestEvent(r: { method: string; route: string; status: number; durationMs: number; requestBytes?: number; responseBytes?: number; requestId?: string; failed?: boolean; userId?: string | null; extra?: Record<string, unknown> }): CodeskopEvent {
  const payload: Record<string, unknown> = { method: (r.method || "GET").toUpperCase(), route: r.route || "/", status: r.status || 0, duration_ms: Math.round(r.durationMs * 100) / 100 };
  if (r.requestBytes !== undefined) payload.request_bytes = r.requestBytes;
  if (r.responseBytes !== undefined) payload.response_bytes = r.responseBytes;
  if (r.requestId) payload.request_id = r.requestId;
  if (r.extra) Object.assign(payload, r.extra);
  return event("http_request", r.failed || (r.status ?? 0) >= 500 ? "high" : "low", payload, r.userId);
}

export function outgoingEvents(o: { method: string; host: string; path: string; status?: number; durationMs: number; errorKind?: string; requestBytes?: number; responseBytes?: number; userId?: string | null }): CodeskopEvent[] {
  const payload: Record<string, unknown> = { method: (o.method || "GET").toUpperCase(), host: o.host, path: normalizePath(o.path), duration_ms: Math.round(o.durationMs * 100) / 100 };
  if (o.status !== undefined) payload.status = o.status;
  if (o.requestBytes !== undefined) payload.request_bytes = o.requestBytes;
  if (o.responseBytes !== undefined) payload.response_bytes = o.responseBytes;
  let kind = o.errorKind;
  if (!kind && o.status !== undefined && o.status >= 400) kind = o.status >= 500 ? "http_5xx" : "http_4xx";
  const out = [event("api_timing", "low", { ...payload }, o.userId)];
  if (kind) out.push(event("api_error", "high", { ...payload, error_kind: kind }, o.userId));
  return out;
}
