---
name: clauth-proxy-contract
description: the wire contract every clauth-compatible proxy serves on top of clauth-proxy-core — routes, field shapes, error envelopes, settings, figure kinds and the adapter API — plus the wire-parity workflow a proxy ships with.
---

# clauth proxy contract v1

The contract a `clauth-*-proxy` process serves to clauth. `clauth-proxy-core` implements it from a provider-adapter interface; a proxy is the core plus its proxy↔provider code. This skill pins every field shape, so a proxy and its clauth renderer agree without sharing code.

The control prefix is `/clauth/v1`; the contract major is `1`. A `clauth proxy check` run compares a live proxy against the field set of the minor its manifest declares, and against this document.

Conventions: JSON bodies, UTF-8. Timestamps are RFC 3339 in UTC (a `Z` or `+00:00` suffix both parse). Readers ignore unknown fields; a minor version only adds. Ids (`account`, `flow`, figure `id`, action `name`, setting `key`) match `[a-z0-9][a-z0-9._-]{0,63}`. No `Access-Control-Allow-*` header is ever set. Every human-readable field is written by the proxy, never copied from upstream bytes.

## Routes

| method | path | auth | request | response | status |
|---|---|---|---|---|---|
| GET | /health | none | — | health | 200 |
| GET | /clauth/v1/info | Bearer | — | info | 200 |
| GET | /clauth/v1/accounts | Bearer | — | accounts | 200 |
| POST | /clauth/v1/accounts/login | Bearer | login-request | login-start | 201 |
| GET | /clauth/v1/accounts/login/{flow} | Bearer | — | login-status | 200 |
| POST | /clauth/v1/accounts/login/{flow} | Bearer | paste-request | login-status | 200 |
| DELETE | /clauth/v1/accounts/login/{flow} | Bearer | — | — | 204 |
| PATCH | /clauth/v1/accounts/{id} | Bearer | settings-patch | account | 200 |
| DELETE | /clauth/v1/accounts/{id} | Bearer | — | — | 204 |
| POST | /clauth/v1/accounts/{id}/key | Bearer | — | key | 200 |
| POST | /clauth/v1/accounts/{id}/actions/{name} | Bearer | action-request | action-accepted | 202 |
| GET | /clauth/v1/usage | Bearer | — | usage | 200 |
| GET | /clauth/v1/config | Bearer | — | config-get | 200 |
| PATCH | /clauth/v1/config | Bearer | config-patch-request | config-patch | 200 |
| GET | /clauth/v1/events | Bearer | — | SSE | 200 |
| POST | /v1/messages | key | — | inference | passthrough |
| POST | /v1/messages/count_tokens | key | — | inference | passthrough |

Auth `Bearer` means `Authorization: Bearer <admin token>`, compared constant-time; a missing or wrong token answers 401 with `WWW-Authenticate: Bearer`. Auth `key` means the inference key from `x-api-key` or `Authorization: Bearer`; when both headers are present they must be equal. `GET /clauth/v1/events` exists only with the `events` capability, `POST /v1/messages/count_tokens` only with `count_tokens`; an undeclared optional route answers 501 `unsupported` (control) or 404 `not_found_error` (inference). A cancelled login flow (`DELETE /clauth/v1/accounts/login/{flow}`) reads back 404 `not_found`, like an unknown one.

## Field tables

### manifest

| field | type | req | meaning |
|---|---|---|---|
| service | string `[a-z0-9][a-z0-9-]{0,31}` | yes | equals the `<service>` in the binary name |
| display_name | string | yes | the Services-row label |
| description | string | no | one line of row detail |
| version | semver | yes | the proxy's own version |
| contract | `"MAJOR.MINOR"` | yes | the contract this proxy serves |
| capabilities | string[] | yes | `events`, `count_tokens`; unknown entries are ignored |
| drain_secs | int 0..3600 | no | how long SIGTERM may take to drain open streams |

### health

| field | type | req | meaning |
|---|---|---|---|
| status | `"ok"` | yes | the only v1 value; anything else reads as unhealthy |
| service | string | yes | as in the manifest |
| version | semver | yes | as in the manifest |
| contract | `"MAJOR.MINOR"` | yes | as in the manifest |

### info

| field | type | req | meaning |
|---|---|---|---|
| service | string | yes | as in the manifest |
| version | semver | yes | as in the manifest |
| contract | `"MAJOR.MINOR"` | yes | as in the manifest |
| capabilities | string[] | yes | as in the manifest |
| actions | action[] | yes | declared actions, may be `[]` |
| figures | figure-declaration[] | yes | every figure `/usage` can carry |
| settings | setting-field[] | yes | the settings form, may be `[]` |

### action

| field | type | req | meaning |
|---|---|---|---|
| name | id | yes | the `{name}` path segment |
| label | string | yes | the card or view entry text |
| scope | `"account"` | yes | v1 has account-scoped actions only |
| target | figure kind \| null | no | the kind of item the action's target names |
| confirm | bool | yes | ask before running |

### figure-declaration

| field | type | req | meaning |
|---|---|---|---|
| id | id | yes | the stable figure id, shared with `/usage` |
| kind | figure kind | yes | `window`, `balance`, `channel`, `offer` or `stats` |
| label | string | yes | the bar or row label |
| chain | `"5h"` \| `"7d"` | no | window only, one figure per role per account |

### setting-field

| field | type | req | meaning |
|---|---|---|---|
| key | id | yes | the settings key |
| scope | `"proxy"` \| `"account"` | yes | `/config` vs `PATCH /accounts/{id}` |
| label | string | yes | the row label |
| hint | string | yes | the row's help text |
| type | `bool` \| `enum` \| `int` \| `number` \| `string` | yes | the row grammar |
| default | any | yes | the value a fresh account or proxy starts with |
| options | `{value,label}[]` | no | enum only |
| min | number | no | numeric only |
| max | number | no | numeric only |
| step | number | no | numeric only; the stepper increment |
| unit | string | no | the numeric unit suffix |
| active_when | `{key, in[]}` | no | the field exists only while `key`'s value is in `in[]` |
| inactive_hint | string | no | the why, shown when dimmed |
| restart | bool | no | true triggers the restart flow on change |

### account

| field | type | req | meaning |
|---|---|---|---|
| id | id | yes | stable for the account's life, re-logins included |
| label | string | yes | the upstream identity as the proxy displays it |
| state | `ready` \| `login_required` \| `suspended` | yes | the account's upstream state |
| created_at | RFC 3339 | yes | the account's creation time |
| plans | plan[] | yes | the plans this login holds |
| settings | `{key: value}` | yes | every account-scope setting's current value |

### plan

| field | type | req | meaning |
|---|---|---|---|
| id | id | yes | the plan id |
| label | string | yes | the plan label |

### accounts

| field | type | req | meaning |
|---|---|---|---|
| accounts | account[] | yes | one entry per account |

### key

| field | type | req | meaning |
|---|---|---|---|
| inference_key | string | yes | `clp_…`, the freshly minted key |

### action-accepted

| field | type | req | meaning |
|---|---|---|---|
| accepted | `true` | yes | the action was queued; the outcome rides the figure |

### login-start

| field | type | req | meaning |
|---|---|---|---|
| flow | id, unguessable | yes | the poll handle |
| state | `"pending"` | yes | the only start value |
| url | string | yes | the login page the user opens |
| modes | subset of `["poll","paste"]` | yes | the doors this flow accepts; first to deliver wins |
| poll_interval_ms | int ≥ 1000 | yes | the cadence hint for the caller's poll loop |
| expires_at | RFC 3339 | yes | when the flow expires |

### login-status

| field | type | req | meaning |
|---|---|---|---|
| flow | id | yes | the poll handle |
| state | `pending` \| `done` \| `failed` \| `expired` | yes | the flow's state |
| poll_interval_ms | int ≥ 1000 | while pending | as in login-start |
| expires_at | RFC 3339 | while pending | as in login-start |
| account | account | on done | the created or re-bound account |
| inference_key | string | on done of a new account | `clp_…`, handed out once |
| error | closed code | on failed | `denied`, `code_invalid`, `identity_mismatch`, `resolve_failed`, `upstream_unavailable` or `internal` |

### usage

| field | type | req | meaning |
|---|---|---|---|
| accounts | usage-account[] | yes | one entry per account |

### usage-account

| field | type | req | meaning |
|---|---|---|---|
| account | id | yes | the account id |
| state | `ready` \| `login_required` \| `suspended` | yes | as in account |
| available | bool | yes | false when the account cannot make API calls |
| figures | figure[] | yes | one flat list, each with its own read time |

### figure-envelope

| field | type | req | meaning |
|---|---|---|---|
| kind | figure kind | yes | the kind this figure is |
| id | id | yes | stable per account across polls and restarts |
| label | string | yes | the bar or row label |
| read_at | RFC 3339 | yes | the figure's age |
| stale_reason | `login_required` \| `upstream_unavailable` \| `rate_limited` | no | this round's read failed; the last value and old `read_at` stay |
| summary | string | no | a proxy-written one-liner; how a clauth that does not know the kind renders it |

### figure-window

| field | type | req | meaning |
|---|---|---|---|
| used | number | yes | the amount used |
| limit | number > 0 | yes | the window's size |
| unit | unit | yes | `percent` sends `limit: 100` |
| unit_label | string | no | required when `unit` is `custom` |
| window_secs | int | yes | the window's nominal length in seconds |
| resets_at | RFC 3339 \| null | yes | when the window resets |
| chain | `"5h"` \| `"7d"` \| null | no | the chain role; `window_secs` must equal 18000 for `5h` and 604800 for `7d` |

### figure-balance

| field | type | req | meaning |
|---|---|---|---|
| remaining | number | yes | the amount left |
| limit | number | no | the balance's total |
| used | number | no | the amount used |
| unit | unit | yes | the balance's unit |
| unit_label | string | no | required when `unit` is `custom` |
| currency | ISO 4217 | no | required when `unit` is `currency` |
| expires_at | RFC 3339 | no | when the balance expires |

### figure-channel

| field | type | req | meaning |
|---|---|---|---|
| open | bool | yes | whether the channel is open now |
| next_open_at | RFC 3339 | no | the next opening |
| queue_position | int | no | the caller's place in the queue |

### figure-offer

| field | type | req | meaning |
|---|---|---|---|
| items | offer-item[] | yes | the claimable offers |

### offer-item

| field | type | req | meaning |
|---|---|---|---|
| id | id | yes | the offer item id |
| label | string | yes | the offer's label |
| description | string | no | the offer's detail |
| state | `available` \| `claiming` \| `claimed` \| `failed` | yes | the claim state |
| failure | string | no | a closed provider-specific claim-failure code |
| starts_at | RFC 3339 | no | when the offer opens |
| ends_at | RFC 3339 | no | when the offer closes |
| grants | grant[] | yes | what claiming grants |

### grant

| field | type | req | meaning |
|---|---|---|---|
| label | string | yes | what is granted |
| amount | number | yes | how much |
| unit | unit | yes | the amount's unit |
| unit_label | string | no | required when `unit` is `custom` |
| effective_at | RFC 3339 | no | when the grant lands |

### figure-stats

| field | type | req | meaning |
|---|---|---|---|
| since | RFC 3339 | yes | the counter epoch |
| requests | stats-requests | yes | the request counters |
| mean_latency_ms | number \| null | yes | null until a request got headers |
| tokens | stats-tokens | yes | the token counters |

### stats-requests

| field | type | req | meaning |
|---|---|---|---|
| attempted | int | yes | requests attempted |
| succeeded | int | yes | requests that succeeded |
| failed | int | yes | requests that failed |
| cancelled | int | yes | requests the caller cancelled |

### stats-tokens

| field | type | req | meaning |
|---|---|---|---|
| input | int | yes | input tokens |
| output | int | yes | output tokens |
| cache_read | int | yes | cache-read tokens |
| cache_creation | int | yes | cache-creation tokens |

### config-get

| field | type | req | meaning |
|---|---|---|---|
| values | `{key: value}` | yes | every proxy-scope setting's current value |

### config-patch

| field | type | req | meaning |
|---|---|---|---|
| values | `{key: value}` | yes | the merged proxy-scope values |
| restart_required | bool | yes | true when a changed key carries `restart: true` |

### control-error

| field | type | req | meaning |
|---|---|---|---|
| ok | `false` | yes | the failure marker |
| error | code | yes | a closed control code, mapped by the caller |
| reason | string | no | proxy-written detail, for the log and the scoped view |
| field | string | no | the setting key that failed |

### inference-error

| field | type | req | meaning |
|---|---|---|---|
| type | `"error"` | yes | the envelope marker |
| error | `{type, message}` | yes | the Anthropic error code and a message |

## Request bodies

### login-request

| field | type | req | meaning |
|---|---|---|---|
| account | id | no | re-bind this account instead of creating one |

### paste-request

| field | type | req | meaning |
|---|---|---|---|
| code | string | yes | the pasted code, at most 4096 B |

### settings-patch

| field | type | req | meaning |
|---|---|---|---|
| settings | `{key: value}` | yes | the settings to merge; `null` resets a key to its default |

### action-request

| field | type | req | meaning |
|---|---|---|---|
| target | id | no | the offer item the action runs on, when the action declares a target |

### config-patch-request

| field | type | req | meaning |
|---|---|---|---|
| values | `{key: value}` | yes | the proxy-scope values to merge; `null` resets a key |

## Error codes

Control routes answer the control-error envelope. Inference routes always answer the inference-error envelope.

| control code | status |
|---|---|
| bad_request | 400 |
| unauthorized | 401 |
| not_found | 404 |
| method_not_allowed | 405 |
| conflict, login_required, flow_not_paste | 409 |
| flow_expired | 410 |
| precondition_failed | 412 |
| payload_too_large | 413 |
| unknown_setting, invalid_setting, invalid_target | 422 |
| internal | 500 |
| unsupported | 501 |
| upstream_unavailable | 503 |

An adapter login-start result that fails validation answers 500 `internal`; a `loginStart` that throws answers 503 `upstream_unavailable`.

| inference condition | status | error.type |
|---|---|---|
| no key, unknown key, admin token presented, or `x-api-key` and Bearer disagree | 401 | authentication_error |
| account `login_required` | 401 | authentication_error |
| account `suspended` | 403 | permission_error |
| unknown path, or `count_tokens` without the capability | 404 | not_found_error |
| malformed body | 400 | invalid_request_error |
| body over the cap | 413 | request_too_large |
| upstream 429 | 429 | rate_limit_error, `retry-after` and `anthropic-ratelimit-*` kept |
| proxy-side capacity | 529 | overloaded_error |
| upstream unreachable | 500 | api_error |
| upstream body already Anthropic-shaped | passthrough | as sent |
| upstream body in another shape | mapped by status | wrapped in the envelope |

## Figure kinds and units

Kinds: `window` (a quota window), `balance` (a remaining amount), `channel` (an availability door), `offer` (claimable items), `stats` (request counters). A kind a clauth does not know renders through `summary`. `chain` is valid on `window` only, one figure per role per account, and `window_secs` must equal the role's nominal length (18000 for `5h`, 604800 for `7d`).

Units are a closed set: `percent`, `tokens`, `requests`, `currency`, `custom` (with a required `unit_label`). A unit a clauth does not know renders verbatim as a suffix; `used`/`limit` stay unit-free so the bar draws.

## Versioning and capabilities

`contract` is `"MAJOR.MINOR"`. The major matches the `/clauth/v1` path, and a clauth refuses a foreign major. A minor only adds optional fields, figure kinds, units, account states, error codes, capabilities, and capability-gated routes. A clauth speaking 1.N works with any proxy on 1.M; `clauth proxy check` requires the field set of the minor the proxy declares.

## Settings form

Settings use clauth's own small form, one TUI row grammar per type: `bool` is a toggle, `enum` a cycle row, `int`/`number` with `step` a stepper, `int`/`number` without `step` and `string` a typed field. `label` is at most 14 chars for account scope and 17 for proxy scope. Every field declares `key`, `scope`, `label`, `hint`, `type` and `default`; an enum needs at least one option, and a non-null default must match the type (a `null` default marks the setting nullable). There is no secret type: a value readable over `GET` is never a credential. A field with `active_when` exists only while its key's value is in `in[]`; writing it while inactive answers 422 `invalid_setting`. `null` in a patch resets a key to its default.

## SSE events

`GET /clauth/v1/events` streams `event:` names `account`, `usage`, `login` and `account_deleted`; each `data:` is the same JSON object the matching GET returns. A comment line is sent at open and then every 15 s to keep the stream alive. `account` carries the account object, `usage` the usage-account object, `login` the login-status object (never an `inference_key`), and `account_deleted` carries `{"id": <id>}` — never an `account` event for a deletion.

## Adapter API

The core exports `defineProxy(adapter)` and `runCli`. A proxy's binary is `runCli(defineProxy(adapter))`; `manifest` prints the manifest JSON and touches no network or state, `serve` reads the env contract (`CLAUTH_PROXY_BIND` loopback-only, `CLAUTH_PROXY_STATE_DIR`, `CLAUTH_PROXY_ADMIN_TOKEN_FILE`) and serves until SIGTERM drains it.

The adapter is the provider-specific half; it owns only its manifest fields and the upstream calls. The core owns the HTTP surface, routing, the admin-token check, request caps, both error envelopes, the account store (hash-only keys, re-mint, re-bind, delete), the login flow state machine, the usage cache and polling cadence, settings validation, `/v1/messages` forwarding, the SSE `events` stream, and the lifecycle.

```ts
interface ProxyAdapter {
  manifest: {
    service: string;
    display_name: string;
    description?: string;
    version: string;
    capabilities: string[];
    drain_secs?: number;      // 0..3600
    figures: FigureDeclaration[];   // {id, kind, label, chain?}
    settings: SettingField[];       // the form above
    actions: DeclaredAction[];      // {name, label, scope, target?, confirm}
    usage_cadence_ms: number;       // how often the core polls figures
  };

  loginStart(ctx): Promise<{url, modes, poll_interval_ms, expires_at, upstream}>;
  loginPoll(ctx): Promise<
    | {state: "pending"}
    | {state: "done", identity, label, plans, blob}
    | {state: "failed", error: LoginFailedCode}>;
  loginPaste?(ctx): Promise<LoginPollResult>;   // only when modes includes "paste"
  loginCancel(ctx): Promise<void>;
  forward(ctx): Promise<Response>;              // streaming passthrough
  readFigures(ctx): Promise<unknown>;           // figures, validated by the core
  runAction(ctx): Promise<void>;                // outcome rides the figure
  dropLogin(ctx): Promise<void>;                // drop an upstream login (delete, or a late done after cancel)
}
```

The adapter receives and returns only its opaque upstream `blob`; the core persists the record and hashes keys. `loginPoll`/`loginPaste` return the upstream `identity` on `done`; on a re-bind the core compares it against the stored identity and refuses another upstream user with `identity_mismatch`. A `loginPoll` that throws is a transient upstream blip: the flow stays `pending`, the core logs it once per flow by its error class (never its message) and retries at the poll interval until `expires_at`; only an adapter-returned `{state:"failed"}` ends a flow as `failed`. A `readFigures` or `forward` failure throws `AdapterError("login_required" | "suspended" | "upstream_unavailable" | "rate_limited")` to mark the figure stale or flip the account state.

`forward`'s `ctx.request` already has the client's `x-api-key`, `authorization`, `host` and hop-by-hop headers removed, and the inference key is handed out exactly once — in the one answer that first observes a flow `done` (a GET, or the paste POST that completes it) — and never on an SSE event. `forward` returns a decoded body: the core strips `set-cookie`, `content-encoding`, `content-length` and every hop-by-hop header (`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `proxy-*`, `te`, `trailer`) from forwarded answers, so the adapter must return the body already decoded (Bun's `fetch` does). A login flow is garbage-collected 60 s after it ends (expiry keeps a 60 s grace before 404). The inference request body is capped at 32 MiB; a larger body answers 413 `request_too_large`, a malformed one 400 `invalid_request_error`.

`dropLogin`'s context carries `accountId` and `account` (both null when the login never became an account) plus `upstream`, the login blob to drop. On an account delete the account is present; on a late `done` that lands on a flow that did not finish `done` (cancelled, expired or failed, whether or not it was since collected) the core passes a null account and the done result's blob, so the upstream login the flow established is still dropped.

## Wire parity

Ship only once the proxy speaks the same wire as its upstream reference. Run the proxy and its reference client against one fixture upstream, compare the requests each sends (host, path, headers and their order, body fields), and open an issue on any difference. Development commits push freely; releases and the switch from whatever the proxy replaces wait for this run to come back identical.
