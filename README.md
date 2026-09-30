# clauth-proxy-core

the shared core every clauth-compatible proxy builds on, so every proxy looks the same to clauth and only its proxy↔provider code varies.

<p align="center">
  <img src="https://cov.uwuclxdy.dev/badges/uwuclxdy/clauth-proxy-core/coverage.svg" alt="coverage" />
  <img src="https://cov.uwuclxdy.dev/badges/uwuclxdy/clauth-proxy-core/ratio.svg" alt="code to test ratio" />
  <img src="https://cov.uwuclxdy.dev/badges/uwuclxdy/clauth-proxy-core/time.svg" alt="test execution time" />
  <a href="#license"><img src="https://shields.uwuclxdy.dev/badge/license-MIT%20OR%20Apache--2.0-blue" alt="MIT OR Apache-2.0 license" /></a>
</p>

## What it is

A headless library in TypeScript on bun. It serves the clauth proxy contract v1 — the inference listener, the control API, the account store, config, logs and lifecycle — from a provider-adapter interface. A proxy is this core plus its provider code; clauth renders everything, so a proxy has no UI of its own.

The core owns:

- the HTTP server: routing, the constant-time admin-token check, request caps, both error envelopes, no `Access-Control-Allow-*` headers, a loopback-only bind
- the account store: account records, `clp_` inference-key minting, SHA-256 hash-only storage and lookup, re-mint, re-bind and delete, with one opaque blob persisted for the adapter's upstream credential (state dir `0700`, files `0600`, atomic writes)
- the login flow state machine: pending/done/failed/expired, poll and paste doors, cancel, garbage collection, `identity_mismatch` on a re-bind landing on another upstream user
- the usage cache: polling each account at an adapter-declared cadence, keeping the last good figure with its old `read_at` and a `stale_reason` on a failed read
- settings validation against the declared form, `/config` for proxy scope and `PATCH /accounts/{id}` for account scope
- `POST /v1/messages` forwarding with streaming passthrough and Anthropic's error envelope
- the lifecycle: a `manifest`/`serve` CLI, SIGTERM draining open streams before exit

The adapter owns only its manifest fields and the upstream calls: starting, polling, pasting and cancelling a login; forwarding one inference request; reading one account's figures; running one declared action; dropping an account's upstream login on delete.

## Who uses it

A maintainer building a `clauth-<service>-proxy`: fork or write one adapter, and the core supplies the whole surface clauth talks to. The full wire contract lives in [`skills/clauth-proxy-contract/SKILL.md`](skills/clauth-proxy-contract/SKILL.md).

## Install

As a git dependency:

```json
{
  "dependencies": {
    "clauth-proxy-core": "git+https://github.com/uwuclxdy/clauth-proxy-core.git#v0.1.0"
  }
}
```

For local work before the first tag, a path dependency works the same way:

```json
{
  "dependencies": {
    "clauth-proxy-core": "file:../clauth-proxy-core"
  }
}
```

## Minimal adapter

Save this as `bin/clauth-example-proxy`:

```ts
#!/usr/bin/env bun
import { defineProxy, runCli, type ProxyAdapter } from "clauth-proxy-core";

const adapter: ProxyAdapter = {
  manifest: {
    service: "example",
    display_name: "Example (example.ai)",
    version: "0.1.0",
    capabilities: ["events"],
    drain_secs: 30,
    figures: [{ id: "coding-plan-5h", kind: "window", label: "coding plan 5h", chain: "5h" }],
    settings: [],
    actions: [],
    usage_cadence_ms: 60_000,
  },
  async loginStart() {
    return {
      url: "https://example.ai/login",
      modes: ["poll"],
      poll_interval_ms: 1000,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      upstream: {},
    };
  },
  async loginPoll() {
    return { state: "done", identity: "user-1", label: "user@example.com", plans: [], blob: {} };
  },
  async loginCancel() {},
  async forward({ request }) {
    // `request` already has the client's key, host and hop-by-hop headers removed;
    // return the body decoded — the core strips content-encoding/content-length
    return fetch("https://example.ai/anthropic", {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  },
  async readFigures() {
    return [];
  },
  async runAction() {},
  async dropLogin() {},
};

runCli(defineProxy(adapter));
```

Run it: `bun bin/clauth-example-proxy manifest` prints the manifest and touches no network or state; `bun bin/clauth-example-proxy serve` reads `CLAUTH_PROXY_BIND` (loopback-only), `CLAUTH_PROXY_STATE_DIR` and `CLAUTH_PROXY_ADMIN_TOKEN_FILE` and serves until SIGTERM drains it.

## License

MIT OR Apache-2.0
