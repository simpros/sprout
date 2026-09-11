import { describe, expect, test } from "bun:test";
import {
  assertPullStreamOk,
  createDockerEngineClient,
  demuxDockerLogs,
  firstExposedPortFromInspect,
  splitImageRef,
} from "./engine.ts";
import { previewContainerName } from "../preview/naming.ts";

describe("splitImageRef", () => {
  test("splits tag after last colon past slash", () => {
    expect(splitImageRef("ghcr.io/org/app:sha-abc")).toEqual({
      fromImage: "ghcr.io/org/app",
      tag: "sha-abc",
    });
  });

  test("defaults tag to latest", () => {
    expect(splitImageRef("ghcr.io/org/app")).toEqual({
      fromImage: "ghcr.io/org/app",
      tag: "latest",
    });
  });
});

describe("firstExposedPortFromInspect", () => {
  test("returns first EXPOSE port", () => {
    expect(
      firstExposedPortFromInspect({
        Config: { ExposedPorts: { "3000/tcp": {}, "443/tcp": {} } },
      }),
    ).toBe(3000);
  });

  test("returns null when no EXPOSE", () => {
    expect(firstExposedPortFromInspect({ Config: {} })).toBeNull();
  });
});

describe("assertPullStreamOk", () => {
  test("accepts progress lines without error", () => {
    expect(() =>
      assertPullStreamOk(
        '{"status":"Pulling from org/app"}\n{"status":"Digest: sha256:abc"}\n',
        "img:tag",
      ),
    ).not.toThrow();
  });

  test("throws on error field in NDJSON body", () => {
    expect(() =>
      assertPullStreamOk(
        '{"status":"Pulling"}\n{"error":"pull access denied","errorDetail":{"message":"denied"}}\n',
        "private:tag",
      ),
    ).toThrow(/Docker pull private:tag failed: pull access denied/);
  });

  test("throws on errorDetail.message when error string missing", () => {
    expect(() =>
      assertPullStreamOk(
        '{"errorDetail":{"message":"manifest unknown"}}\n',
        "missing:tag",
      ),
    ).toThrow(/Docker pull missing:tag failed: manifest unknown/);
  });
});

describe("createDockerEngineClient", () => {
  test("createAndStart posts create with all EndpointsConfig, then starts", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const docker = createDockerEngineClient({
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url, method, body });
        if (url.includes("/containers/create")) {
          return new Response(JSON.stringify({ Id: "cid-1" }), { status: 201 });
        }
        if (url.includes("/start")) {
          return new Response(null, { status: 204 });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    const { id } = await docker.createAndStart({
      name: "sprout-myapp-pr-1",
      image: "img:1",
      env: ["PGHOST=postgres"],
      labels: { "traefik.enable": "true" },
      networkNames: ["traefik", "postgres"],
    });
    expect(id).toBe("cid-1");
    expect(calls.map((c) => c.method + " " + c.url)).toEqual([
      "POST http://localhost/containers/create?name=sprout-myapp-pr-1",
      "POST http://localhost/containers/cid-1/start",
    ]);
    const createBody = JSON.parse(calls[0]!.body!);
    expect(createBody.HostConfig).toBeUndefined();
    expect(createBody.NetworkingConfig.EndpointsConfig).toEqual({
      traefik: {},
      postgres: {},
    });
    expect(createBody.Env).toEqual(["PGHOST=postgres"]);
  });

  test("createAndStart includes Cmd when provided and omits Entrypoint", async () => {
    const calls: { body?: string }[] = [];
    const docker = createDockerEngineClient({
      fetch: async (input, init) => {
        const url = String(input);
        const body =
          typeof init?.body === "string" ? init.body : undefined;
        if (url.includes("/containers/create")) {
          calls.push({ body });
          return new Response(JSON.stringify({ Id: "cid-seed" }), {
            status: 201,
          });
        }
        if (url.includes("/start")) {
          return new Response(null, { status: 204 });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    await docker.createAndStart({
      name: "sprout-myapp-pr-1-seed",
      image: "seed:1",
      env: ["PGHOST=postgres"],
      labels: {},
      networkNames: ["postgres"],
      cmd: ["--reset"],
    });
    const createBody = JSON.parse(calls[0]!.body!);
    expect(createBody.Cmd).toEqual(["--reset"]);
    expect(createBody.Entrypoint).toBeUndefined();
  });

  test("waitForExit returns StatusCode from Docker wait", async () => {
    const docker = createDockerEngineClient({
      fetch: async (input, init) => {
        expect(String(input)).toBe("http://localhost/containers/cid-w/wait");
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ StatusCode: 3 }), { status: 200 });
      },
    });
    expect(await docker.waitForExit("cid-w", 5_000)).toEqual({
      timedOut: false,
      exitCode: 3,
    });
  });

  test("waitForExit throws when StatusCode is missing", async () => {
    const docker = createDockerEngineClient({
      fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    await expect(docker.waitForExit("cid-empty", 5_000)).rejects.toThrow(
      /no StatusCode/,
    );
  });

  test("waitForExit returns timedOut when aborted", async () => {
    const docker = createDockerEngineClient({
      fetch: async (_input, init) => {
        const signal = init?.signal;
        await new Promise<void>((resolve, reject) => {
          if (!signal) {
            reject(new Error("missing signal"));
            return;
          }
          if (signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return new Response("{}", { status: 200 });
      },
    });
    expect(await docker.waitForExit("cid-hang", 20)).toEqual({ timedOut: true });
  });

  test("createAndStart removes half-built container when start fails", async () => {
    const calls: string[] = [];
    const docker = createDockerEngineClient({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/containers/create")) {
          return new Response(JSON.stringify({ Id: "cid-fail" }), {
            status: 201,
          });
        }
        if (url.includes("/start")) {
          return new Response("cannot start", { status: 500 });
        }
        if (url.includes("/containers/") && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    await expect(
      docker.createAndStart({
        name: "sprout-myapp-pr-9",
        image: "img:1",
        env: [],
        labels: {},
        networkNames: ["traefik"],
      }),
    ).rejects.toThrow(/Docker start .* failed: 500/);
    expect(calls).toEqual([
      "POST http://localhost/containers/create?name=sprout-myapp-pr-9",
      "POST http://localhost/containers/cid-fail/start",
      "DELETE http://localhost/containers/sprout-myapp-pr-9?force=true",
    ]);
  });

  test("removeByName treats 404 as success", async () => {
    const docker = createDockerEngineClient({
      fetch: async () => new Response(null, { status: 404 }),
    });
    await docker.removeByName("sprout-gone-pr-1");
  });

  test("pullImage sends registry auth with serveraddress when configured", async () => {
    const seen: { auth: string | null } = { auth: null };
    const docker = createDockerEngineClient({
      registryPullAuth: {
        byHost: new Map(),
        fallback: { username: "u", password: "p" },
      },
      fetch: async (_input, init) => {
        seen.auth = new Headers(init?.headers).get("X-Registry-Auth");
        return new Response("{}", { status: 200 });
      },
    });
    await docker.pullImage("ghcr.io/org/app:tag");
    expect(seen.auth).toBe(
      Buffer.from(
        JSON.stringify({
          username: "u",
          password: "p",
          serveraddress: "ghcr.io",
        }),
      ).toString("base64"),
    );
  });

  test("pullImage omits X-Registry-Auth for anonymous pulls", async () => {
    let auth: string | null = "unset";
    const docker = createDockerEngineClient({
      fetch: async (_input, init) => {
        auth = new Headers(init?.headers).get("X-Registry-Auth");
        return new Response("{}", { status: 200 });
      },
    });
    await docker.pullImage("ghcr.io/org/public:tag");
    expect(auth).toBeNull();
  });

  test("pullImage omits X-Registry-Auth when store has no fallback", async () => {
    let auth: string | null = "unset";
    const docker = createDockerEngineClient({
      registryPullAuth: { byHost: new Map() },
      fetch: async (_input, init) => {
        auth = new Headers(init?.headers).get("X-Registry-Auth");
        return new Response("{}", { status: 200 });
      },
    });
    await docker.pullImage("ghcr.io/org/public:tag");
    expect(auth).toBeNull();
  });

  test("pullImage selects per-host creds from registryPullAuth", async () => {
    const seen: string[] = [];
    const docker = createDockerEngineClient({
      registryPullAuth: {
        byHost: new Map([
          ["ghcr.io", { username: "gh", password: "gh-tok" }],
          ["registry.gitlab.com", { username: "gl", password: "gl-tok" }],
        ]),
        fallback: { username: "global", password: "gpass" },
      },
      fetch: async (_input, init) => {
        const auth = new Headers(init?.headers).get("X-Registry-Auth");
        if (auth) {
          seen.push(Buffer.from(auth, "base64").toString("utf8"));
        } else {
          seen.push("anonymous");
        }
        return new Response("{}", { status: 200 });
      },
    });
    await docker.pullImage("ghcr.io/org/app:tag");
    await docker.pullImage("registry.gitlab.com/group/seed:tag");
    await docker.pullImage("quay.io/org/other:tag");
    expect(JSON.parse(seen[0]!)).toEqual({
      username: "gh",
      password: "gh-tok",
      serveraddress: "ghcr.io",
    });
    expect(JSON.parse(seen[1]!)).toEqual({
      username: "gl",
      password: "gl-tok",
      serveraddress: "registry.gitlab.com",
    });
    expect(JSON.parse(seen[2]!)).toEqual({
      username: "global",
      password: "gpass",
      serveraddress: "quay.io",
    });
  });

  test("pullImage stays anonymous for unmatched host without fallback", async () => {
    let auth: string | null = "unset";
    const docker = createDockerEngineClient({
      registryPullAuth: {
        byHost: new Map([
          ["ghcr.io", { username: "gh", password: "gh-tok" }],
        ]),
      },
      fetch: async (_input, init) => {
        auth = new Headers(init?.headers).get("X-Registry-Auth");
        return new Response("{}", { status: 200 });
      },
    });
    await docker.pullImage("quay.io/org/public:tag");
    expect(auth).toBeNull();
  });

  test("pullImage throws when progress stream encodes an error", async () => {
    const docker = createDockerEngineClient({
      fetch: async () =>
        new Response(
          '{"status":"Pulling"}\n{"error":"pull access denied"}\n',
          { status: 200 },
        ),
    });
    await expect(docker.pullImage("ghcr.io/org/private:tag")).rejects.toThrow(
      /Docker pull ghcr.io\/org\/private:tag failed: pull access denied/,
    );
  });

  test("lists preview containers from Docker catalog", async () => {
    const docker = createDockerEngineClient({
      fetch: async (input) => {
        expect(String(input)).toContain("/containers/json?");
        expect(String(input)).toContain("all=true");
        return new Response(
          JSON.stringify([
            { Id: "id-7", Names: ["/sprout-widgets-pr-7"] },
            { Id: "id-other", Names: ["/unrelated"] },
            { Id: "id-8", Names: ["/sprout-widgets-pr-8", "/alias"] },
          ]),
          { status: 200 },
        );
      },
    });

    expect(await docker.listPreviewContainers()).toEqual([
      {
        containerId: "id-7",
        containerName: "sprout-widgets-pr-7",
        slug: "widgets",
        prId: 7,
      },
      {
        containerId: "id-8",
        containerName: "sprout-widgets-pr-8",
        slug: "widgets",
        prId: 8,
      },
    ]);
  });

  test("removeByName uses deterministic preview container name", async () => {
    const calls: string[] = [];
    const docker = createDockerEngineClient({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });

    await docker.removeByName(previewContainerName("widgets", 7));
    expect(calls).toEqual([
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });

  test("removeByName rejects when deterministic name hard-fails", async () => {
    const calls: string[] = [];
    const docker = createDockerEngineClient({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("engine error", { status: 500 });
      },
    });

    await expect(
      docker.removeByName(previewContainerName("widgets", 7)),
    ).rejects.toThrow(/Docker remove .* failed: 500/);
    expect(calls).toEqual([
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });

  test("containerIpOnNetwork reads NetworkSettings for the named network", async () => {
    const docker = createDockerEngineClient({
      fetch: async (input) => {
        expect(String(input)).toBe("http://localhost/containers/cid-9/json");
        return new Response(
          JSON.stringify({
            NetworkSettings: {
              Networks: {
                "sprout-postgres": { IPAddress: "172.20.0.4" },
                "sprout-traefik": { IPAddress: "172.18.0.9" },
              },
            },
          }),
          { status: 200 },
        );
      },
    });
    expect(
      await docker.containerIpOnNetwork("cid-9", "sprout-postgres"),
    ).toBe("172.20.0.4");
  });

  test("containerLogs fetches stdout+stderr with tail and demuxes frames", async () => {
    const name = previewContainerName("widgets", 7);
    const calls: string[] = [];
    const frame = new Uint8Array(8 + 5);
    frame[0] = 1;
    frame[7] = 5;
    frame.set(new TextEncoder().encode("hello"), 8);
    const docker = createDockerEngineClient({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(frame, { status: 200 });
      },
    });
    expect(await docker.containerLogs(name, { tail: 50 })).toBe("hello");
    expect(calls).toEqual([
      `http://localhost/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=0&follow=0&tail=50`,
    ]);
  });

  test("containerLogs returns null on 404", async () => {
    const docker = createDockerEngineClient({
      fetch: async () => new Response("no such container", { status: 404 }),
    });
    expect(await docker.containerLogs("missing", { tail: 10 })).toBeNull();
  });
});

describe("demuxDockerLogs", () => {
  test("joins multiplexed stdout frames", () => {
    const a = new TextEncoder().encode("foo");
    const b = new TextEncoder().encode("bar");
    const buf = new Uint8Array(8 + a.length + 8 + b.length);
    buf[0] = 1;
    buf[7] = a.length;
    buf.set(a, 8);
    buf[8 + a.length] = 2;
    buf[8 + a.length + 7] = b.length;
    buf.set(b, 16 + a.length);
    expect(demuxDockerLogs(buf)).toBe("foobar");
  });

  test("returns raw text when not multiplexed", () => {
    expect(demuxDockerLogs(new TextEncoder().encode("plain\n"))).toBe(
      "plain\n",
    );
  });
});
