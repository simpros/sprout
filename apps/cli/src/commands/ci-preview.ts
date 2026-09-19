import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import { runCiDeploy, type CiDeployPolicy } from "./ci-deploy.ts";
import { publishPreviewNote } from "./forge-note.ts";
import { buildAndPush } from "./image-build.ts";
import {
  fetchHandledMarker,
  parseResetRequest,
  readResetRequestBody,
  recordHandledMarker,
  untickGithubResetBox,
} from "./reset-request.ts";
import { ensureSeedImage } from "./seed-image.ts";
import { teardownPreview } from "./teardown.ts";

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

function isNotFoundMessage(message: string): boolean {
  return /^404\b/.test(message);
}

export async function runCiPreview(
  identity: CiPreviewIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const raw = await readResetRequestBody(ctx.deps, identity.forge);
  if (!raw.ok) return fail(ctx.deps.io, raw.error);
  const marker = parseResetRequest(raw.value);
  if (!marker) {
    return runCiDeploy(identity, tokens, ctx, previewDeployPolicy);
  }

  const handled = await fetchHandledMarker(ctx.client, identity);
  if (!handled.ok) return fail(ctx.deps.io, handled.error);
  if (handled.value === marker) {
    return runCiDeploy(identity, tokens, ctx, previewDeployPolicy);
  }

  let preMarked = false;
  const policy: CiDeployPolicy = {
    ...previewDeployPolicy,
    beforeDeploy: async (client, id) => {
      const torn = await teardownPreview(client, id);
      if (!torn.ok) return torn;
      const marked = await recordHandledMarker(client, id, marker);
      if (!marked.ok) {
        if (isNotFoundMessage(marked.error)) {
          preMarked = false;
          return { ok: true, value: undefined };
        }
        return marked;
      }
      preMarked = true;
      return { ok: true, value: undefined };
    },
  };
  const code = await runCiDeploy(identity, tokens, ctx, policy);
  if (code !== 0) return code;

  if (!preMarked) {
    const marked = await recordHandledMarker(ctx.client, identity, marker);
    if (!marked.ok) return fail(ctx.deps.io, marked.error);
  }
  if (raw.value) {
    const unticked = await untickGithubResetBox(ctx.deps, identity, raw.value);
    if (!unticked.ok) {
      ctx.deps.io.stderr(`warning: ${unticked.error}`);
    }
  }
  return 0;
}
