# Sprout gateway on Coolify (Docker Compose Empty)

Paste [`gateway.compose.yml`](./gateway.compose.yml) into a Coolify **Docker Compose Empty**
resource. You get a self-contained gateway + bundled Postgres; no bundled
Traefik or Mailpit — previews are routed by the proxy Coolify already runs.

## Proxy requirement

Traefik — Coolify's default — or `Custom (None)` with your own Traefik.
Caddy's label-less routing is **not** supported: the gateway registers
preview routes via Traefik Docker labels only.

## Operator steps

1. **Deploy.** Create the resource, paste `gateway.compose.yml`, deploy. Coolify
   generates the `SERVICE_PASSWORD_*` values (symbol-free, so they
   interpolate into the admin DSN without URL-encoding) and the gateway
   domain (`SERVICE_FQDN_GATEWAY`). The resource is healthy when
   `https://<generated-domain>/healthz` answers through the Coolify proxy.
2. Then follow the canonical guides in order — this README owns only the
   Coolify delta above, not the procedures below:
   1. [Wildcard preview certificate (DNS-01)](../../docs/operator-deploy.md#wildcard-preview-certificate-dns-01) — point the preview wildcard at the Coolify server (single shared wildcard past a handful of PRs).
   2. [Adopting a repo](../../docs/adopting-a-repo.md) — set `preview.hostname` to a bare host under that wildcard containing `{pr_id}`.
   3. [Bootstrap admin token](../../docs/operator-deploy.md#bootstrap-admin-token) — `sprout` against `SPROUT_URL=https://<generated-domain>` with the `SPROUT_ADMIN_TOKEN` value from Coolify's Environment Variables UI.
   4. [Preview mail](../../docs/operator-deploy.md#preview-mail-mailpit) (optional) — add the shared Mailpit entries to the gateway environment.
   5. [Production-shaped deploy](../../docs/operator-deploy.md#production-shaped-deploy-external--coolify-traefik) (optional) — set `SPROUT_TRAEFIK_MIDDLEWARES` plus `SPROUT_FORWARDAUTH_ADDRESS` together (or leave both empty) to front previews with Traefik forwardAuth.

## Caveats

- **Shared `coolify` network.** Both `SPROUT_TRAEFIK_NETWORK` and
  `SPROUT_POSTGRES_NETWORK` point at the predefined external `coolify`
  network — the only name known at template time that the proxy is
  attached to. Confirm membership with
  `docker network inspect coolify --format '{{range .Containers}}{{.Name}} {{end}}'`
  (it must list `coolify-proxy`); if the instance names the proxy network
  differently, change the `networks:` block and both `SPROUT_*_NETWORK`
  values together. Cost: the bundled Postgres is reachable from every
  container on `coolify`. Operators wanting a dedicated DB network keep
  using the external-overlay path in
  [`docs/operator-deploy.md`](../../docs/operator-deploy.md#production-shaped-deploy-external--coolify-traefik).
- **Pinned image.** The tag (`ghcr.io/simpros/sprout:0.8.1`) is pinned on
  purpose and a Coolify resource copies this file at creation time — it
  does not follow upstream updates. Bump the pin deliberately.
- The gateway ensures the `sprout_preview` role itself from the superuser
  `POSTGRES_USER` DSN, so no `CREATE ROLE` bootstrap step is needed.
