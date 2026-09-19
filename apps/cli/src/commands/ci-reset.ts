import type { CliContext } from "../context.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import { runCiDeploy, type CiDeployPolicy } from "./ci-deploy.ts";
import { publishPreviewNote } from "./forge-note.ts";
import { resolveSeedTarget } from "./seed-image.ts";
import { teardownPreview } from "./teardown.ts";

export const resetDeployPolicy: CiDeployPolicy = {
  allowReseed: false,
  prepareImages: async (ctx, yaml, identity) => {
    if (!yaml.seed) return { ok: true, value: {} };
    const target = await resolveSeedTarget(
      yaml.seed,
      identity.imageRef,
      ctx.deps.cwd,
      ctx.deps.readTextFile,
    );
    if (!target.ok) return target;
    return { ok: true, value: { seedImage: target.value.ref } };
  },
  beforeDeploy: async (client, identity) => teardownPreview(client, identity),
  publishNote: (deps, identity, previewUrl) =>
    publishPreviewNote(deps, identity, previewUrl, { reset: true }),
};

export async function runCiReset(
  identity: CiPreviewIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  return runCiDeploy(identity, tokens, ctx, resetDeployPolicy);
}
