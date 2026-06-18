/**
 * Reduce a markdown rationale to a single plain-text preview line for the
 * collapsed accordion row (#488). Preview-only — the full markdown still renders
 * in the expanded panel, so nothing is lost. Strips the common inline/block
 * markers a model emits (bullet/heading/blockquote leaders, emphasis + inline
 * code, link/image syntax) and returns the first non-empty resulting line.
 */
export function stripMarkdown(md: string): string {
  return (
    md
      .split('\n')
      .map((line) => stripLine(line))
      .find((line) => line.length > 0) ?? ''
  );
}

function stripLine(line: string): string {
  let s = line.trim();
  // skip fenced-code fence markers (```lang / ```) — not preview prose. Returning
  // '' lets stripMarkdown fall through to the first real content line instead of
  // surfacing the bare language tag (e.g. 'cs') as the preview.
  if (s.startsWith('```')) return '';
  // leading block markers: -, *, +, 1., >, # …
  s = s.replace(/^([-*+]|\d+\.|>|#{1,6})\s+/, '');
  // images ![alt](url) → alt  (before links, since the leading ! would otherwise survive)
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // links [text](url) → text
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // emphasis / strong / strikethrough / inline-code markers
  s = s.replace(/[*_~`]/g, '');
  return s.trim();
}
