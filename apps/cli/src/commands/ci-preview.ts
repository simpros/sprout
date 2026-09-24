import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import { runCiDeploy, type CiDeployPolicy } from "./ci-deploy.ts";
import { publishPreviewNote } from "./forge-note.ts";
import { buildAndPush } from "./image-build.ts";
import {
  classifyResetRequest,
  fetchHandledMarker,
  markResetRequestHandled,
  readResetRequestBody,
  truncationNotice,
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
  publishNote: (deps, identity, settled) =>
    publishPreviewNote(deps, identity, settled),
};

export async function runCiPreview(
  identity: CiPreviewIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const raw = await readResetRequestBody(ctx.deps, identity.forge);
  if (!raw.ok) return fail(ctx.deps.io, raw.error);
  const outcome = classifyResetRequest(raw.value);
  if (outcome.kind === "reset") {
    const marker = outcome.marker;
    const handled = await fetchHandledMarker(ctx.client, identity);
    if (!handled.ok) return fail(ctx.deps.io, handled.error);
    if (handled.value === marker) {
      return runCiDeploy(identity, tokens, ctx, previewDeployPolicy);
    }

    // One marker write after a successful deploy: a failed deploy leaves the
    // token unhandled so the retry resets again instead of deploying over a
    // half-torn state.
    const policy: CiDeployPolicy = {
      ...previewDeployPolicy,
      beforeDeploy: (client, id) => teardownPreview(client, id),
    };
    const code = await runCiDeploy(identity, tokens, ctx, policy);
    if (code !== 0) return code;

    const marked = await markResetRequestHandled(
      ctx.deps,
      ctx.client,
      identity,
      raw.value.body,
      marker,
    );
    if (!marked.ok) return fail(ctx.deps.io, marked.error);
    return 0;
  }

  const notice = truncationNotice(outcome);
  if (notice?.level === "warning") ctx.deps.io.stderr(`warning: ${notice.message}`);
  const code = await runCiDeploy(identity, tokens, ctx, previewDeployPolicy);
  if (code !== 0) return code;
  if (notice?.level === "error") return fail(ctx.deps.io, notice.message);
  return 0;
}
