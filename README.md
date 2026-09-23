# sprout

Every pull request gets its own preview: an isolated database on one shared
instance plus an optional live app, for teams that review running code instead
of diffs. Self-hosted, no platform lock-in — everything is torn down when the
PR closes.

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
     preview URL for this PR
```

## Adopt in three files

`.sprout.yaml`, a CI include, and the `Dockerfile` your app already ships —
plus two CI variables from your operator. Humans:
[Getting started](docs/getting-started.md). Agents: paste the
[Onboarding prompt](docs/onboarding-prompt.md) into your coding harness and it
wires the repo for you. Live pitch:
[the marketing page](https://simpros.github.io/sprout/).

## Docs

- **[Public docs](https://simpros.github.io/sprout/docs/index.html)** — concept, guides, reference
  ([source](docs/site/index.html) · [llms.txt](llms.txt))
- [Getting started](docs/getting-started.md) — first preview
- [Adopting a repo](docs/adopting-a-repo.md) — `.sprout.yaml` manifest reference
- [CI integration](docs/ci-integration.md) — GitHub / GitLab wiring, reset
- [Previews](docs/previews.md) — databases, seeding, services, mail
- [Operator deploy](docs/operator-deploy.md) — compose stack, env, Traefik
- [CLI reference](docs/cli-reference.md) — every command
- [Troubleshooting](docs/troubleshooting.md) — error catalogue
- [Onboarding prompt](docs/onboarding-prompt.md) — paste into a coding harness
- [`examples/adopting-repo/README.md`](examples/adopting-repo/README.md) — copy-paste starter
- [`CONTEXT.md`](CONTEXT.md) — domain vocabulary
- [`e2e/README.md`](e2e/README.md) — acceptance harness (`bun run test:e2e`)

## Develop

```bash
bun install
bun test
bun run typecheck   # turbo build + docs links
```

## License

AGPL-3.0-only — see [LICENSE](LICENSE).
