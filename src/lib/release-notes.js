// Release notes come from the tag annotation — this is Markdown, because the same
// text is shown by the GitHub Release. The update window draws them as plain text
// (textContent, no HTML — the notes come from the network and we don't trust markup),
// so the user saw "## English" together with the hashes. Here Markdown
// is reduced to readable plain text: headings without hashes, lists with a bullet,
// emphasis without asterisks.

const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const BULLET_RE = /^(\s*)[-*+]\s+/;
const EMPHASIS_RE = /(\*\*|__)(.+?)\1/g;
const CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\((?:[^)\s]+)(?:\s+"[^"]*")?\)/g;

function formatLine(line) {
  let out = line.replace(HEADING_RE, "").replace(BULLET_RE, "$1• ");
  out = out.replace(LINK_RE, "$1").replace(EMPHASIS_RE, "$2").replace(CODE_RE, "$1");
  return out.trimEnd();
}

export function formatReleaseNotes(body) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    const formatted = formatLine(line);
    // Пустая строка после заголовка не несёт смысла, когда решётки убраны:
    // схлопываем повторы, чтобы заметки не разъезжались на пол-экрана.
    if (!formatted.trim() && !out.length) continue;
    if (!formatted.trim() && !out[out.length - 1].trim()) continue;
    out.push(formatted);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}
