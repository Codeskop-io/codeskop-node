/**
 * Express (4 and 5), and NestJS on Express:
 *
 *   app.use(codeskop.expressMiddleware());   // first
 *   … your routes …
 *   app.use(codeskop.expressErrorHandler()); // after your routes, before your own error handlers
 */
import { context, setFramework } from "../client.js";
import { normalizePath, templateRoute } from "../events.js";
import { BLOCKED_BODY, Recorder, num } from "./recorder.js";

type Req = { method: string; originalUrl?: string; url: string; baseUrl?: string; route?: { path?: string | RegExp }; headers: Record<string, string | string[] | undefined>; query?: Record<string, unknown>; socket?: { remoteAddress?: string }; user?: { id?: unknown }; _codeskop?: Recorder };
type Res = { statusCode: number; on: (e: string, fn: () => void) => void; getHeader: (n: string) => unknown; status: (n: number) => Res; set?: (k: string, v: string) => Res; setHeader: (k: string, v: string) => void; end: (b?: string) => void; headersSent?: boolean };

const header = (req: Req) => (name: string) => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export function routeOf(req: Req): string {
  const path = req.route?.path;
  if (typeof path === "string") return templateRoute(`${req.baseUrl ?? ""}${path}`);
  return normalizePath((req.originalUrl ?? req.url ?? "/").split("?")[0]);
}

export function expressMiddleware() {
  setFramework("express");
  return function codeskopRequest(req: Req, res: Res, next: (err?: unknown) => void) {
    const h = header(req);
    const rec = new Recorder(req.method, h);
    req._codeskop = rec;
    const query = (k: string) => { const v = req.query?.[k]; return typeof v === "string" ? v : undefined; };
    if (rec.trust(req, h, query, req.socket?.remoteAddress)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(BLOCKED_BODY);
      rec.finish(normalizePath(req.originalUrl ?? req.url), 403);
      return;
    }
    res.on("finish", () => {
      const uid = (req.user as { id?: unknown } | undefined)?.id;
      if (uid != null && !rec.store.userId) rec.store.userId = String(uid);
      rec.finish(routeOf(req), res.statusCode, num(h("content-length")), num(res.getHeader("content-length")));
    });
    context.run(rec.store, () => next());
  };
}

export function expressErrorHandler() {
  return function codeskopError(err: unknown, req: Req, _res: Res, next: (err?: unknown) => void) {
    req._codeskop?.exception(err, routeOf(req), "express");
    next(err);
  };
}
