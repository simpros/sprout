/** Test-only harness for ephemeral Postgres (Docker). Not part of the runtime API. */
export {
  dockerAvailable,
  startTempPostgres,
  type TempPostgres,
} from "./postgres-it.ts";
