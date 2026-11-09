# Telemetry

Every gateway built as the published image reports anonymous installation
facts and deploy outcomes to a maintainer-run ingest endpoint. Reporting is
on by default and stops with one variable. A build from source reports
nothing until the two destination variables are set.

```bash
SPROUT_TELEMETRY=off  # or DO_NOT_TRACK=1 — either one stops all reporting
```

## What is sent

Two events share one fixed envelope:

| Field | Meaning |
|---|---|
| `event` | `install` or `deploy` |
| `install_id` | Random UUID identifying this installation (see below) |
| `sprout_version` | Gateway version, read from `package.json` at boot |
| `runtime` | Gateway runtime, e.g. `bun 1.4.0` |
| `platform` | OS/arch, e.g. `linux/x64` |
| `db_provider` | `postgres` or `sqlite`, whichever the gateway runs |
| `capabilities` | Subset of `mail`, `tls`, `forwardauth`, `volumes`, `services`, `gitlab`, `custom_forge_hosts` |
| `_timestamp` | ISO 8601 event time |

`install` fires on boot and every 24h. It adds row counts from the local
state database:

```json
{
  "event": "install",
  "install_id": "3f9d7a1e-8b2c-4d5e-9f01-23456789abcd",
  "sprout_version": "0.9.1",
  "runtime": "bun 1.4.0",
  "platform": "linux/x64",
  "db_provider": "sqlite",
  "capabilities": ["volumes", "services"],
  "previews_total": 4,
  "deploys_total": 2,
  "_timestamp": "2026-09-30T12:00:00.000Z"
}
```

`deploy` fires once per terminal deploy outcome. It adds the outcome, the
bring-up plan, whether the preview ended seeded, and measured timings
(`phase_ms` carries only the phases that ran):

```json
{
  "event": "deploy",
  "install_id": "3f9d7a1e-8b2c-4d5e-9f01-23456789abcd",
  "sprout_version": "0.9.1",
  "runtime": "bun 1.4.0",
  "platform": "linux/x64",
  "db_provider": "postgres",
  "capabilities": ["mail", "tls", "volumes", "services", "gitlab"],
  "outcome": "running",
  "plan": "full_replace",
  "seeded": true,
  "duration_ms": 48210,
  "phase_ms": { "db": 210, "app": 31200, "seed": 16800 },
  "_timestamp": "2026-09-30T12:05:11.000Z"
}
```

A failed deploy adds the stored error code and failure family. `unknown`
means the row never recorded a code:

```json
{
  "event": "deploy",
  "install_id": "3f9d7a1e-8b2c-4d5e-9f01-23456789abcd",
  "sprout_version": "0.9.1",
  "runtime": "bun 1.4.0",
  "platform": "linux/x64",
  "db_provider": "postgres",
  "capabilities": ["mail", "tls", "volumes", "services", "gitlab"],
  "outcome": "failed",
  "plan": "seed_resume",
  "seeded": false,
  "duration_ms": 9650,
  "phase_ms": { "app": 9400 },
  "failure_class": "seed_failed",
  "failure_family": "seed_incomplete",
  "_timestamp": "2026-09-30T12:09:41.000Z"
}
```

Transport costs one `POST` per event with a 3s timeout, fire-and-forget. A
failed export never changes a deploy outcome — at most one warning is
logged. There are no retries, no queue, and no batching: losing an
anonymous event is acceptable, changing a deploy's outcome is not. That is
the whole cost: one small JSON post per deploy, plus an install
heartbeat at boot and every 24h, with no
effect on the request path when the backend is slow or dead.

## What is never sent

Repo id, URL or name; PR id; slug; preview name; hostname; database name;
image reference; container id; DSN; any credential; any value from
`appEnv`, the injected preview env, or the manifest; request or response
headers and bodies; error detail text; stack traces; log lines. The payload
is assembled from a fixed field list in one module — the only free values
that travel are the closed vocabularies `lastError`, `failureFamily` and
`plan`. This closed list is why the channel is safe to leave on: nothing
the adopter types into config, env, or code can reach the payload.

## Stopping it and forgetting

- `SPROUT_TELEMETRY=off` stops it (`on`/`off`, `1`/`0`, `true`/`false`,
  `yes`/`no`, case-insensitive). Anything else fails boot.
- `DO_NOT_TRACK=1` stops it too. The boot line names which switch is in
  force: `off (SPROUT_TELEMETRY)` or `off (DO_NOT_TRACK)`.
- The install identity is a random UUID in `<state dir>/install-id`
  (`/data/install-id` in the compose stack), created on the first send.
  Deleting the file ends that identity — the next send mints a new one.

## Where the data goes

The destination pair `SPROUT_TELEMETRY_ENDPOINT` /
`SPROUT_TELEMETRY_AUTH` arrives as ordinary process env. Both set means
reporting is active; exactly one set fails boot; neither set means nothing
is sent (`on (no destination)` — the usual case for a from-source build).

The published image carries the maintainer destination baked in at image
build time (`ARG` → `ENV` in the `Dockerfile`, supplied by the release
workflow). That value is therefore visible in `docker inspect` for anyone
pulling the image — by construction, so the credential is ingest-only for
a single stream and the collector treats every record as untrusted input.
Setting the two variables at runtime overrides what the image carries, so a
fork or a company can redirect reporting without rebuilding.

This anonymous upstream channel is separate from `SPROUT_OTLP_*`, the
opt-in trace backend an operator points at their own collector (below).

## Your own trace backend

Point the gateway at any OTLP/HTTP traces backend you run (a collector,
Tempo, Jaeger, OpenObserve — anything speaking OTLP/HTTP) and deploys show
up there as distributed traces. Nothing is exported unless the endpoint is
set; the image carries no trace destination.

```bash
SPROUT_OTLP_ENDPOINT=https://<openobserve-host>/api/<org>/v1/traces
SPROUT_OTLP_HEADERS=Authorization=Basic <base64 email:password>,stream-name=default
```

- `SPROUT_OTLP_ENDPOINT` is the OTLP/HTTP **traces** URL, used verbatim as
  the exporter's `url`. It must be an absolute `http(s)` URL or boot fails
  naming the variable. The signal path is part of the URL: an OpenObserve
  base such as `/api/<org>` without `/v1/traces` answers `403`, so keep the
  full traces path. `stream-name=<stream>` is an optional extra header, not
  part of the URL.
- `SPROUT_OTLP_HEADERS` is comma-separated `name=value` pairs sent verbatim
  on every export request. Each entry splits on the first `=` only, so a
  base64 `Authorization` value keeps its padding. An entry without `=`, or
  with an empty name, fails boot naming the entry.
- Tracing is active exactly when the endpoint is set. With no endpoint
  there is no SDK, no export, and no boot failure — the boot line reports
  `traces: "off"`, otherwise `traces: "<host>/<path>"`. Header values never
  appear in the boot line or the config summary (`otlpHeaders` is
  `"[set]"` / `"[empty]"`).

What is exported: one server span per inbound request (renamed
`<METHOD> <path>`, `/healthz` excluded so the compose healthcheck does not
fill the backend), and one `preview.deploy` root trace per deploy attempt
with `preview.db` (database provision/reset), `preview.app` (container
replace plus health gate), and `preview.seed` (seed image run) children. The
deploy is detached from the request that accepted it, so it is its own root
trace correlated by attributes, not by trace id. Deploy attributes are
`sprout.repo`, `sprout.pr`, `sprout.slug`, `sprout.plan`, and
`sprout.status`; failures set status `ERROR` and record the exception.
Export uses a batch processor, never the request path, with no signal
handling — a slow or dead backend cannot block or crash the gateway.

Privacy: the operator's own values go to the operator's own backend — and
still never `appEnv`, DSNs, tokens, request or response bodies, headers, or
cookies, because a trace backend is a second copy of whatever ends up in it.
