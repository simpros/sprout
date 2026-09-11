# Operator helpers for a single Let's Encrypt wildcard on the preview domain.
# See docs/deploy.md § "Wildcard preview certificate (DNS-01)".
#
# Files:
#   certificates-resolver.dns.yml   — coexistence snippet (paste under
#                                     certificatesResolvers:; distinct storage)
#   wildcard-bootstrap.compose.yml  — temporary router to order the wildcard once
#
# Default path: convert the existing resolver to dnsChallenge (docs). Use the
# YAML fragment only when you must keep HTTP-01 for other apps.
#
# All values are placeholders. Fill DNS provider credentials and Traefik paths
# from your environment — never commit secrets.
