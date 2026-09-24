import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import { runCiDeploy, type CiDeployPolicy } from "./ci-deploy.ts";
import { publishPreviewNote } from "./forge-note.ts";
import {
  classifyResetRequest,
  markResetRequestHandled,
  readResetRequestBody,
  truncationNotice,
} from "./reset-request.ts";
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
  publishNote: (deps, identity, settled) =>
    publishPreviewNote(deps, identity, { ...settled, reset: true }),
};

export async function runCiReset(
  identity: CiPreviewIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const code = await runCiDeploy(identity, tokens, ctx, resetDeployPolicy);
  if (code !== 0) return code;

  const raw = await readResetRequestBody(ctx.deps, identity.forge);
  if (!raw.ok) {
    ctx.deps.io.stderr(`warning: ${raw.error}`);
    return 0;
  }
  const { body } = raw.value;
  const outcome = classifyResetRequest(raw.value);
  if (outcome.kind === "reset") {
    const marked = await markResetRequestHandled(
      ctx.deps,
      ctx.client,
      identity,
      body,
      outcome.marker,
    );
    if (!marked.ok) return fail(ctx.deps.io, marked.error);
    return 0;
  }
  const notice = truncationNotice(outcome);
  if (notice?.level === "error") return fail(ctx.deps.io, notice.message);
  if (notice?.level === "warning") ctx.deps.io.stderr(`warning: ${notice.message}`);
  return 0;
}
