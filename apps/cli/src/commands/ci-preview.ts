import type { CliContext } from "../context.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import { runCiDeploy, type CiDeployPolicy } from "./ci-deploy.ts";
import { publishPreviewNote } from "./forge-note.ts";
import { buildAndPush } from "./image-build.ts";
import { ensureSeedImage } from "./seed-image.ts";

export const previewDeployPolicy: CiDeployPolicy = {
  allowReseed: true,
  prepareImages: async (ctx, yaml, identity) => {
    let seedImage: string | undefined;
    if (yaml.seed) {
      const seed = await ensureSeedImage(ctx, yaml.seed, identity.imageRef);
      if (!seed.ok) return seed;
      seedImage = seed.value.ref;
    }
    const appDockerfile = yaml.build?.dockerfile ?? "Dockerfile";
    const app = await buildAndPush(ctx, "app", appDockerfile, identity.imageRef);
    if (!app.ok) return app;
    return { ok: true, value: { seedImage } };
  },
  publishNote: (deps, identity, previewUrl) =>
    publishPreviewNote(deps, identity, previewUrl),
};

export async function runCiPreview(
  identity: CiPreviewIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  return runCiDeploy(identity, tokens, ctx, previewDeployPolicy);
}
