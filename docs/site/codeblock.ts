// Copyable fenced-block component for the published docs site.
//
// Every fenced block on every published page renders through
// `codeBlockFigure` via `codeBlockExtension`, so markdown surfaces cannot
// drift; the marketing page's one static snippet is the same markup written
// by hand. The inlined client script is the single behaviour source: no
// dependencies, no fetch, one `<script>` per page.
import type { MarkdownExtension } from "@tanstack/markdown";
import { escapeHtml } from "./html.ts";

// Meta tag on the assembled prompt fence: the onboarding prompt renders
// through the same extension as every other fence, but keeps its
// distinctive copy label.
export const PROMPT_FENCE_META = "prompt";
export const PROMPT_COPY_LABEL = "Copy onboarding prompt";

export function isPromptFence(node: { meta?: string }): boolean {
  return node.meta?.split(/\s+/).includes(PROMPT_FENCE_META) ?? false;
}

// One markup shape, used everywhere: language label plus a copy button over
// the escaped block text. Untagged fences read as `text`.
export function codeBlockFigure(
  lang: string | undefined,
  code: string,
  copyLabel = "Copy code block",
): string {
  const shown = lang && lang.length > 0 ? lang : "text";
  return [
    `<figure class="codeblock" data-lang="${escapeHtml(shown)}">`,
    `  <div class="codeblock-bar">`,
    `    <span class="codeblock-lang">${escapeHtml(shown)}</span>`,
    `    <button class="codeblock-copy" type="button" aria-label="${escapeHtml(copyLabel)}">Copy</button>`,
    `  </div>`,
    `  <pre><code>${escapeHtml(code)}</code></pre>`,
    `</figure>`,
  ].join("\n");
}

export const codeBlockExtension: MarkdownExtension = {
  name: "codeblock",
  renderHtml(node) {
    if (node.type === "code") {
      const copyLabel = isPromptFence(node) ? PROMPT_COPY_LABEL : undefined;
      return codeBlockFigure(node.lang, node.value, copyLabel);
    }
    return undefined;
  },
};

// The one place the meta → prompt-label rule lives: assembly calls this for
// the embedded prompt figure instead of composing it by hand.
export function promptFigure(prompt: string): string {
  return codeBlockFigure("text", prompt, PROMPT_COPY_LABEL);
}

// Wired once per page by the shell: click copies the sibling `<code>` text,
// the label flips transiently, and the polite live region announces the
// outcome. Without a clipboard API the text is selected instead, and the
// label says so rather than failing silently.
export const codeBlockScript = `(() => {
  const status = document.querySelector(".codeblock-status");
  function announce(message) {
    if (status) status.textContent = message;
  }
  function settle(button, label, message) {
    button.textContent = label;
    announce(message);
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
  }
  function select(code) {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  document.querySelectorAll("button.codeblock-copy").forEach((button) => {
    const figure = button.closest("figure.codeblock");
    const code = figure ? figure.querySelector("pre > code") : null;
    if (!code) return;
    button.addEventListener("blur", () => {
      button.textContent = "Copy";
    });
    button.addEventListener("click", async () => {
      const value = code.textContent || "";
      try {
        if (!navigator.clipboard) throw new Error("no clipboard");
        await navigator.clipboard.writeText(value);
        settle(button, "Copied", "Code block copied");
      } catch {
        select(code);
        settle(button, "Selected", "Clipboard unavailable; code block selected, copy it manually");
      }
    });
  });
})();`;
