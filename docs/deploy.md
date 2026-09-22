# Operator deployment

This guide has split. The operator content now lives in
[Operator deploy](operator-deploy.md); every section below maps to the page
that owns it — old deep links still land on these headings.

## Prerequisites

Moved to [Operator deploy](operator-deploy.md#prerequisites).

## Quick start (local smoke)

Moved to [Operator deploy](operator-deploy.md#quick-start-local-smoke).

### Gateway Docker image

Moved to [Operator deploy](operator-deploy.md#gateway-docker-image) (current image `ghcr.io/simpros/sprout:0.7.0`).

## Architecture

Moved to [Operator deploy](operator-deploy.md#architecture).

### Defaults

Moved to [Operator deploy](operator-deploy.md#defaults).

### Dual network attach

Moved to [Operator deploy](operator-deploy.md#dual-network-attach).

## One-click Coolify (Docker Compose Empty)

Moved to [Operator deploy](operator-deploy.md#one-click-coolify-docker-compose-empty).

## Production-shaped deploy (external / Coolify Traefik)

Moved to [Operator deploy](operator-deploy.md#production-shaped-deploy-external--coolify-traefik).

### Wildcard preview certificate (DNS-01)

Moved to [Operator deploy](operator-deploy.md#wildcard-preview-certificate-dns-01).

#### Prerequisites (secrets / access — not in this repo)

Moved to [Operator deploy](operator-deploy.md#prerequisites-secrets--access--not-in-this-repo).

#### Choose a path

Moved to [Operator deploy](operator-deploy.md#choose-a-path).

#### Runbook

Moved to [Operator deploy](operator-deploy.md#runbook).

#### Managed Traefik notes (Coolify and similar)

Moved to [Operator deploy](operator-deploy.md#managed-traefik-notes-coolify-and-similar).

#### Verification (zero LE orders per deploy)

Moved to [Operator deploy](operator-deploy.md#verification-zero-le-orders-per-deploy).

## Preview mail (Mailpit)

Moved to [Operator deploy](operator-deploy.md#preview-mail-mailpit)
(adopter side: [Previews](previews.md#email-from-a-preview)).

### How the mailbox is protected

Moved to [Operator deploy](operator-deploy.md#how-the-mailbox-is-protected).

## Env var reference

Moved to [Operator deploy](operator-deploy.md#env-var-reference).

### Compose project (`compose.env`)

Moved to [Operator deploy](operator-deploy.md#compose-project-composeenv).

### Optional gateway tuning (host `.env` / non-compose)

Moved to [Operator deploy](operator-deploy.md#optional-gateway-tuning-host-env--non-compose).

## Postgres preview role

Moved to [Operator deploy](operator-deploy.md#postgres-preview-role).

## Bootstrap admin token

Moved to [Operator deploy](operator-deploy.md#bootstrap-admin-token).

## Worktree DB (local provisioner)

Moved to [Operator deploy](operator-deploy.md#worktree-db-local-provisioner)
(command: [CLI reference](cli-reference.md#worktree-db-local-provisioner)).

## Upgrade / redeploy

Moved to [Operator deploy](operator-deploy.md#upgrade--redeploy).

## Teardown

Moved to [Operator deploy](operator-deploy.md#teardown).

## Smoke checklist

Moved to [Operator deploy](operator-deploy.md#smoke-checklist).

## Troubleshooting

Moved to [Troubleshooting](troubleshooting.md#operator-errors).

## See also

- [Operator deploy](operator-deploy.md)
- [Getting started](getting-started.md)
- [Troubleshooting](troubleshooting.md)
- [CLI reference](cli-reference.md)
- [`deploy/coolify/README.md`](../deploy/coolify/README.md) + [`deploy/coolify/gateway.compose.yml`](../deploy/coolify/gateway.compose.yml) — one-click Coolify Docker Compose Empty stack (bundled Postgres)
