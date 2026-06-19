/**
 * Reduce a markdown rationale to a single plain-text preview line for the
 * collapsed accordion row (#488). Preview-only — the full markdown still renders
 * in the expanded panel, so nothing is lost. Strips the common inline/block
 * markers a model emits (bullet/heading/blockquote leaders, emphasis + inline
 * code, link/image syntax) and returns the first non-empty resulting line.
 */
export function stripMarkdown(md: string): string {
  // Stop at the first line that survives stripping — most rationales lead with
  // real content, so this avoids stripping every subsequent line needlessly.
  for (const line of md.split('\n')) {
    const stripped = stripLine(line);
    if (stripped.length > 0) return stripped;
  }
  return '';
}

function stripLine(line: string): string {
  let s = line.trim();
  // skip fenced-code fence markers (```lang / ```) — not preview prose. Returning
  // '' lets stripMarkdown fall through to the first real content line instead of
  // surfacing the bare language tag (e.g. 'cs') as the preview.
  if (s.startsWith('```')) return '';
  // skip thematic breaks (---, ***, ___): the block-marker strip below needs a
  // trailing space, so a bare '---' would otherwise survive as the preview line.
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) return '';
  // leading block markers: -, *, +, 1., >, # …
  s = s.replace(/^([-*+]|\d+\.|>|#{1,6})\s+/, '');
  // images ![alt](url) → alt  (before links, since the leading ! would otherwise survive)
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // links [text](url) → text. Known limitation: link text containing a literal ']'
  // (e.g. '[a [b]](url)') doesn't match and surfaces raw — models rarely nest
  // brackets in rationale link text, and this is a cosmetic preview only.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // emphasis / strong / strikethrough / inline-code markers
  s = s.replace(/[*_~`]/g, '');
  return s.trim();
}
