import { describe, expect, test } from "bun:test";
import {
  codeBlockExtension,
  codeBlockFigure,
  codeBlockScript,
  promptFigure,
} from "./codeblock.ts";

describe("codeBlockFigure", () => {
  test("emits the one markup shape, untagged fences read as text", () => {
    const html = codeBlockFigure(undefined, "a < b", "Copy onboarding prompt");
    expect(html).toContain('<figure class="codeblock" data-lang="text">');
    expect(html).toContain('<span class="codeblock-lang">text</span>');
    expect(html).toContain(
      '<button class="codeblock-copy" type="button" aria-label="Copy onboarding prompt">Copy</button>',
    );
    expect(html).toContain("<pre><code>a &lt; b</code></pre>");
    expect(codeBlockFigure("yaml", "k: v")).toContain('data-lang="yaml"');
  });

  test("extension turns every code node into the component", () => {
    const rendered = codeBlockExtension.renderHtml!(
      { type: "code", lang: "sh", value: "echo hi" },
      { options: {}, renderBlock: () => "", renderInline: () => "" },
    );
    expect(rendered).toContain('<figure class="codeblock" data-lang="sh">');
    expect(
      codeBlockExtension.renderHtml!(
        { type: "paragraph", children: [] },
        { options: {}, renderBlock: () => "", renderInline: () => "" },
      ),
    ).toBeUndefined();
  });

  test("promptFigure is the one meta → label rule", () => {
    expect(promptFigure("You are onboarding")).toBe(
      codeBlockFigure("text", "You are onboarding", "Copy onboarding prompt"),
    );
  });
});

type Listener = (event?: unknown) => unknown;

function installStubDom(codeText: string, clipboard: boolean): {
  button: {
    textContent: string;
    fire: (event: string) => Promise<void>;
  };
  status: { textContent: string };
  written: string[];
  selected: { node: unknown };
  timeouts: (() => void)[];
} {
  const listeners: Record<string, Listener[]> = {};
  const button = {
    textContent: "Copy",
    closest: () => figure,
    addEventListener: (event: string, fn: Listener): void => {
      (listeners[event] ??= []).push(fn);
    },
    fire: async (event: string): Promise<void> => {
      for (const fn of listeners[event] ?? []) await fn();
    },
  };
  const code = { textContent: codeText };
  const figure = { querySelector: () => code };
  const status = { textContent: "" };
  const written: string[] = [];
  const selected: { node: unknown } = { node: null };
  const timeouts: (() => void)[] = [];
  const sandboxDocument = {
    querySelector: (selector: string) =>
      selector === ".codeblock-status" ? status : null,
    querySelectorAll: (selector: string) =>
      selector === "button.codeblock-copy" ? [button] : [],
    createRange: () => ({
      selectNodeContents: (node: unknown) => {
        selected.node = node;
      },
    }),
  };
  const sandboxWindow = {
    getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    setTimeout: (fn: () => void) => {
      timeouts.push(fn);
      return 0;
    },
  };
  const sandboxNavigator = clipboard
    ? { clipboard: { writeText: async (value: string) => { written.push(value); } } }
    : {};
  const run = new Function(
    "document",
    "window",
    "navigator",
    `${codeBlockScript}\n`,
  );
  run(sandboxDocument, sandboxWindow, sandboxNavigator);
  return { button, status, written, selected, timeouts };
}

describe("codeBlockScript", () => {
  test("copies the exact block text with a transient Copied state", async () => {
    const { button, status, written, timeouts } = installStubDom(
      "hello <world> & friends",
      true,
    );
    await button.fire("click");
    expect(written).toEqual(["hello <world> & friends"]);
    expect(button.textContent).toBe("Copied");
    expect(status.textContent).toBe("Code block copied");
    for (const timeout of timeouts.splice(0)) timeout();
    expect(button.textContent).toBe("Copy");
    await button.fire("click");
    await button.fire("blur");
    expect(button.textContent).toBe("Copy");
  });

  test("selects the text and says so without a clipboard API", async () => {
    const { button, status, written, selected } = installStubDom("x", false);
    await button.fire("click");
    expect(written).toEqual([]);
    expect(selected.node).not.toBeNull();
    expect(button.textContent).toBe("Selected");
    expect(status.textContent).toContain("Clipboard unavailable");
  });
});
