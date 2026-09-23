# Getting started

First preview in one sitting: one `.sprout.yaml`, two CI variables, one CI
include. Five minutes on a repo that already has a `Dockerfile`.

- New adopter? Read this page only, then run the block below in your coding
  harness — the same single copy-paste block as
  [Onboarding prompt](onboarding-prompt.md).
- Need an exact key? See [Adopting a repo](adopting-a-repo.md).
- Need CI details for your forge? See [CI integration](ci-integration.md).
- Running the gateway itself? See [Operator deploy](operator-deploy.md).

<!-- docs-onboarding-prompt -->

## Prerequisites

- A repo with a `Dockerfile` that serves HTTP.
- An operator-deployed gateway URL plus a deploy token for your repo
  (ask your operator; bootstrapping is in
  [Operator deploy](operator-deploy.md#bootstrap-admin-token)).
- GitLab merge-request pipelines (or GitHub `pull_request` workflows).

Copy-paste app files live in
[`examples/adopting-repo/README.md`](../examples/adopting-repo/README.md).

## 1. `.sprout.yaml` at the repo root

Seeded preview (the `health:` block is required whenever `seed:` is
configured):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
seed:
  dockerfile: Dockerfile.seed
  env:
    FIXTURE_SET: demo
```

Omit the `seed:` block for an app-only preview (the `health:` block can go
too — the gateway defaults to `GET /health` every `2s` for up to `120s`,
expecting `200`). Confirm the `slug` and the hostname template with a human
before committing: never invent a domain. Full key contract in
[Adopting a repo](adopting-a-repo.md#manifest-keys-sproutyaml).

Minimal app-only manifest:

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
```

## 2. CI variables (you set these)

| Variable | Type | Purpose |
|---|---|---|
| `SPROUT_URL` | Variable, masked, required | Gateway URL (or pass the `sprout_url` / `sprout_url` input instead) |
| `SPROUT_TOKEN` | Variable, masked, required | Deploy token scoped to the repo's canonical id |
| `GITLAB_TOKEN` | Variable, masked, optional (GitLab) | Note-write token for the MR note; without it the CLI falls back to `CI_JOB_TOKEN` (best-effort note either way) |

Optional: `SPROUT_APP_ENV` / `SPROUT_SEED_ENV` as masked **File** variables
holding dotenv blobs for app / seed secrets. Never commit a secret to the
manifest — declare `{ required: true }` and supply it here.

## 3. CI wiring (one include)

GitLab (`.gitlab-ci.yml` — one include, no scripts):

```yaml
include:
  - component: $CI_SERVER_FQDN/<group>/sprout-ci/preview@v0.7.0
    inputs: { stage: deploy }
```

GitHub (caller workflow — the canonical caller is
[`examples/adopting-repo/.github/workflows/sprout.yml`](../examples/adopting-repo/.github/workflows/sprout.yml)):

```yaml
jobs:
  preview:
    uses: simpros/sprout/.github/workflows/preview.yml@v0.7.0
    with:
      sprout_version: v0.7.0
    secrets:
      SPROUT_URL: ${{ secrets.SPROUT_URL }}
      SPROUT_TOKEN: ${{ secrets.SPROUT_TOKEN }}
```

Full wiring, variables, reset, and notes in [CI integration](ci-integration.md).

## What you get

- Open / synchronize: `sprout ci preview` builds + pushes images, deploys,
  writes `PREVIEW_URL=`, posts the MR/PR note. Read the URL from the CLI
  output — never reconstruct the hostname in CI.
- Close / merge: `sprout ci teardown` (idempotent).
- Manual wipe + redeploy: `sprout ci reset` (data wiped).
- Sweep recovers if teardown is missed.

## Next step

Run the agent block in [Onboarding prompt](onboarding-prompt.md), or verify
by hand: the manifest must pass the CLI loader (`apps/cli/src/yaml.ts`),
then `sprout doctor` and a first `sprout ci preview` run from CI.

## See also

- [Onboarding prompt](onboarding-prompt.md) — paste into a coding harness
- [Adopting a repo](adopting-a-repo.md) — manifest reference
- [CI integration](ci-integration.md) — both forges, reset, notes
- [Previews](previews.md) — databases, seeding, services, mail
- [Operator deploy](operator-deploy.md) — gateway stack
- [CLI reference](cli-reference.md) — every command
- [Troubleshooting](troubleshooting.md) — error catalogue
