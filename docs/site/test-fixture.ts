import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { publishFiles, renderLlmsTxt } from "./assemble.ts";

const dirSamples: Record<string, string> = {
  "templates/README.md": "# templates\n",
  "templates/preview.yml": "# yml\n",
  "examples/adopting-repo/docker-entrypoint.sh": "#!/bin/sh\n",
  "examples/adopting-repo/.github/workflows/sprout.yml": "# ci\n",
};

const overlays: Record<string, string> = {
  // Body fragment like the production source: no envelope, no theme marker,
  // no `.wrap` — the shell supplies those.
  "docs/site/index.html":
    `<a href="../deploy.md">deploy</a><a href="../adoption.md">adopt</a>\n`,
  "docs/index.html":
    `<html><body><a href="adoption.md">adopt</a><a href="getting-started.md">start</a></body></html>\n`,
  // Real meta-tagged fence like the production source: assembly extracts the
  // prompt from this file on every run.
  "docs/onboarding-prompt.md":
    "# docs/onboarding-prompt.md\n\n```text prompt\nfixture prompt\n```\n",
  "README.md": "# r\n[adopt](docs/adoption.md)\n",
  "docs/deploy.md":
    "See [adoption](adoption.md), [e2e](../e2e/README.md), " +
    "[traefik](../deploy/traefik/README.md), and " +
    "[resolver](../deploy/traefik/certificates-resolver.dns.yml).\n",
  "docs/adoption.md":
    "See [deploy](deploy.md), [templates](../templates/README.md), and " +
    "[entrypoint](../examples/adopting-repo/docker-entrypoint.sh).\n",
  "examples/adopting-repo/README.md": "# ex\n[adopt](../../docs/adoption.md)\n",
};

export async function writeCorpusFixture(root: string): Promise<void> {
  const files: Record<string, string> = {};
  for (const file of publishFiles) files[file] = `# ${file}\n`;
  Object.assign(files, dirSamples, overlays);
  // The agent index is generated from the page manifest, never hand-copied.
  files["llms.txt"] = renderLlmsTxt();
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
}
