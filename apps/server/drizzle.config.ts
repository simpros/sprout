import { defineConfig } from "drizzle-kit";

const stateDbPath =
  process.env.SPROUT_STATE_DB_PATH?.trim() || "preview-buddy.db";

export default defineConfig({
  schema: "./src/infrastructure/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: stateDbPath,
  },
});
