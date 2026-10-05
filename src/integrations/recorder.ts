/** One incoming request: start, (optional) exception, finish. Shared by every framework integration. */
import { randomUUID } from "node:crypto";
import { captureException } from "../capture.js";
import { requestEvent } from "../events.js";
import { getClient } from "../state.js";
import type { HeaderGet } from "../trust.js";

export const BLOCKED_BODY = JSON.stringify({ error: "consumer_blocked" });

export class Recorder {
  readonly started = performance.now();
  readonly requestId: string;
  failed = false;
  blocked = false;
  trustExtra: Record<string, unknown> | null = null;
  /** The request's async context; integrations run the handler inside it. */
  readonly store: { userId?: string | null } = { userId: null };
  private finished = false;

  constructor(readonly method: string, header: HeaderGet) {
    this.requestId = String(header("x-request-id") ?? "").slice(0, 128) || randomUUID().replace(/-/g, "");
  }

  /** API Trust capture; true when the request must be refused (opt-in blocking). */
  trust(req: unknown, header: HeaderGet, query: (k: string) => string | undefined | null, peer?: string | null): boolean {
    const trust = getClient()?.trust;
    if (!trust?.active) return false;
    try {
      const { extra, blocked } = trust.inspect(req, header, query, peer);
      this.trustExtra = extra;
      this.blocked = blocked;
      return blocked;
    } catch {
      return false; // fail open
    }
  }

  exception(err: unknown, route: string, mechanism: string): void {
    this.failed = true;
    captureException(err, { handled: false, mechanism, userId: this.userId(), request: { method: this.method, route, request_id: this.requestId } });
  }

  userId(): string | null {
    const client = getClient();
    if (!client?.options.sendUserId) return null;
    return this.store.userId ?? client.currentUser();
  }

  finish(route: string, status: number, requestBytes?: number, responseBytes?: number): void {
    if (this.finished) return;
    this.finished = true;
    const client = getClient();
    if (!client?.enabled || !client.options.captureRequests || client.ignoredRoute(route)) return;
    const extra = { ...(this.trustExtra ?? {}), ...(this.blocked ? { blocked: true } : {}) };
    client.capture(requestEvent({
      method: this.method, route, status, durationMs: performance.now() - this.started, requestBytes, responseBytes,
      requestId: this.requestId, failed: this.failed, userId: this.userId(), extra: Object.keys(extra).length ? extra : undefined,
    }));
  }
}

export const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isFinite(n) ? n : undefined;
};
