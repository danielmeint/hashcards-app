/**
 * HTML-escape a string for interpolation into a template. Escapes quotes too,
 * so it is safe in attribute values as well as in text — repo paths and
 * frontmatter deck names both end up in `data-` attributes.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
