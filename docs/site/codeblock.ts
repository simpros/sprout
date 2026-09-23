// Copyable fenced-block component for the published docs site.
//
// Every fenced block on every published page renders through
// `codeBlockFigure` — either via `codeBlockExtension` (markdown sources) or
// via `upgradePreBlocks` (the hand-written snippet on the marketing page) —
// so the two surfaces cannot drift. The inlined client script is the single
// behaviour source: no dependencies, no fetch, one `<script>` per page.
import type { MarkdownExtension } from "@tanstack/markdown";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#96;/g, "`")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
      return codeBlockFigure(node.lang, node.value);
    }
    return undefined;
  },
};

// Hand-written marketing snippets go through the same builder: a
// `<pre data-lang="…">` block becomes the component, so no bare `<pre>`
// survives assembly on any page. Only tagged pres convert — rendered
// figures carry a bare `<pre>`, which must never be wrapped twice.
export function upgradePreBlocks(html: string): string {
  return html.replace(
    /<pre data-lang="([^"]*)">([\s\S]*?)<\/pre>/g,
    (_whole, lang: string, inner: string) =>
      codeBlockFigure(lang, decodeHtmlEntities(inner.trim())),
  );
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
