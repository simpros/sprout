import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { assembleSite, repoRootDir, siteEntryPath } from "./assemble.ts";
import { check, defaultCheckPaths } from "./check.ts";

function docsPort(): number {
  const raw = process.env.DOCS_PORT ?? "4173";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid DOCS_PORT=${JSON.stringify(raw)} (want 1–65535)`);
  }
  return port;
}

const siteRoot = await mkdtemp(join(tmpdir(), "sprout-docs-preview-"));
// Clean synchronously: an async rm would race process teardown.
function shutdown(): never {
  try {
    rmSync(siteRoot, { recursive: true, force: true });
  } catch {
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await assembleSite(repoRootDir, siteRoot);
await check(await defaultCheckPaths(siteRoot));

function contentType(path: string): string | undefined {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  return undefined;
}

async function serveFile(abs: string): Promise<Response | null> {
  const file = Bun.file(abs);
  if (await file.exists()) {
    const type = contentType(abs);
    return type
      ? new Response(file, { headers: { "content-type": type } })
      : new Response(file);
  }
  return null;
}

const server = Bun.serve({
  port: docsPort(),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return Response.redirect(new URL(`/${siteEntryPath}`, url), 302);
    }

    const rel = normalize(url.pathname.replace(/^\//, ""));
    if (!rel || rel === "." || rel.startsWith("..")) {
      return new Response("Not found", { status: 404 });
    }
    const abs = resolve(siteRoot, rel);
    if (abs !== siteRoot && !abs.startsWith(siteRoot + "/")) {
      return new Response("Not found", { status: 404 });
    }

    return (
      (await serveFile(abs)) ??
      (await serveFile(join(abs, "index.html"))) ??
      new Response("Not found", { status: 404 })
    );
  },
});

console.log(`docs preview → http://127.0.0.1:${server.port}/docs/site/index.html`);
console.log("Ctrl+C to stop");
