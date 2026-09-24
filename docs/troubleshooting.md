# Troubleshooting

The error catalogue for adopting repos and operators. Every entry names the
exact error. None of these print env values — parse errors name the key or
file without echoing the value.

- Manifest keys? See [Adopting a repo](adopting-a-repo.md).
- Lifecycle background? See [Previews](previews.md).
- Gateway setup? See [Operator deploy](operator-deploy.md).
- Commands? See [CLI reference](cli-reference.md).

## Adopter errors

| Symptom | Error (stderr) | Fix |
|---|---|---|
| Job runs on a branch pipeline, not an MR | `sprout ci refuses detached/non-MR pipelines (CI_PIPELINE_SOURCE=…); run from a merge-request pipeline` (GitHub: `GITHUB_EVENT_NAME=…`) | Gate the jobs on `$CI_MERGE_REQUEST_IID` (the component does this) or run from a `pull_request` workflow. Running both forges' claims at once is refused as ambiguous. |
| Registry/SHA missing so the image tag cannot be built | `cannot derive image ref (set CI_REGISTRY_IMAGE and CI_COMMIT_SHA)` | Run on a runner with the container registry enabled; on GitLab the component logs in with `CI_REGISTRY_USER`/`CI_REGISTRY_PASSWORD` automatically. |
| Remote include without a version | `sprout_version input is empty/unpinned (remote includes must set sprout_version explicitly …)` | Set `sprout_version` to the tag in the `remote:` URL. Component includes pin it automatically. |
| Downloaded release fails verification | `checksum entry missing for <asset> in <tag>/SHA256SUMS.txt …` or a `sha256sum -c` mismatch; `test "$(sprout --version)" = "…"` fails | Pin to a release that ships checksums (≥ the release that publishes `SHA256SUMS.txt`); do not hand-edit the install — the component verifies the downloaded asset. |
| Hostname template rejected | `preview.hostname … must contain {pr_id}` / scheme/port/path/placeholder errors; service `preview.services[i].hostname` / `.path must start with /` | Keep the template a bare host with `{pr_id}` (`pr-{pr_id}.app.example.com`). Read the URL from `preview_url=` / `PREVIEW_URL` — never reconstruct it in CI. |
| Unknown manifest key | `unknown key: <path>` (top-level, `preview.*`, `health.*`, `seed.*`, `preview.env.*`) | Rename to a key in the [manifest table](adopting-a-repo.md#manifest-keys-sproutyaml); check `preview.env` against the canonical `PG*` set and services against `name/image/hostname/path/port/env/labels`. |
| Seed configured without health | `health block required in .sprout.yaml when seed block is configured` (or `when -s is passed`) | Add the `health:` block (quickstart snippet). The gate runs before any `docker build`. |
| Secret not supplied | deploy fails before the gateway call naming the key (declared `{ required: true }`, no file/flag provided it) | Provide it via the `SPROUT_APP_ENV` / `SPROUT_SEED_ENV` file-type variable or `--app-env[-file]` / `--seed-env[-file]`. Never commit the secret to the manifest. |
| File-type CI variable passed via `app_env_file` / `seed_env_file` input (e.g. `inputs: { app_env_file: $MY_ENV_FILE }`) | `preview.app_env.<KEY>: required value missing` (nothing points at the input) — had the flag been passed with a bad path, the CLI would say `cannot read --app-env-file: <path>` instead | Repo-relative dotenv paths only — never pass File vars via `inputs:`; map the blob at job runtime via `variables:` (`sprout-preview: { variables: { SPROUT_APP_ENV: $MY_ENV_FILE } }`, seed: `SPROUT_SEED_ENV: $MY_SEED_FILE`). Full diagnostic in [component Troubleshooting](../templates/README.md#troubleshooting). |
| Invalid dotenv line or flag | names the offending key or file, value never echoed | Fix the `KEY=value` line (blank lines, `#` comments, optional `export ` prefix; values may contain `=`); check `--tail` is a positive integer (`--tail must be a positive integer`). |
| Deploy never becomes healthy | `health_timeout` (gateway log tail printed first), `deploy_timeout` on poll expiry | Pull `sprout logs <mr_id> --tail 200`: app crash-loop (migrations, missing env, wrong port) is the usual cause. Reviewers may see brief 502s while the app migrates — Traefik routes exist before the app is healthy. |
| Seed fails | `seed_failed` (exit code or `timeout` in `last_error_detail`); app **stays up** and routable, `seeded_at` unset | Fix the seed image and redeploy with `-s` (resume path — no Traefik replace when image + hostname are unchanged). Seed wall-clock is `SPROUT_SEED_TIMEOUT` (default `180s`); health timeout is separate and never starts the seed. |
| Redeploy after a failed seed without `-s` | `422 seed_image_required_to_resume_seeding` | Redeploy with `-s` (resume needs the seed image); `--reseed` is not required for first-seed failure resume. Tear down only for a fresh database, not fresh fixtures. |
| Synchronize deploy skips seeding | no error; incoming seed image matches the last successful one | Pass `--reseed` with `-s` (or `sprout ci reseed -s …`) to force a re-seed against the existing database. A failed reseed clears `seeded_at` and keeps the app up, leaving the stored seed image unchanged so the next deploy retries. |
| Seed inputs changed but fixtures look stale | job log shows a new `seed-<shorthash>` tag built, yet no seed run | The gateway re-runs the seed automatically when the incoming seed image differs from the last successful one — no `--reseed` needed. If fixtures still look stale, check the seed job logs (`sprout ci logs`) for a `seed_failed` outcome. See [After-healthy hook](previews.md#after-healthy-hook-seed-image). |
| `sprout ci reseed` without an image | `ci reseed requires -s <seed-image>` | Pass `-s` with the seed image; reseed runs against the existing database without rebuilding. |
| `seed:` block with `db.provider: none` | `seed requires db.provider postgres or sqlite (db.provider is none)` (manifest parse and `422 seed_requires_database` at the deploy route) | Remove the `seed:` block — a no-database preview has nothing to seed. If the app needs fixtures, it is not a `none` repo; use `postgres` or `sqlite`. |
| `-s` / `--reseed` / `sprout ci reseed -s …` on a `none` repo | `seed requires db.provider postgres or sqlite (db.provider is none)` (`422 seed_requires_database` from the gateway) | Drop the seed flags — there is no database to re-seed. The CLI fails before any network call; the gateway agrees on the message. |
| `preview.env` database key with `db.provider: none` | `preview.env.<KEY> requires db.provider <postgres\|sqlite>` (manifest parse and `422 invalid_env_for_provider` at the deploy route) | Remove the entry — `none` previews inject no connection env. Keep only `preview.app_env` / `--app-env` for non-connection values. Mail (`MAIL*`) remaps are allowed on every provider, including `none`. |
| `mail: enabled` on a gateway without mail | `mail_not_configured: repo <repo> declares mail enabled but the gateway has no mail configured: missing SPROUT_MAIL_HOST` | Ask the operator to configure `SPROUT_MAIL_*` (see [Operator deploy](operator-deploy.md#preview-mail-mailpit)), or omit the `mail:` block (opportunistic), or set `mail: none` to opt out. |
| Mail never arrives | no error; the message is missing from the inbox | Check the app reads the injected names (`MAILHOST`/`MAILPORT`, or the `preview.env` remap targets) and that the Mailpit host is reachable on the preview network — the operator may need `SPROUT_MAIL_NETWORK` so preview containers join Mailpit's network. |
| App logs `connection refused` on SMTP after the operator moved Mailpit | connection errors in `sprout ci logs` | The Mailpit hostname or network changed — the operator updates `SPROUT_MAIL_HOST` / `SPROUT_MAIL_NETWORK` and redeploys. Nothing in `.sprout.yaml` needs to change. |
| Messages from another PR are visible in the inbox | no error | Expected — one gateway shares one mailbox. Filter by the preview's From address (`- Mail from:` line in the MR note). Per-preview isolation means a second Mailpit + gateway. |
| Truncated GitLab MR description, no reset box visible (`sprout ci preview` and `sprout ci reset`) | no error; stderr carries `warning: GitLab MR description is truncated — reset request not readable, skipping` | Paste the [reset-request snippet](ci-integration.md#reset-request-checkbox) at the top of the MR description and retry the job. The preview still deploys (`ci reset` still tears down and redeploys); exit 0. |
| Truncated GitLab MR description with a ticked reset box but no marker (`sprout ci preview` and `sprout ci reset`) | deploy runs first (`ci reset`: teardown + deploy), then the job fails with `GitLab MR description is truncated (CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED=true); move the '- [ ] Sprout: reset preview' checkbox and the '<!-- sprout-reset: <token> -->' marker into the first 2700 characters so the reset request is visible` | Paste the [reset-request snippet](ci-integration.md#reset-request-checkbox) at the top of the MR description and retry the job. The tick is never silently ignored. |
| Ticked box does not reset a second time | no error; the run deploys normally | The marker was already handled (exactly-once key on the preview row). To reset again, tick the box **and** rotate the marker token to something new. A hand-run `sprout ci reset` also consumes the pending request, so the next push does not wipe again. |
| Reset on a `db.provider: none` or `sqlite` preview | no error; the reset redeploys but there is no Postgres database to wipe | Expected: `none` redeploys containers only (no database step); `sqlite` drops and recreates the named per-preview volume instead of `DROP DATABASE`. Migrations/seed re-run as usual. |
| Reset while another deploy is in flight | `409 preview_deploy_in_progress` (or `preview_teardown_in_progress`) | Wait for the current run to settle, then retry. GitHub runs serialize per PR via the workflow concurrency group; on GitLab avoid running `sprout-preview` and `sprout-reset` at the same time. |

## Operator errors

| Symptom | Likely cause | What to try |
|---|---|---|
| `curl …/healthz` fails / connection refused | Gateway not up, or host port conflict on `SPROUT_GATEWAY_HOST_PORT` | `docker compose --env-file compose.env ps`; `ss -ltnp | grep 7331` (or your host port); check `docker compose … logs gateway` |
| Traefik curl on `:8880` fails | Bundled Traefik not published, or `TRAEFIK_HTTP_PORT` overridden | Confirm `TRAEFIK_HTTP_PORT` in `compose.env`; `docker compose … ps traefik` |
| `network … not found` on external overlay | `SPROUT_*_NETWORK` names do not exist on the host | `docker network ls`; `docker network create "$SPROUT_TRAEFIK_NETWORK"` (and postgres) before `up` |
| Gateway boot: missing env / CREATEROLE | Required vars blank, or admin DSN lacks role privileges | Diff `compose.env` against `compose.env.example`; confirm admin can `CREATE ROLE` |
| Preview apps unreachable behind Coolify Traefik | Wrong Traefik network, TLS entrypoints, or labels | Confirm gateway + apps join Coolify's Traefik network; set `SPROUT_TRAEFIK_ENTRYPOINTS` / `CERTRESOLVER` to that proxy's names |
| Admin SQL works but gateway cannot | `POSTGRES_PASSWORD` vs DSN password drift | Re-sync both spellings in `compose.env` and recreate gateway |

## See also

- [Getting started](getting-started.md) — first preview
- [Adopting a repo](adopting-a-repo.md) — manifest reference
- [CI integration](ci-integration.md) — reset, notes
- [Previews](previews.md) — lifecycle
- [Operator deploy](operator-deploy.md) — gateway stack
- [CLI reference](cli-reference.md) — commands
