/**
 * Next.js App Router route handlers (and any Web-standard Request → Response handler):
 *
 *   export const GET = withCodeskop(async (req) => Response.json(…), { route: "/api/orders/[id]" });
 *
 * Records the request, reports thrown errors, and flushes before the function returns so
 * serverless runtimes don't freeze with events in memory.
 */
import { context, setFramework } from "../client.js";
import { normalizePath, templateRoute } from "../events.js";
import { getClient } from "../state.js";
import { BLOCKED_BODY, Recorder, num } from "./recorder.js";

type Handler<C> = (req: Request, ctx: C) => Response | Promise<Response>;

export function withCodeskop<C = unknown>(handler: Handler<C>, opts: { route?: string; flushMs?: number } = {}): Handler<C> {
  setFramework("nextjs");
  return async (req: Request, ctx: C) => {
    const url = new URL(req.url);
    const route = opts.route ? templateRoute(opts.route) : normalizePath(url.pathname);
    const h = (name: string) => req.headers.get(name);
    const rec = new Recorder(req.method, h);
    return context.run(rec.store, async () => {
      if (rec.trust(req, h, (k) => url.searchParams.get(k))) {
        rec.finish(route, 403);
        await getClient()?.flush(opts.flushMs ?? 1000);
        return new Response(BLOCKED_BODY, { status: 403, headers: { "Content-Type": "application/json" } });
      }
      try {
        const res = await handler(req, ctx);
        rec.finish(route, res.status, num(h("content-length")), num(res.headers.get("content-length")));
        return res;
      } catch (err) {
        rec.exception(err, route, "nextjs");
        rec.finish(route, 500, num(h("content-length")));
        throw err;
      } finally {
        await getClient()?.flush(opts.flushMs ?? 1000);
      }
    });
  };
}
