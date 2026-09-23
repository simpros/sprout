// HTML text helpers for the published docs site.
//
// One home for escaping and unescaping so shell, codeblock, and assembly
// import from the module that owns them instead of re-exporting sideways.
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
