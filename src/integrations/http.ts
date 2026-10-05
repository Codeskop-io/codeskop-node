/**
 * Outgoing HTTP: global `fetch` (undici) and `http`/`https.request` → `api_timing` / `api_error`.
 * Calls to the Codeskop endpoint itself are never recorded.
 */
import http from "node:http";
import https from "node:https";
import { outgoingEvents } from "../events.js";
import { getClient } from "../state.js";

let installed = false;

function record(method: string, url: URL, status: number | undefined, started: number, errorKind?: string, responseBytes?: number) {
  const client = getClient();
  if (!client?.enabled || !client.options.captureOutgoing) return;
  try {
    if (!url.hostname || url.host === new URL(client.options.endpoint).host) return;
    for (const e of outgoingEvents({ method, host: url.hostname, path: url.pathname || "/", status, durationMs: performance.now() - started, errorKind, responseBytes, userId: client.currentUser() })) {
      client.capture(e);
    }
  } catch { /* never break the caller */ }
}

const kind = (err: unknown) => (/timeout|abort/i.test(String((err as Error)?.name ?? "") + String((err as Error)?.message ?? "")) ? "timeout" : "network_error");

export function installHttpClients(): void {
  if (installed) return;
  installed = true;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = async function codeskopFetch(input: string | URL | Request, init?: RequestInit) {
      const started = performance.now();
      let url: URL | null = null;
      let method = init?.method ?? "GET";
      try {
        if (input instanceof Request) { url = new URL(input.url); method = init?.method ?? input.method; }
        else url = new URL(String(input));
      } catch { /* relative or odd input: don't record */ }
      try {
        const res = await originalFetch(input, init);
        if (url) record(method, url, res.status, started, undefined, Number(res.headers.get("content-length")) || undefined);
        return res;
      } catch (err) {
        if (url) record(method, url, undefined, started, kind(err));
        throw err;
      }
    } as typeof fetch;
  }

  for (const mod of [http, https]) {
    const scheme = mod === https ? "https:" : "http:";
    const originalRequest = mod.request;
    const wrapped = function (this: unknown, ...args: any[]) {
      const started = performance.now();
      const req: http.ClientRequest = (originalRequest as any).apply(this, args);
      let url: URL | null = null;
      try {
        const host = req.getHeader("host") ?? req.host;
        url = new URL(`${scheme}//${host}${req.path}`);
      } catch { /* ignore */ }
      if (url) {
        req.once("response", (res) => res.once("end", () => record(req.method, url!, res.statusCode, started, undefined, Number(res.headers["content-length"]) || undefined)));
        req.once("error", (err) => record(req.method, url!, undefined, started, kind(err)));
      }
      return req;
    };
    (mod as any).request = wrapped;
    (mod as any).get = function (this: unknown, ...args: any[]) {
      const req = (wrapped as any).apply(this, args);
      req.end();
      return req;
    };
  }
}
