# Preview label ownership (`preview.labels`)

**Status:** accepted, implemented.

Container labels on a preview have two owners. The gateway owns the
Traefik routing set it emits per container (`traefik.enable`, the router
rule, the loadbalancer server port, plus the TLS and forwardAuth keys
when that gateway configures them). The adopting repo owns everything
else via optional `preview.labels` (app container and every service
container) and `preview.services[].labels` (that service container
only), merged verbatim — `traefik.*` keys included, so a preview can
attach to a router or middleware defined outside the gateway.

A silently overridden rule, port, or TLS label is how a preview goes
dark with no error, so collision fails fast instead: the gateway
computes its own label set for each container first and rejects any
adopter key already present in it (`reserved_preview_label`, quoting
the manifest path). The reserved set is derived from the emission
itself, never a hard-coded list, so it tracks the gateway's TLS and
forwardAuth policy without drifting.

Label values are literal (no `{pr_id}` interpolation); the seed
container is a one-shot job and carries no adopter labels.
