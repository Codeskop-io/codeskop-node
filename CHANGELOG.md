# Changelog

## 0.1.1, 2026-10-06

- Contact email is now support@codeskop.com.

## 0.1.0 (beta), 2026-10-05

First release.

- Errors: uncaught exceptions and unhandled rejections (sent before the process exits, without changing Node's crash behaviour), `captureException`, `captureMessage`, `Error.cause` chains, frames marked `in_app`.
- Incoming requests (`http_request`) per route for Express, Fastify (and NestJS on either) and Next.js route handlers (`withCodeskop`).
- Outgoing `fetch` and `http`/`https` calls (`api_timing` / `api_error`).
- Background sending in gzip batches of up to 100 with Retry-After and backoff; never keeps the process alive.
- Remote config: kill switch, network gate, sampling (failures never sampled out).
- API Trust capture and opt-in blocking when enabled for the project.
- Zero runtime dependencies; Node 18+.
