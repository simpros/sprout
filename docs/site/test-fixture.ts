import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { publishFiles } from "./assemble.ts";

const dirSamples: Record<string, string> = {
  "templates/README.md": "# templates\n",
  "templates/preview.yml": "# yml\n",
  "examples/adopting-repo/docker-entrypoint.sh": "#!/bin/sh\n",
  "examples/adopting-repo/.github/workflows/sprout.yml": "# ci\n",
};

const overlays: Record<string, string> = {
  "docs/site/index.html":
    `<html><body><a href="../deploy.md">deploy</a><a href="../adoption.md">adopt</a></body></html>\n`,
  "docs/index.html":
    `<html><body><a href="adoption.md">adopt</a><a href="getting-started.md">start</a></body></html>\n`,
  "llms.txt":
    "These docs are for agents. Start with the onboarding prompt.\n" +
    "- [Onboarding prompt](https://simpros.github.io/sprout/docs/onboarding-prompt.md): entry point.\n" +
    "- [Getting started](https://simpros.github.io/sprout/docs/getting-started.md): first preview.\n" +
    "- [Adopting a repo](https://simpros.github.io/sprout/docs/adopting-a-repo.md): manifest reference.\n" +
    "- [CI integration](https://simpros.github.io/sprout/docs/ci-integration.md): CI wiring.\n" +
    "- [Previews](https://simpros.github.io/sprout/docs/previews.md): lifecycle.\n" +
    "- [Operator deploy](https://simpros.github.io/sprout/docs/operator-deploy.md): gateway stack.\n" +
    "- [CLI reference](https://simpros.github.io/sprout/docs/cli-reference.md): commands.\n" +
    "- [Troubleshooting](https://simpros.github.io/sprout/docs/troubleshooting.md): errors.\n",
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
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
}
