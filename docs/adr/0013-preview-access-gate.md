# Preview access gate is gateway-native (`preview.auth`)

Previews are open by default; `preview.auth` (`basic` | `link`) gates one
preview via a per-preview Traefik middleware on the app router only.

The gate lives in the gateway, not an external forward-auth service. That was
tried and abandoned: every Cloudflare path rewrites `X-Forwarded-Host`, and the
service rebuilt its URL from that header, hit its self-request shortcut, and
authorised everything.

- `basic`: gateway-generated credential, htpasswd entry inline in the label (no
  volume is shared with Traefik).
- `link`: HMAC-signed token with a per-preview version; revoking rotates the
  version, no redeploy needed.
- The app receives no identity header and no new env.
