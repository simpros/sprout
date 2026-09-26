# CLI reference

The `sprout` CLI talks to the gateway API. Auth: set `SPROUT_URL` and
`SPROUT_TOKEN` (except `health`). Install a release binary (glibc:
`sprout-linux-x64`; Alpine: `sprout-linux-x64-musl`) or run from this
monorepo via `bun run --cwd apps/cli`. Full flags per command:
`sprout <command> --help`.

- First preview? See [Getting started](getting-started.md).
- CI wiring? See [CI integration](ci-integration.md).
- Manifest keys? See [Adopting a repo](adopting-a-repo.md).

## Commands

| Command | Purpose |
|---|---|
| `sprout deploy -i <image> [-s <seed>]` | Create or synchronize a preview (DB + app; optional seed / services). |
| `sprout teardown` | Remove the current PR's preview (idempotent). |
| `sprout drop <pr_id> [--yes]` | Operator drop of a specific PR preview (confirmation unless `--yes`). |
| `sprout list` | List registered previews (JSON). |
| `sprout health` | Hit gateway `/healthz` (no token). |
| `sprout doctor` | Gateway self-check (networks, Postgres, forge, drift). |
| `sprout logs <pr_id>` | Fetch preview container logs for debugging. |
| `sprout admin token …` | Create / list / revoke deploy tokens (admin token required). |
| `sprout ci <preview\|teardown\|reseed\|reset\|logs>` | CI helper: build/push/deploy, teardown, reseed (data kept) or reset (data wiped), or logs from CI env. |
| `sprout worktree-db <provision\|drop>` | Local per-worktree Postgres DB (no gateway). |

Identity (repo + PR id) is inferred from CI env or git remote; override with
`--repo` where supported.

## `ci` commands

`usage: sprout ci <preview|teardown|reseed|reset|logs> …` — repo, MR id, and
pipeline source are inferred from CI env (`CI_PROJECT_URL` /
`CI_MERGE_REQUEST_IID` / `CI_PIPELINE_SOURCE` on GitLab;
`GITHUB_REPOSITORY` + event payload on GitHub). Identity resolves before
auth so outside-pipeline errors win over missing-token.

| Command | Flags | Purpose |
|---|---|---|
| `sprout ci preview` | `--app-env KEY=VALUE` (repeat) | One-off app env (highest precedence). |
| | `--app-env-file PATH` (repeat) | Explicit dotenv file(s) for the app, on top of `SPROUT_APP_ENV`. |
| | `--seed-env KEY=VALUE` (repeat) | One-off seed env. |
| | `--seed-env-file PATH` (repeat) | Explicit dotenv file(s) for the seed, on top of `SPROUT_SEED_ENV`. |
| | `--seed-arg ARG` (repeat) | Extra seed container args (appended after yaml `seed.args`; values may start with `-`). |
| | `--service name=image` (repeat) | Create/refresh companion services (see [Previews](previews.md#multi-image-previews-app--services)). |
| | `--clear-services` | Remove all companions (`services: []` on the API). Cannot combine with `--service`. |
| | `--tail N` | Gateway log lines printed when the deploy fails (default `200`; must be a positive integer, checked before building). |
| | `--dotenv-file PATH` | Dotenv artifact the CLI writes `PREVIEW_URL=` to (default `sprout-preview.env`, relative to the workspace root). Emitted only once the preview is healthy. |
| | `--reseed` | Force the gateway to re-run the seed against the existing database (requires a `seed` block) — re-seeds even when the seed image is unchanged. A changed seed image already re-seeds automatically; without seed changes, omit it — a reused image still seeds every fresh PR (`seeded_at` unset). |
| `sprout ci teardown` | *(no flags — extra args are rejected)* | Tear down this MR's preview. Idempotent; rewrites the MR note in place ("preview was removed"). Note failures only warn so gateway success owns the exit code. |
| `sprout ci reseed` | `-s <seed-image>` (required) | Re-run the seed job against the existing database (data kept; no image build; app tag from `CI_REGISTRY_IMAGE` + SHA). Body is a reseed request, so companions stay as last deployed by construction. |
| | `--seed-env`, `--seed-env-file`, `--seed-arg`, `--app-env`, `--app-env-file` | Same env layering as `preview` (yaml + blob + files + flags). |
| `sprout ci reset` | `--tail N`, `--dotenv-file PATH`, `--app-env[-file]`, `--seed-env[-file]`, `--seed-arg`, `--service`, `--clear-services` (same deploy flags as `preview`, no `--reseed`) | Wipe the preview database and any `preview.volumes` data volumes, then redeploy + seed from scratch (data wiped; no rebuild — reuses the already pushed images for the commit). The note gains a `Reset: <actor> at <utc>` line. The component's `sprout-reset` manual job and a ticked reset-request checkbox both funnel here. |
| `sprout ci logs` | `--tail N` | Preview container logs through the gateway (app, then seed when available). |

On success `sprout ci preview` prints `preview_url=` to stdout (and writes
the dotenv file); on failure it prints the gateway log tail first, then the
deploy error exits non-zero. The MR note is best-effort in both directions
(forge failures warn with the forge's error body, never the token).

Low-level equivalents (`sprout deploy -i … -s …`, `sprout teardown`,
`sprout logs`) still work for GitHub Actions and laptops — see
[CI integration](ci-integration.md#github-actions). Their env/seed/service flags mirror the `ci`
surface (`-i`, `-s`, `--reseed`, `--service`, `--clear-services`,
`--app-env[-file]`, `--seed-env[-file]`, `--seed-arg`).

## Debugging

Low-level flow: when a preview is red, pull container logs through the gateway (no Docker
socket on the CI runner or laptop):

```bash
export SPROUT_URL=https://sprout.example.com
export SPROUT_TOKEN=<deploy-token>   # or admin token locally
sprout logs <pr_id> --tail 200
# optional when not in CI / not at a git remote:
# sprout logs <pr_id> --tail 200 --repo "https://github.com/org/repo"
```

Repo resolution matches `deploy` / `drop`: `--repo`, else `GITHUB_REPOSITORY` /
`CI_PROJECT_URL`, else `git remote get-url origin`. The deploy token is scoped
to one canonical repo — it cannot read another repo's previews.

Output is live app container logs, then seed logs when available. While the
seed container is still running, `sprout logs` reads it live; after a failed
seed the gateway has already captured stdout/stderr into `seed_log` (before
remove) so the seed section still shows why seeding died. Status polling keeps
a short `last_error_detail` (`exit=7`, `timeout`) — not the log blob.
Successful seeds do not keep seed output.

## Deploy token setup

One-time per adopting repo (operator or lead dev with admin token):

```bash
export SPROUT_URL=https://sprout.example.com
export SPROUT_TOKEN=<admin-token>
sprout admin token create \
  --scope deploy \
  --repo "https://github.com/org/repo"
```

Add the returned token to the repo's `SPROUT_TOKEN` secret. Never invent,
echo, or commit a token value.

## Worktree DB (local provisioner)

Parallel agents on one machine can clash on shared Postgres credentials. The
CLI provisions an isolated DB + LOGIN role per worktree **without** talking
to the gateway (operator detail; full notes in
[Operator deploy](operator-deploy.md#worktree-db-local-provisioner)):

```bash
sprout worktree-db provision --slug <name> --env-file <path> --admin-url "$ADMIN_DSN"
sprout worktree-db drop --slug <name> --admin-url "$ADMIN_DSN"
```

## Test coverage (maintainers)

Repo-relative paths for the reference contract above:

- Manifest parsing (all `.sprout.yaml` keys, including `preview.env` remap,
  `app_env` / `seed.env` grammar, services, health, `build`/`seed` blocks):
  `apps/cli/src/yaml.test.ts`
- Env value grammar (placeholders, `generate`, `required`):
  `apps/cli/src/app-env.test.ts`, `apps/cli/src/app-env-values.test.ts`
- CLI env layering (yaml + blob + files + flags):
  `apps/cli/src/commands/deploy-env.test.ts` (CLI side),
  `apps/server/src/http/deploy-env.test.ts` (gateway side)
- `sprout ci preview` (builds, seed content-hash + reuse gate, `--reseed`,
  service flags, seed env/args, tail, dotenv, health gate):
  `apps/cli/src/commands/ci-preview.test.ts`,
  `apps/cli/src/commands/seed-image.test.ts`
- `sprout ci` identity (both forges, detached/non-MR refusal):
  `apps/cli/src/commands/ci.test.ts`,
  `apps/cli/src/commands/ci-identity.test.ts`
- `teardown` / `reseed` / `logs`:
  `apps/cli/src/commands/ci-teardown-reseed-logs.test.ts`
- MR note wiring (best-effort, forge error body, no token leak):
  `apps/cli/src/commands/ci-note-wiring.test.ts`,
  `apps/cli/src/commands/forge-note.test.ts`
- Low-level `deploy` / services leave-clear-replace:
  `apps/cli/src/commands/deploy.test.ts`,
  `apps/cli/src/services.test.ts` (CLI shape),
  `apps/server/src/app-deployment/services.test.ts` (gateway shape)
- Gateway connection env (remap replaces names, colliding adopter keys
  stripped): `apps/server/src/app-deployment/pg-env.test.ts`
- Preview mail (manifest `mail:` / `mail.from` parse):
  `apps/cli/src/yaml-mail.test.ts`, `packages/preview-env/src/mail.test.ts`
- Mail env assembly (canonical keys, remap, reservation, `mail: none`,
  `mail_not_configured`): `apps/server/src/app-deployment/mail-env.test.ts`,
  `apps/server/src/preview/runtime.mail.test.ts`,
  `apps/server/src/http/deploy-mail.test.ts`
- Mailbox / From presentation (MR note lines, settled deploy output):
  `apps/cli/src/commands/forge-note.test.ts`
- Send-and-read-back through Mailpit's API: `e2e/mail.test.ts`
- Substituted hostname on a live deploy: `e2e/lifecycle.test.ts`
- Component inputs / dotenv / `on_stop` wiring: `templates/preview.test.ts`

## See also

- [Getting started](getting-started.md) — first preview
- [Adopting a repo](adopting-a-repo.md) — manifest reference
- [CI integration](ci-integration.md) — both forges
- [Previews](previews.md) — lifecycle
- [Operator deploy](operator-deploy.md) — gateway stack
- [Troubleshooting](troubleshooting.md) — error catalogue
