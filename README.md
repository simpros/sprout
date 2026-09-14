# sprout

Per-PR **preview databases** and optional preview apps for self-hosted
deployments. CI calls the `sprout` CLI; the gateway provisions an isolated
logical DB, starts your app behind Traefik, optionally seeds data, and tears
everything down when the PR closes.

```text
  PR opened / push          PR closed
       │                        │
       ▼                        ▼
  sprout deploy ──► gateway ──► sprout teardown
       │                        │
       ├─ CREATE DATABASE       ├─ stop containers
       ├─ start app (+ Traefik) └─ DROP DATABASE
       └─ optional seed image
              │
              ▼
     https://pr-{id}.your.app
```

## Quickstart

**Operator** — deploy the gateway once ([full guide](docs/deploy.md)):

```bash
cp compose.env.example compose.env   # set passwords / DSNs
docker compose --env-file compose.env up -d --build
curl -sf http://127.0.0.1:7331/healthz
```

**Adopter** — add config + a CI step ([full guide](docs/adoption.md)):

```yaml
# .sprout.yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
```

```yaml
# GitHub Actions (secrets: SPROUT_URL, SPROUT_TOKEN)
- run: sprout deploy -i "$APP_IMAGE"   # + optional -s "$SEED_IMAGE"
# on PR close:
- run: sprout teardown
```

Copy-paste files: [`examples/adopting-repo/README.md`](examples/adopting-repo/README.md).
GitLab: published `preview` component — see [adoption guide](docs/adoption.md)
(issue [#127](https://github.com/simpros/sprout/issues/127)).

## Features

| | |
|---|---|
| **Per-PR isolated DB** | Logical database `sprout_<slug>_pr<id>` on one shared Postgres |
| **App + Traefik** | Preview containers with Host routing; works beside Coolify Traefik |
| **Seed images** | Optional one-shot seed after the app is healthy |
| **Sweep / reconcile** | Gateway corrects drift when CI teardown is missed |
| **Deploy + admin tokens** | CI deploy tokens scoped by repo; admin tokens for operators |

## Example

```yaml
# .sprout.yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
```

```bash
export SPROUT_URL=https://sprout.example.com
export SPROUT_TOKEN=<deploy-token>
sprout deploy -i registry.example.com/myapp:$SHA -s registry.example.com/myapp:$SHA-seed
# …later…
sprout teardown
```

## Docs

- **[Public docs](https://simpros.github.io/sprout/)** — how it works, CLI reference, config, FAQ  
  ([source](docs/site/index.html) · local preview: `bun run docs:preview`)
- [Adoption guide](docs/adoption.md) — `.sprout.yaml`, CI, entrypoints
- [Operator deploy](docs/deploy.md) — compose stack, env, Traefik
- [`examples/adopting-repo/README.md`](examples/adopting-repo/README.md) — copy-paste starter
- [`CONTEXT.md`](CONTEXT.md) — domain vocabulary
- [`docs/adr/README.md`](docs/adr/README.md) — architecture decisions
- [`e2e/README.md`](e2e/README.md) — acceptance harness (`bun run test:e2e`)

## Develop

```bash
bun install
bun run dev          # gateway watch
bun test
bun run build        # typecheck + docs links
```

## License

AGPL-3.0-only — see [LICENSE](LICENSE).
