# E2E acceptance harness

Compose smoke against the **operator stack** (`docker-compose.yml` +
`e2e/compose.e2e.env`).

## Commands

```bash
bun run test:e2e
```

Requires Docker. Project name `sprout-e2e`. `run.ts` reads
`PB_GATEWAY_HOST_PORT` and `PB_ADMIN_TOKEN` from `compose.e2e.env` (fails if
missing), brings compose up, waits for `/healthz`, then runs tests with
`PB_E2E_MANAGED=1` plus injected `PB_E2E_GATEWAY_URL` / `PB_E2E_ADMIN_TOKEN`.

Smoke assertion: admin can mint a deploy token via `@sprout/api-client`.

## Suites

| Suite | Status |
|---|---|
| `stack.test.ts` | compose smoke under `PB_E2E_MANAGED` |
| `lifecycle.test.ts` | `test.todo` breadcrumbs — #25 deploy, #28 seed-skip, #31 teardown/previews |
| `sweep.test.ts` | `test.todo` breadcrumb — #30 sweep |

Unmanaged `bun test` skips the compose suite. Setting `PB_E2E_MANAGED=1`
without `bun run test:e2e` fails loudly on connection errors (operator footgun;
no second latch).
