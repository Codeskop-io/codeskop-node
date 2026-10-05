# Codeskop for Node.js

Errors, incoming requests and outgoing API calls from your Node.js backend, in Codeskop.

```bash
npm install @codeskop/node
```

```ts
import * as codeskop from "@codeskop/node";

codeskop.init({ apiKey: process.env.CODESKOP_API_KEY }); // cs_live_pk_…  (public key)
```

## Frameworks

**Express** (and NestJS on Express)

```ts
app.use(codeskop.expressMiddleware());   // first
// … routes …
app.use(codeskop.expressErrorHandler()); // after routes, before your own error handlers
```

**Fastify** (and NestJS on Fastify)

```ts
await app.register(codeskop.fastifyPlugin);
```

**Next.js route handlers** (App Router)

```ts
export const GET = codeskop.withCodeskop(async (req) => Response.json(await getOrder(req)), { route: "/api/orders/[id]" });
```

## Errors and users

```ts
codeskop.captureException(err, { tags: { provider: "stripe" } });
codeskop.captureMessage("Inventory sync skipped");
codeskop.setUser(user.id); // inside a request: attaches later events to this user
```

Uncaught exceptions and unhandled rejections are reported automatically, and Node still exits exactly as it would without Codeskop.

## Options

| Option | Default | |
|---|---|---|
| `apiKey` | `CODESKOP_API_KEY` | Public key. Secret keys are refused. |
| `endpoint` | `https://api.codeskop.com` | `CODESKOP_ENDPOINT` |
| `environment` | `production` | `CODESKOP_ENVIRONMENT` |
| `release` | auto | `CODESKOP_RELEASE`, or the commit on Render, Heroku, Vercel, Railway, Cloud Run, GitHub Actions |
| `captureRequests` / `captureOutgoing` | `true` | Incoming requests / outgoing `fetch` + `http` calls |
| `ignoreRoutes` | health checks | Glob patterns |
| `ignoreExceptions` | `[]` | Error class names never sent |
| `beforeSend` | none | Edit or drop events |
| `debug` | `false` | Log SDK activity |

Never captured: request or response bodies, cookies, `Authorization` headers, query strings.

## Development

```bash
npm ci && npm run build && npm test
```

Tests run against a local mock of the ingest API. The contract is in the backend repo, `docs/10-server-sdk-spec.md`.

## License

MIT
