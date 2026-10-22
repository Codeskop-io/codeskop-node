<p align="center">
  <a href="https://www.codeskop.com/?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node">
    <img src="https://www.codeskop.com/media/product-tour-poster.jpg" alt="Codeskop dashboard: crash-free users, active users, open issues and API latency" width="720">
  </a>
</p>

# Codeskop for Node.js

**Codeskop** is crash, error and API monitoring for mobile, web and backend apps. [Get started free at www.codeskop.com](https://www.codeskop.com/?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node).

[![npm version](https://img.shields.io/npm/v/@codeskop/node.svg)](https://www.npmjs.com/package/@codeskop/node)
[![Node.js version](https://img.shields.io/node/v/@codeskop/node.svg)](https://www.npmjs.com/package/@codeskop/node)
[![license](https://img.shields.io/npm/l/@codeskop/node.svg)](https://github.com/Codeskop-io/codeskop-node/blob/main/LICENSE)

`@codeskop/node` is the Node.js SDK for [Codeskop](https://www.codeskop.com/?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node). Add it to an Express, Fastify, NestJS or Next.js backend and Codeskop groups its errors into issues with stack traces, records every request it handles by route, and shows which outgoing API calls fail or slow down, next to the crashes and network calls from your mobile and web apps.

- **Errors:** uncaught exceptions and unhandled rejections (Node still exits exactly as it would without Codeskop), errors in your routes, and `captureException()` / `captureMessage()`. `Error.cause` chains included.
- **Incoming requests:** every request your service handles, by route (`/orders/{id}`), with status, latency and size.
- **Outgoing calls:** `fetch` and `http`/`https` calls to other APIs, with status, latency and failures.
- **Light and safe:** no dependencies, written in TypeScript, ESM and CommonJS. It never blocks a request: events are batched and sent in the background.

Works with Express and Fastify (tested on 5), NestJS, Next.js App Router route handlers, `fetch` and the `http`/`https` modules. Node.js 18 and later.

## Get started in 2 minutes

**1. Create a free account** at **[dashboard.codeskop.com/signup](https://dashboard.codeskop.com/signup?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node)**. No credit card. Every project has a **Test** key (`cs_test_pk_…`) and a **Live** key (`cs_live_pk_…`); copy one from **API tokens**.

**2. Install:**

```bash
npm install @codeskop/node     # or: pnpm add @codeskop/node / yarn add @codeskop/node
```

**3. Set your key** (Test key locally, Live key in production):

```bash
export CODESKOP_API_KEY=cs_test_pk_…
```

**4. Initialize once, before your app starts handling requests, and add your framework:**

```ts
import express from "express";
import * as codeskop from "@codeskop/node";

codeskop.init();   // reads CODESKOP_API_KEY; or codeskop.init({ apiKey: "cs_live_pk_…" })

const app = express();
app.use(codeskop.expressMiddleware());    // first

app.get("/orders/:id", getOrder);

app.use(codeskop.expressErrorHandler());  // after your routes, before your own error handlers
app.listen(3000);
```

Throw an error in a route and it shows up in your dashboard a few seconds later.

## Frameworks

### Express

As above: `expressMiddleware()` first, `expressErrorHandler()` after your routes. If an auth middleware sets `req.user.id` (Passport, for example), it's attached as the user ID.

### Fastify

```ts
import Fastify from "fastify";
import * as codeskop from "@codeskop/node";

codeskop.init();

const app = Fastify();
await app.register(codeskop.fastifyPlugin);
```

### NestJS

NestJS runs on Express (default) or Fastify; add the matching integration.

```ts
// main.ts
const app = await NestFactory.create(AppModule);
app.use(codeskop.expressMiddleware());
```

### Next.js route handlers (App Router)

```ts
// app/api/orders/[id]/route.ts
import * as codeskop from "@codeskop/node";

export const GET = codeskop.withCodeskop(
  async (req: Request) => Response.json(await getOrder(req)),
  { route: "/api/orders/[id]" },
);
```

## Common tasks

```ts
import * as codeskop from "@codeskop/node";

// Report a handled error, with optional tags.
try {
  await charge(order);
} catch (err) {
  codeskop.captureException(err, { tags: { provider: "stripe" } });
}

codeskop.captureMessage("Inventory sync skipped");

// Inside a request: attach events to a user (your own ID, never an email).
codeskop.setUser(req.user.id);
```

### Clusters and serverless

PM2 and `cluster` workers each send their own events. On AWS Lambda or other functions, flush at the end of each invocation:

```ts
export const handler = async (event) => {
  try {
    return await process(event);
  } finally {
    await codeskop.flush(2000); // send before the runtime freezes
  }
};
```

## What's captured automatically

- **Uncaught exceptions and unhandled rejections**, sent before the process exits, without changing Node's crash behaviour.
- **Errors in your routes**, with the route they happened on, once your framework integration is added.
- **Every incoming request** by route, with method, status, latency and size. Find them on the Network page under *Requests your servers receive*. Health checks aren't recorded; change that with `ignoreRoutes`.
- **Outgoing `fetch` and `http`/`https` calls**, on the Network page under *APIs your apps call*.
- **Release**, detected from `CODESKOP_RELEASE` or the commit on Render, Heroku, Vercel, Railway, Cloud Run and GitHub Actions.

## API keys and environments

Server SDKs use the project's **public** key, the same kind of key your mobile and web apps use. Public keys can only send events, never read your data.

| Key | Use it for |
|---|---|
| `cs_test_pk_…` (Test) | Local development, CI and staging, so test traffic never mixes with real users |
| `cs_live_pk_…` (Live) | Production |

Set it as `CODESKOP_API_KEY` in each environment and the SDK reads it on its own, or pass `codeskop.init({ apiKey })` in code. Never put a secret key (`cs_…_sk_…`) in a service: the SDK refuses it and stays switched off, without throwing. A missing or malformed key does the same, so if nothing shows up, check the key first.

Create a separate Codeskop project for each backend service so its issues and routes stay apart. More: [Core concepts](https://www.codeskop.com/docs/concepts?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) and [server SDK keys](https://www.codeskop.com/docs/server?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node#keys).

## Configuration

Pass options to `codeskop.init()`. Option types ship with the package (`import type { Options } from "@codeskop/node"`).

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `CODESKOP_API_KEY` | The project's public key. Secret keys are refused and the SDK stays off. |
| `environment` | `string` | `"production"` | Shown on events. Env var `CODESKOP_ENVIRONMENT`. |
| `release` | `string` | auto | Your version or commit. Env var `CODESKOP_RELEASE`. |
| `captureRequests` | `boolean` | `true` | Record incoming requests. |
| `captureOutgoing` | `boolean` | `true` | Record `fetch` and `http` calls. |
| `ignoreRoutes` | `string[]` | health checks | Glob patterns never recorded. |
| `ignoreExceptions` | `string[]` | `[]` | Error class names never sent. |
| `beforeSend` | `function` | none | Edit or drop any event before it's sent (return `null` to drop). |
| `sendUserId` | `boolean` | `true` | Attach the signed-in user's ID. |
| `debug` | `boolean` | `false` | Log what the SDK does. |

## Plans

| | Free | Starter | Growth | Scale |
|---|---|---|---|---|
| Errors | ✓ | ✓ | ✓ | ✓ |
| Incoming requests and outgoing API calls | | ✓ | ✓ | ✓ |
| Events per month | 10,000 | 100,000 | 1,000,000 | 10,000,000 |
| Data retention | 7 days | 30 days | 90 days | 365 days |

The SDK is the same on every plan; your plan decides what's kept. Request and API call monitoring follow the network monitoring on your plan, with the same sampling, and failed requests are always kept. See [pricing](https://www.codeskop.com/pricing?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node).

## Privacy

**Never captured:** request or response bodies, cookies, `Authorization` headers and query strings. Requests are recorded by route template, so IDs in the path don't become separate routes.

**What is sent:** the error type, message and stack trace; for each request, the method, route, status, latency and size; for outgoing calls, the method, host, path, status and latency. Each event also carries your environment and release, plus the host name, OS and runtime version of the server.

**You choose the user ID.** Pass your own ID, never an email address or phone number.

**Error messages are sent as written.** If yours can contain personal data, scrub or drop events with `beforeSend`, or skip error types with `ignoreExceptions`.

Details: [Privacy & Security](https://www.codeskop.com/docs/privacy?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node).

## Documentation

- [Node.js guide](https://www.codeskop.com/docs/server/node?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node)
- [Server SDKs overview](https://www.codeskop.com/docs/server?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node)
- [Privacy & Security](https://www.codeskop.com/docs/privacy?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node)
- [Troubleshooting](https://www.codeskop.com/docs/troubleshooting?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node)
- [Changelog](https://github.com/Codeskop-io/codeskop-node/blob/main/CHANGELOG.md)

## Other Codeskop SDKs

Monitor your mobile apps, web apps and backend services in one dashboard:

| Platform | Package | Links |
|---|---|---|
| Android | `com.codeskop.sdk:tracker-android` | [Docs](https://www.codeskop.com/docs/quickstart/android?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) |
| Kotlin Multiplatform and iOS (beta) | `com.codeskop.sdk:tracker-core` | [Docs](https://www.codeskop.com/docs/kmp?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) |
| Flutter | `codeskop_tracker` | [Docs](https://www.codeskop.com/docs/android/flutter?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) |
| Web (JavaScript, React) | `@codeskop/tracker`, `@codeskop/tracker-react` | [Docs](https://www.codeskop.com/docs/web/installation?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) · [GitHub](https://github.com/Codeskop-io/web-sdk) |
| Go | `github.com/Codeskop-io/codeskop-go` | [Docs](https://www.codeskop.com/docs/server/go?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) · [GitHub](https://github.com/Codeskop-io/codeskop-go) |
| Python | `codeskop` | [Docs](https://www.codeskop.com/docs/server/python?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) · [GitHub](https://github.com/Codeskop-io/codeskop-python) |
| **Node.js** (this SDK) | `@codeskop/node` | [Docs](https://www.codeskop.com/docs/server/node?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) · [GitHub](https://github.com/Codeskop-io/codeskop-node) |
| Java and Kotlin (JVM) | `com.codeskop.sdk:codeskop-server` | [Docs](https://www.codeskop.com/docs/server/java?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) · [GitHub](https://github.com/Codeskop-io/codeskop-jvm) |
| PHP (beta) | `codeskop/codeskop-php` | [Docs](https://www.codeskop.com/docs/server/php?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) · [GitHub](https://github.com/Codeskop-io/codeskop-php) |
| Any other language | OpenTelemetry (OTLP) or HTTPS | [OpenTelemetry](https://www.codeskop.com/docs/server/opentelemetry?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) · [Ingest API](https://www.codeskop.com/docs/reference/ingest-api?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node) |

## Help

Questions or a bug? [Contact us](https://www.codeskop.com/contact?utm_source=github&utm_medium=readme&utm_campaign=codeskop-node), email support@codeskop.com, or open an issue in this repository.

## Development

```bash
npm ci && npm run build && npm test
```

Tests run against a local mock of the ingest API.

## License

[MIT](https://github.com/Codeskop-io/codeskop-node/blob/main/LICENSE)
