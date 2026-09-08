# Seeding via a user-provided one-shot seed image

Optional seeding runs in a **seed image** built and published by the adopting
repo's CI (same commit as the app image). The gateway treats that image as the
**after-healthy** timing hook: it starts a one-shot container only after
`health.expect` passes, with connection env injected; the image entrypoint
owns all install and seed logic. See `docs/adoption.md` for the ordering,
timeout, failure, and resume contract.

Gateway-side repo cloning with forge tokens was rejected: auth complexity,
slow cold paths, and coupling to forge APIs for something adopters already
solve in CI. `docker exec` into the running app container was rejected: seed
assets are not in the app image. A shared `sprout-seeder` image was
rejected for the same reason — adopters own their stack and seed scripts.

The gateway never overrides the seed image entrypoint. `--seed-env` and
`--seed-arg` on `sprout deploy` pass optional runtime inputs only.
