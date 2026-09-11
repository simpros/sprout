# Operator helpers for a single Let's Encrypt wildcard on the preview domain.
# See docs/deploy.md § "Wildcard preview certificate (DNS-01)".
#
# Files:
#   certificates-resolver.dns.yml   — dnsChallenge body (default: convert in
#                                     place under existing resolver name;
#                                     coexistence: copy under a new key with
#                                     distinct storage)
#   wildcard-bootstrap.compose.yml  — temporary router to order the wildcard once
#                                     (required env via `${VAR:?…}`)
#
# All values are placeholders. Fill DNS provider credentials and Traefik paths
# from your environment — never commit secrets.
