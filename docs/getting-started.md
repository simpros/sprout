# Getting started

Reach a first preview in one sitting: one `.sprout.yaml`, two CI variables,
one CI include. About five minutes on a repo that already ships a
`Dockerfile` that serves HTTP.

This lesson takes the GitLab path. On GitHub the steps are the same shape
with a caller workflow instead of an include — branch at step 3 to
[CI integration](ci-integration.md#github-actions) and rejoin at
[What you get](#what-you-get).

- Exact key contract: [Adopting a repo](adopting-a-repo.md).
- Gateway setup (operator work): [Operator deploy](operator-deploy.md).

<!-- docs-onboarding-prompt -->

## Prerequisites

- A repo with a `Dockerfile` that serves HTTP.
- A gateway URL plus a deploy token for the repo from the operator.
  Bootstrapping is operator work:
  [Operator deploy](operator-deploy.md#bootstrap-admin-token).
- Merge-request pipelines (GitLab) or `pull_request` workflows (GitHub).

Copy-paste app files live in
[`examples/adopting-repo/README.md`](../examples/adopting-repo/README.md).

## 1. `.sprout.yaml` at the repo root

Write this file. Replace `myapp` and the domain with values confirmed with
a human — never invent a domain. The template must contain `{pr_id}` as a
bare host: no scheme, port, or path.

```yaml file=.sprout.yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
```

Unknown keys are rejected (`unknown key: <path>`), so typos fail on the
first `sprout ci preview`.

When this deploys, add seeding next:
[Adopting a repo](adopting-a-repo.md#manifest-keys-sproutyaml).

## 2. CI variables (you set these)

Set two masked variables in the repo's CI settings:

- `SPROUT_URL` — the gateway URL. (Alternatively pass the `sprout_url`
  input; one of the two is required.)
- `SPROUT_TOKEN` — the deploy token scoped to this repo's canonical id.

For GitLab MR notes, an optional `GITLAB_TOKEN` (masked) lets the CLI
create notes; without it the CLI falls back to `CI_JOB_TOKEN` on a
best-effort basis either way.

App or seed secrets never go in the manifest. Declare
`{ required: true }` there and supply values here as masked **File**
variables (`SPROUT_APP_ENV` / `SPROUT_SEED_ENV` dotenv blobs).

## 3. CI wiring (one include)

Add the include to `.gitlab-ci.yml`. Replace `<group>/sprout-ci` with the
component project path on the instance and `v0.9.0` with the adopted
release:

```yaml
include:
  - component: $CI_SERVER_FQDN/<group>/sprout-ci/preview@v0.9.0
    inputs: { stage: deploy }
```

Open a merge request. The `sprout-preview` job installs the pinned CLI,
builds and pushes the app image, deploys, and posts the MR note with the
preview URL.

## What you get

- Open / synchronize: the job deploys and writes `PREVIEW_URL=`. Read the
  URL from the CLI output — never reconstruct the hostname in CI.
- Close / merge: `sprout ci teardown` runs via `on_stop` (idempotent —
  exit 0 when already gone) and deletes the commit's app + seed image tags.
- Manual wipe + redeploy: `sprout ci reset` (data wiped).
- A missed teardown is recovered by the gateway sweep.
- The gateway reports anonymous [install telemetry](telemetry.md) by
  default (`SPROUT_TELEMETRY=off` stops it) — operator concern, nothing to
  do in this lesson.

## Next step

Run the agent block in [Onboarding prompt](onboarding-prompt.md), or verify
by hand: `sprout doctor`, then a first `sprout ci preview` run from CI.

## See also

- [Onboarding prompt](onboarding-prompt.md) — paste into a coding harness
- [Adopting a repo](adopting-a-repo.md) — manifest reference
- [CI integration](ci-integration.md) — both forges, reset, notes
- [Previews](previews.md) — databases, seeding, services, mail
- [Operator deploy](operator-deploy.md) — gateway stack
- [CLI reference](cli-reference.md) — every command
- [Troubleshooting](troubleshooting.md) — error catalogue
- [Telemetry](telemetry.md) — anonymous install reporting, off switch
