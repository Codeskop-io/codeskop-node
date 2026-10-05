/** captureException / captureMessage, shared by the public API and the integrations. */
import { exceptionEvent, messageEvent, type Severity } from "./events.js";
import { getClient } from "./state.js";

export function captureException(error: unknown, opts: { userId?: string | null; tags?: Record<string, unknown>; handled?: boolean; mechanism?: string; request?: Record<string, unknown> } = {}): void {
  const client = getClient();
  if (!client?.enabled || error == null) return;
  try {
    if (client.ignoredException(error)) return;
    if (typeof error === "object") {
      if ((error as { __codeskop?: boolean }).__codeskop) return;
      try { Object.defineProperty(error, "__codeskop", { value: true, enumerable: false }); } catch { /* frozen */ }
    }
    client.capture(exceptionEvent(error, { handled: opts.handled ?? true, mechanism: opts.mechanism ?? "manual", request: opts.request, userId: opts.userId ?? client.currentUser(), tags: opts.tags }));
  } catch {
    /* never throw */
  }
}

export function captureMessage(message: string, severity: Severity = "medium"): void {
  const client = getClient();
  if (!client?.enabled) return;
  client.capture(messageEvent(message, severity, client.currentUser()));
}
