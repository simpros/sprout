# Operator helpers for a single Let's Encrypt wildcard on the preview domain.
# See docs/deploy.md § "Wildcard preview certificate (DNS-01)".
#
# Files:
#   certificates-resolver.dns.yml   — Traefik static-config fragment (dnsChallenge)
#   wildcard-bootstrap.compose.yml  — temporary router to order the wildcard once
#
# All values are placeholders. Fill DNS provider credentials and Traefik paths
# from your environment — never commit secrets.
