/** Minimal repo carrying every path the publish manifest expects. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const files: Record<string, string> = {
  "docs/site/index.html":
    `<html><body><a href="../deploy.md">deploy</a><a href="../adoption.md">adopt</a></body></html>\n`,
  "README.md": "# r\n[adopt](docs/adoption.md) [adr](docs/adr/README.md)\n",
  "CONTEXT.md": "# ctx\n",
  "compose.env.example": "# env\n",
  ".env.example": "# env\n",
  "docs/deploy.md":
    "See [adoption](adoption.md), [e2e](../e2e/README.md), " +
    "[traefik](../deploy/traefik/README.md), and " +
    "[resolver](../deploy/traefik/certificates-resolver.dns.yml).\n",
  "docs/adoption.md":
    "See [deploy](deploy.md), [templates](../templates/README.md), and " +
    "[entrypoint](../examples/adopting-repo/docker-entrypoint.sh).\n",
  "docs/adr/README.md": "# adrs\n[one](0001-thing.md)\n",
  "docs/adr/0001-thing.md": "# one\n",
  "examples/adopting-repo/README.md": "# ex\n[adopt](../../docs/adoption.md)\n",
  "examples/adopting-repo/docker-entrypoint.sh": "#!/bin/sh\n",
  "examples/adopting-repo/.github/workflows/sprout.yml": "# ci\n",
  "e2e/README.md": "# e2e\n",
  "deploy/traefik/README.md": "# traefik\n",
  "deploy/traefik/certificates-resolver.dns.yml": "# yml\n",
  "deploy/traefik/wildcard-bootstrap.compose.yml": "# yml\n",
  "deploy/postgres/ensure-preview-role.sh": "#!/bin/sh\n",
  "templates/README.md": "# templates\n",
  "templates/preview.yml": "# yml\n",
};

export async function writeCorpusFixture(root: string): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
}
