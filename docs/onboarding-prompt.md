# Onboarding prompt

One copy-paste block. Paste it into your coding harness (Claude Code, Cursor,
Codex, …) in the repo you want to preview. The agent reads the docs itself,
inspects your repo, confirms the domain-shaped values, and writes only the
config + CI wiring.

---

```text
You are onboarding this repository to sprout (every pull request gets its own
preview database plus an optional preview app).

Step 1 — read the docs first, in this order.
1. https://simpros.github.io/sprout/llms.txt — the index of every doc page.
2. https://simpros.github.io/sprout/docs/adopting-a-repo.md — the
   `.sprout.yaml` manifest reference.
3. https://simpros.github.io/sprout/docs/ci-integration.md — CI wiring for
   this forge (GitLab component or GitHub reusable workflow).
Fetch each URL; do not rely on memory of this product.

Step 2 — inspect the repo before writing anything. Runtime and package
manager, the Dockerfile(s), how migrations run, whether fixtures/seed data
exist, which forge hosts it, and the existing CI workflow files. State what
you found in one short paragraph.

Step 3 — derive, then confirm. Propose `slug` and the preview hostname
template (must contain `{pr_id}`, bare host, no scheme/port/path) from the
repo name and its existing deploy conventions, and ask me to confirm both
before you write them. Never invent a domain or a hostname pattern.

Step 4 — write only these files.
- `.sprout.yaml` — the minimal working config: `slug`, `preview.hostname`,
  plus `health` and `seed`/`db`/`services`/`mail` only where this repo
  actually needs them. Match the manifest keys exactly
  (`unknown key: <path>` rejects typos).
- `Dockerfile.seed` — only if preview data is wanted and no seed image
  exists yet.
- The CI file for this forge: the GitLab one-include component
  (`templates/preview.yml` shape, `sprout_version` pinned) or the GitHub
  caller workflow (`examples/adopting-repo/.github/workflows/sprout.yml`
  shape, `sprout_version` pinned, `contents: read` + `pull-requests: write`
  + `packages: write`).

Step 5 — tell me the CI variables to set myself (names, masked/secret,
where they go): `SPROUT_URL` (gateway URL), `SPROUT_TOKEN` (deploy token
scoped to this repo), optional `SPROUT_APP_ENV` / `SPROUT_SEED_ENV` dotenv
blobs and `GITLAB_TOKEN` for MR notes. Do not create, print, commit or
guess their values. If you cannot find a required value, ask me. Never
deploy against an unverified gateway URL without asking.

Step 6 — verify what you can without a running gateway: run the CLI's own
manifest loader over the file you wrote (`apps/cli/src/yaml.ts`
`parseSproutYaml`) and paste the result. Then name my next step
(`sprout doctor`, then a first `sprout ci preview` run from CI).

Do not:
- rewrite or refactor application code,
- touch files other than the ones in Step 4,
- invent operator-side settings (`SPROUT_PREVIEW_POSTGRES_URL`,
  `SPROUT_TRAEFIK_*`, networks), tokens or endpoints,
- run a deploy or open a PR against a live instance without asking me first.

When you are done, summarise in five lines: files written, values you
confirmed with me, CI variables I must set, commands I should run next,
anything you could not determine.
```

## See also

- [Getting started](getting-started.md) — the same flow for humans
- [Adopting a repo](adopting-a-repo.md) — manifest reference
- [CI integration](ci-integration.md) — both forges
