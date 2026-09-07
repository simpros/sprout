# E2E acceptance harness

Compose smoke against the **operator stack** (`docker-compose.yml` +
`e2e/compose.e2e.env`).

## Commands

```bash
bun run test:e2e
```

Requires Docker. Project name `sprout-e2e`. `run.ts` reads
`SPROUT_GATEWAY_HOST_PORT` and `SPROUT_ADMIN_TOKEN` from `compose.e2e.env` (fails if
missing), brings compose up, waits for `/healthz`, then runs tests with
`SPROUT_E2E_MANAGED=1` plus injected `SPROUT_E2E_GATEWAY_URL` / `SPROUT_E2E_ADMIN_TOKEN`.

Smoke assertion: admin can mint a deploy token via `@sprout/api-client`.
Role defaults in `compose.e2e.env` are `sprout_admin` / `sprout_preview`.

## Suites

| Suite | Status |
|---|---|
| `stack.test.ts` | compose smoke under `SPROUT_E2E_MANAGED` |
| `lifecycle.test.ts` | deploy with `preview.env` remap; asserts adopter env names on the app container |
| `sweep.test.ts` | `test.todo` breadcrumb — #30 sweep |

Unmanaged `bun test` skips the compose suite. Setting `SPROUT_E2E_MANAGED=1`
without `bun run test:e2e` fails loudly on connection errors (operator footgun;
no second latch).
