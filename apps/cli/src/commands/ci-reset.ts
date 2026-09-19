import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import { runCiDeploy, type CiDeployPolicy } from "./ci-deploy.ts";
import { publishPreviewNote } from "./forge-note.ts";
import { resolveResetRequest, recordHandledMarker, untickGithubResetBox, readResetRequestBody } from "./reset-request.ts";
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
  const code = await runCiDeploy(identity, tokens, ctx, resetDeployPolicy);
  if (code !== 0) return code;

  const requested = await resolveResetRequest(ctx.deps, identity.forge);
  if (!requested.ok) {
    ctx.deps.io.stderr(`warning: ${requested.error}`);
    return 0;
  }
  if (!requested.value) return 0;
  const marked = await recordHandledMarker(
    ctx.client,
    identity,
    requested.value,
  );
  if (!marked.ok) return fail(ctx.deps.io, marked.error);
  const raw = await readResetRequestBody(ctx.deps, identity.forge);
  if (raw.ok && raw.value) {
    const unticked = await untickGithubResetBox(
      ctx.deps,
      identity,
      raw.value,
    );
    if (!unticked.ok) {
      ctx.deps.io.stderr(`warning: ${unticked.error}`);
    }
  }
  return 0;
}
