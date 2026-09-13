# Example adopting repo

Copy these files into your application repository and adjust names, registry
paths, and migrate/seed commands for your stack.

| File | Purpose |
|---|---|
| `.sprout.yaml` | Slug, hostname template, health check, seed block |
| `.gitlab-ci.yml` | One-include component flow (GitLab) |
| `.github/workflows/sprout.yml` | Symmetric deploy / teardown CI (GitHub) |
| `package.json` | Minimal scripts (`start`, `db:migrate`, `seed`) for the demo images |
| `Dockerfile` | App image with migrate-at-startup entrypoint |
| `Dockerfile.seed` | Optional one-shot seed image |
| `docker-entrypoint.sh` | Wait for DB → migrate → exec app |
| `docker-seed-entrypoint.sh` | Seed container entrypoint (`bun run seed`) |

See [docs/adoption.md](../../docs/adoption.md) for the full guide.
