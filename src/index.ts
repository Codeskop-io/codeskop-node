/**
 * Codeskop server SDK for Node.js.
 *
 *   import * as codeskop from "@codeskop/node";
 *   codeskop.init({ apiKey: "cs_live_pk_…" });
 *
 * Every function is safe to call before `init` (it does nothing) and never throws into your code.
 */
import { Client, context, type Options } from "./client.js";
import { captureException } from "./capture.js";
import { installHttpClients } from "./integrations/http.js";
import { getClient, setClient } from "./state.js";

export type { Options } from "./client.js";
export type { CodeskopEvent, Severity } from "./events.js";
export { VERSION } from "./version.js";
export { expressMiddleware, expressErrorHandler } from "./integrations/express.js";
export { fastifyPlugin } from "./integrations/fastify.js";
export { withCodeskop } from "./integrations/next.js";
export { getClient } from "./state.js";

let hooksInstalled = false;

export function init(options: Options = {}): Client {
  getClient()?.close(500).catch(() => {});
  const client = new Client(options);
  setClient(client);
  installHooks();
  if (client.options.captureOutgoing) installHttpClients();
  return client;
}

export { captureException, captureMessage } from "./capture.js";

/** Attach later events in the current request / async context to a user (your own ID, not an email). */
export function setUser(userId: string | number | null): void {
  const store = context.getStore();
  if (store) store.userId = userId == null ? null : String(userId);
}

/** Run `fn` with its own user context (integrations do this per request). */
export function runWithContext<T>(fn: () => T): T {
  return context.run({ userId: null }, fn);
}

export const flush = (timeoutMs = 2000) => getClient()?.flush(timeoutMs) ?? Promise.resolve(true);
export const close = (timeoutMs = 2000) => getClient()?.close(timeoutMs) ?? Promise.resolve();

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // `uncaughtExceptionMonitor` observes without changing Node's behaviour (the process still
  // crashes as it would without us). Since Node 15 unhandled rejections arrive here too.
  process.on("uncaughtExceptionMonitor", (err, origin) => {
    const client = getClient();
    if (!client?.enabled) return;
    captureException(err, { handled: false, mechanism: origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException" });
    client.flushSync();
  });
  process.on("beforeExit", () => { void getClient()?.flush(2000); });
}
