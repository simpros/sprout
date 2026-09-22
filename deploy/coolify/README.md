# Sprout gateway on Coolify (Docker Compose Empty)

Paste [`sprout.yaml`](./sprout.yaml) into a Coolify **Docker Compose Empty**
resource. You get a self-contained gateway + bundled Postgres; no bundled
Traefik or Mailpit — previews are routed by the proxy Coolify already runs.

## Proxy requirement

Traefik — Coolify's default — or `Custom (None)` with your own Traefik.
Caddy's label-less routing is **not** supported: the gateway registers
preview routes via Traefik Docker labels only.

## Operator steps

1. **Deploy.** Create the resource, paste `sprout.yaml`, deploy. Coolify
   generates the `SERVICE_PASSWORD_*` values (symbol-free, so they
   interpolate into the admin DSN without URL-encoding) and the gateway
   domain (`SERVICE_FQDN_GATEWAY`). The resource is healthy when
   `https://<generated-domain>/healthz` answers through the Coolify proxy.
2. **Wildcard DNS.** Point the preview wildcard (e.g.
   `*.previews.example.com` — placeholders only, use your own domain) at
   the Coolify server, so per-PR preview hosts resolve to the proxy. Each
   preview host orders its own Let's Encrypt certificate through the
   `letsencrypt` (HTTP-01) resolver, so fleets past a handful of PRs hit
   the 50-certs/week rate limit — for a single shared wildcard instead,
   follow [Wildcard preview certificate
   (DNS-01)](../../docs/deploy.md#wildcard-preview-certificate-dns-01).
3. **Preview hostname template.** In each adopting repo's `.sprout.yaml`,
   set `preview.hostname` to a bare host under that wildcard containing
   `{pr_id}` (e.g. `pr-{pr_id}.previews.example.com`). See the
   [adoption guide](../../docs/adoption.md).
4. **CLI auth.** `sprout` against `SPROUT_URL=https://<generated-domain>`
   with `SPROUT_TOKEN` set to the `SPROUT_ADMIN_TOKEN` value shown in
   Coolify's Environment Variables UI (it mirrors
   `SERVICE_PASSWORD_SPROUTADMIN`); see
   [Bootstrap admin token](../../docs/deploy.md#bootstrap-admin-token)
   for the token file, the pinned-vs-generated split, and the CLI
   resolution order.
5. **Optional mail.** `SPROUT_MAIL_*` is unset here: previews deploy
   without mail env. To add a shared Mailpit, follow
   [Preview mail](../../docs/deploy.md#preview-mail-mailpit) and add the
   `SPROUT_MAIL_HOST` / `SPROUT_MAIL_NETWORK` entries to the gateway
   environment.
6. **Optional SSO gate.** To front previews with Traefik forwardAuth (e.g.
   VoidAuth), set `SPROUT_TRAEFIK_MIDDLEWARES` plus
   `SPROUT_FORWARDAUTH_ADDRESS` together (or leave both empty) — see
   [Production-shaped deploy](../../docs/deploy.md#production-shaped-deploy-external--coolify-traefik).

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
  [`docs/deploy.md`](../../docs/deploy.md#production-shaped-deploy-external--coolify-traefik).
- **Pinned image.** The tag (`ghcr.io/simpros/sprout:0.7.0`) is pinned on
  purpose and a Coolify resource copies this file at creation time — it
  does not follow upstream updates. Bump the pin deliberately.
- The gateway ensures the `sprout_preview` role itself from the superuser
  `POSTGRES_USER` DSN, so no `CREATE ROLE` bootstrap step is needed.
