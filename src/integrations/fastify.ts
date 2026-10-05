/**
 * Fastify (4 and 5), and NestJS on Fastify:   await app.register(codeskop.fastifyPlugin)
 */
import { context, setFramework } from "../client.js";
import { normalizePath, templateRoute } from "../events.js";
import { BLOCKED_BODY, Recorder, num } from "./recorder.js";

type FReq = { method: string; url: string; headers: Record<string, string | string[] | undefined>; query?: unknown; ip?: string; routeOptions?: { url?: string }; routerPath?: string; user?: { id?: unknown }; codeskop?: Recorder };
type FReply = { statusCode: number; getHeader: (n: string) => unknown; code: (n: number) => FReply; type: (t: string) => FReply; send: (b: string) => unknown };

const header = (req: FReq) => (name: string) => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
const routeOf = (req: FReq) => {
  const r = req.routeOptions?.url ?? req.routerPath;
  return r ? templateRoute(r) : normalizePath(req.url);
};

async function plugin(app: any): Promise<void> {
  setFramework("fastify");
  app.decorateRequest("codeskop", null);
  app.addHook("onRequest", async (req: FReq, reply: FReply) => {
    const h = header(req);
    const rec = new Recorder(req.method, h);
    req.codeskop = rec;
    context.enterWith(rec.store);
    const q = req.query as Record<string, unknown> | undefined;
    if (rec.trust(req, h, (k) => (typeof q?.[k] === "string" ? (q[k] as string) : undefined), req.ip)) {
      return reply.code(403).type("application/json").send(BLOCKED_BODY);
    }
  });
  app.addHook("onError", async (req: FReq, _reply: FReply, err: unknown) => {
    req.codeskop?.exception(err, routeOf(req), "fastify");
  });
  app.addHook("onResponse", async (req: FReq, reply: FReply) => {
    const rec = req.codeskop;
    const uid = req.user?.id;
    if (uid != null && rec && !rec.store.userId) rec.store.userId = String(uid);
    rec?.finish(rec.blocked ? normalizePath(req.url) : routeOf(req), reply.statusCode, num(header(req)("content-length")), num(reply.getHeader("content-length")));
  });
}

// Mark as a fastify-plugin (skip encapsulation) without depending on the `fastify-plugin` package.
(plugin as any)[Symbol.for("skip-override")] = true;
(plugin as any)[Symbol.for("fastify.display-name")] = "codeskop";
export const fastifyPlugin = plugin;
