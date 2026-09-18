#!/usr/bin/env bun
import {
  createDefaultClient,
  readGitRemoteUrl,
  readTextFile,
  runCli,
} from "./run.ts";
import {
  defaultRunCommand,
  defaultWriteTextFile,
  resolveGatewayUrl,
} from "./context.ts";

export { resolveGatewayUrl };

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    readTextFile,
    getGitRemoteUrl: readGitRemoteUrl,
    createClient: createDefaultClient,
    runCommand: defaultRunCommand,
    writeTextFile: defaultWriteTextFile,
    io: {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    },
  });
  process.exit(code);
}
