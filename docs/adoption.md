# Adopting repo guide

This guide has split into per-topic pages. Start in
[Getting started](getting-started.md), or paste the
[Onboarding prompt](onboarding-prompt.md) into your coding harness.
Every section below maps to the page that now owns it — old deep links
still land on these headings.

## Quickstart (GitLab component)

Moved to [Getting started](getting-started.md) and
[CI integration](ci-integration.md#gitlab-component) (component `preview@v0.7.0`).

### Component → CLI ownership

Moved to [CI integration](ci-integration.md#component-cli-ownership).

## Reference

Moved to [Adopting a repo](adopting-a-repo.md#manifest-keys-sproutyaml).

### Manifest keys (`.sprout.yaml`)

Moved to [Adopting a repo](adopting-a-repo.md#manifest-keys-sproutyaml).

#### Connection env: names, roles, reservation, port

Moved to [Adopting a repo](adopting-a-repo.md#connection-env-names-roles-reservation-port).

#### Env value grammar

Moved to [Adopting a repo](adopting-a-repo.md#env-value-grammar).

#### Env merge order

Moved to [Adopting a repo](adopting-a-repo.md#env-merge-order).

#### Service images: merge, leave, clear, lifecycle

Moved to [Previews](previews.md#service-images-merge-leave-clear-lifecycle).

#### Preview labels: adopter-supplied container labels

Moved to [Previews](previews.md#preview-labels-adopter-supplied-container-labels).

#### Seed run order and resume

Moved to [Previews](previews.md#seed-run-order-and-resume).

### SQLite previews

Moved to [Previews](previews.md#sqlite-previews).

### No-database previews

Moved to [Previews](previews.md#no-database-previews).

### Email from a preview

Moved to [Previews](previews.md#email-from-a-preview).

#### Which preview did this mail come from?

Moved to [Previews](previews.md#which-preview-did-this-mail-come-from).

#### Shared inbox

Moved to [Previews](previews.md#shared-inbox).

### CLI `ci` commands

Moved to [CLI reference](cli-reference.md#ci-commands).

### Reset a preview

Moved to [CI integration](ci-integration.md#reset-a-preview).

#### GitLab triggering

Moved to [CI integration](ci-integration.md#gitlab-triggering).

#### GitHub triggering

Moved to [CI integration](ci-integration.md#github-triggering).

### Reset request checkbox

Moved to [CI integration](ci-integration.md#reset-request-checkbox).

### Component inputs (`templates/preview.yml`)

Moved to [CI integration](ci-integration.md#component-inputs-templatespreviewyml).

## Migration from a hand-rolled script

Moved to [CI integration](ci-integration.md#migration-from-a-hand-rolled-script).

## Troubleshooting

Moved to [Troubleshooting](troubleshooting.md#adopter-errors).

## App image: migrate at startup

Moved to [Adopting a repo](adopting-a-repo.md#app-image-migrate-at-startup).

### Dual-role (RLS) previews

Moved to [Adopting a repo](adopting-a-repo.md#dual-role-rls-previews).

### Extra app env (non-connection)

Moved to [Adopting a repo](adopting-a-repo.md#extra-app-env-non-connection).

### Shell entrypoint (any runtime)

Moved to [Adopting a repo](adopting-a-repo.md#shell-entrypoint-any-runtime).

### Bun / Node one-liner variant

Moved to [Adopting a repo](adopting-a-repo.md#bun-node-one-liner-variant).

## After-healthy hook (seed image)

Moved to [Previews](previews.md#after-healthy-hook-seed-image).

## Multi-image previews (app + services)

Moved to [Previews](previews.md#multi-image-previews-app-services).

### Routing (optional)

Moved to [Previews](previews.md#routing-optional).

## Debugging

Moved to [CLI reference](cli-reference.md#debugging).

## CI workflow (GitHub Actions)

Moved to [CI integration](ci-integration.md#github-actions).

### Manual install (laptops, hand-rolled jobs)

Moved to [CI integration](ci-integration.md#manual-install-laptops-hand-rolled-jobs).

## Deploy token setup

Moved to [CLI reference](cli-reference.md#deploy-token-setup).

## Test coverage (maintainers)

Moved to [CLI reference](cli-reference.md#test-coverage-maintainers).

## See also

- [Getting started](getting-started.md)
- [Adopting a repo](adopting-a-repo.md)
- [CI integration](ci-integration.md)
- [Previews](previews.md)
- [CLI reference](cli-reference.md)
- [Troubleshooting](troubleshooting.md)
- [Operator deploy](operator-deploy.md)
- [Onboarding prompt](onboarding-prompt.md)
