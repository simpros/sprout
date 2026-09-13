/**
 * Build then serve the docs site. Relative links in index.html
 * (`../adoption.md`, `../../examples/…`) collapse to `/adoption.md` /
 * `/examples/…` in the browser; map those onto the repo tree.
 */
import { spawn } from "node:child_process";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(siteDir, "..");
const repoRoot = resolve(siteDir, "../..");
const distDir = join(siteDir, "dist");
const port = Number(process.env.DOCS_PORT ?? 4173);

async function build(): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("bun", ["run", join(siteDir, "build.ts")], {
      stdio: "inherit",
      cwd: repoRoot,
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`docs:build exited ${code}`));
    });
  });
}

await build();

function contentType(path: string): string | undefined {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  return undefined;
}

function candidatesFor(pathname: string): string[] {
  const rel = normalize(pathname.replace(/^\//, "") || "index.html");
  if (rel.startsWith("..")) return [];

  return [
    join(distDir, rel),
    join(siteDir, rel),
    join(docsDir, rel),
    join(repoRoot, rel),
  ];
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;
    if (pathname === "/") pathname = "/index.html";

    for (const candidate of candidatesFor(pathname)) {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        const type = contentType(candidate);
        return type
          ? new Response(file, { headers: { "content-type": type } })
          : new Response(file);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`docs preview → http://127.0.0.1:${server.port}`);
console.log("Ctrl+C to stop");
