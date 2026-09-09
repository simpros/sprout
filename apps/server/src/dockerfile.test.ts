import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dockerfile = readFileSync(
  join(import.meta.dir, "../../../Dockerfile"),
  "utf8",
);

describe("gateway Dockerfile", () => {
  test("embeds sprout CLI workspace packages in the frozen-lockfile build", () => {
    expect(dockerfile).toContain("COPY apps/cli/package.json apps/cli/");
    expect(dockerfile).toContain(
      "COPY packages/api-client/package.json packages/api-client/",
    );
    expect(dockerfile).toContain("bun install --frozen-lockfile");
    expect(dockerfile).toContain("COPY apps/cli apps/cli");
    expect(dockerfile).toContain("COPY packages/api-client packages/api-client");
  });

  test("installs a PATH-facing sprout entrypoint for docker exec", () => {
    expect(dockerfile).toContain("/usr/local/bin/sprout");
  });
});
