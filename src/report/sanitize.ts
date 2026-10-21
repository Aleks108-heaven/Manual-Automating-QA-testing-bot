// A report quotes text that came from the page under test, from tool errors and from a proposer. Page content is data, and
// a page can put anything in it, including terminal control sequences. Printed to a terminal, an escape sequence can move the
// cursor, overwrite earlier lines (a carriage return does the same), hide text or change the title; a bidirectional override
// can make text read differently from what it is. So every report is cleaned once, where it is turned into text, before it is
// printed or stored as report.txt. Line feeds and tabs stay. Everything else that is not printable is replaced by "?".

/**
 * True for a character that must not reach a terminal: the C0 controls except line feed and tab (this takes in ESC and
 * carriage return), DEL and the C1 controls, the line and paragraph separators, and the bidirectional embeddings, overrides
 * and isolates. The ranges are code points, so that this file holds no such character itself.
 */
function isUnsafe(code: number): boolean {
  if (code === 0x0a || code === 0x09) return false;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

export function cleanForTerminal(text: string): string {
  let out = "";
  for (const character of text) out += isUnsafe(character.codePointAt(0) ?? 0) ? "?" : character;
  return out;
}
