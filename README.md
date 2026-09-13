# sprout

**v0.2.0** — per-PR **preview databases** (and optional preview app containers)
for self-hosted deployments.

When a pull request opens, CI calls the sprout **gateway**, which
provisions an isolated **logical database** on a shared Postgres instance,
starts a preview app container, optionally runs a seed image, and tears
everything down when the PR closes. Lifecycle is **CI-driven** (`sprout
deploy` / `sprout teardown`) — the gateway does not take forge webhooks.

```
create DB → start app (migrate) → seed (optional) → running → drop
```

## How

Operator boot is zero-SQL on fresh Postgres: the gateway auto-provisions the
static preview login (`SPROUT_PG_USER`) from the admin DSN on startup. Sweep
is mixed-forge — one gateway lists open PRs/MRs across GitHub and GitLab by
inferring forge kind per canonical repo URL (`SPROUT_GITHUB_TOKEN` /
`SPROUT_GITLAB_TOKEN`, optional `SPROUT_FORGE_HOSTS` for self-managed GitLab).

## Why

Preview deployments often share one database with production or with each
other. Migrations in previews then mutate shared state. sprout gives
every PR its own database on a single shared Postgres — low overhead, full
data isolation per PR.

## Two roles

| Who | Job |
|---|---|
| **Operator** | Deploy Postgres + gateway + Traefik once ([compose stack](docs/deploy.md)). Issue deploy tokens. No manual `CREATE ROLE`; set per-forge sweep tokens as needed. |
| **Adopting repo** | Add `.sprout.yaml` + CI that builds images and runs `sprout deploy` / `sprout teardown` ([adoption guide](docs/adoption.md)). |

Each PR gets one logical database (`sprout_<slug>_pr<id>`) on the shared
Postgres — created on the first deploy attempt for that `(repo, pr)`, kept
across synchronize re-deploys, and dropped on teardown / operator drop /
sweep. Details: [adoption guide](docs/adoption.md), [CONTEXT](CONTEXT.md).

## Install the CLI

Prebuilt Linux x64 binaries (glibc + musl) ship on each
[GitHub release](https://github.com/simpros/sprout/releases). Asset names,
curl recipes, and Alpine `libstdc++` notes:
[Install from a release asset](docs/adoption.md#install-from-a-release-asset).

From a clone (`bun install`), run via `bun run sprout …` (same entry as the
published binary). Set `SPROUT_URL` (default `http://127.0.0.1:7331`).

## Commands

**Deploy token** (CI / adopting repo):

```bash
export SPROUT_TOKEN=<deploy-token>

sprout deploy -i ghcr.io/org/app:sha
sprout deploy -i ghcr.io/org/app:sha -s ghcr.io/org/app-seed:sha \
  --seed-env FIXTURE_SET=demo
sprout teardown
sprout health                        # GET /healthz (no token)
```

**Admin token** (operator — in-container `docker exec` uses admin env/file on
loopback; host CLI needs the token from logs / `SPROUT_ADMIN_TOKEN` — see
[docs/deploy.md](docs/deploy.md#bootstrap-admin-token)):

```bash
export SPROUT_TOKEN=<admin-token>

sprout list
sprout doctor
sprout drop <pr_id> --yes
sprout admin token create --scope deploy --repo https://github.com/org/repo
```

**Local worktree DB** (no gateway token — admin Postgres DSN with
`CREATEROLE` or superuser; see [docs/deploy.md](docs/deploy.md#worktree-db)):

```bash
sprout worktree-db provision --slug my-agent --env-file .env \
  --admin-url "$ADMIN_DSN"
sprout worktree-db drop --slug my-agent --admin-url "$ADMIN_DSN"
```

Canonical CI workflow:
[`examples/adopting-repo/.github/workflows/sprout.yml`](examples/adopting-repo/.github/workflows/sprout.yml).

## Operator quick start

```bash
cp compose.env.example compose.env
# Edit POSTGRES_PASSWORD, SPROUT_PREVIEW_POSTGRES_URL (keep in sync), SPROUT_PG_PASSWORD.

docker compose --env-file compose.env up -d --build
curl -sf http://127.0.0.1:7331/healthz
```

Full stack, gateway image build, Coolify/external Traefik overlay, and smoke
checklist: [`docs/deploy.md`](docs/deploy.md).

## Docs

- [`CONTEXT.md`](CONTEXT.md) — domain vocabulary
- [Spec #12](https://github.com/simpros/sprout/issues/12) — normative v0.1 specification
- [`docs/deploy.md`](docs/deploy.md) — operator compose stack + gateway image build
- [`docs/adoption.md`](docs/adoption.md) — adopting-repo guide (yaml, CI, entrypoint)
- [`examples/adopting-repo/`](examples/adopting-repo/) — copy-paste example files
- [`e2e/`](e2e/) — acceptance harness against compose (`bun run test:e2e`)
- [`docs/adr/`](docs/adr/) — architecture decisions

## Status

**v0.2.0 operator-magic** on this branch (package / image version `0.2.0`).
Gateway boot ensures `SPROUT_PG_USER` from the admin DSN; sweep selects forge
per repo (no gateway-wide `SPROUT_FORGE`). Milestone
[v0.2.0](https://github.com/simpros/sprout/milestone/1) tracks the slice.
