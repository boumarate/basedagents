/**
 * Custody claims, scoped to default-flow copy (used by check-positioning.mjs).
 *
 * Escrow — the default — is custodial, so "non-custodial" / "never holds funds"
 * may only describe the per-task opt-out. A claim passes only when the opt-out
 * is named in the SAME sentence or the sentence right before it; an opt-out
 * mentioned elsewhere in the paragraph (or after the claim) doesn't excuse it.
 */
export const CUSTODY_CLAIMS = [
  /non-?custodial/gi,
  /never (?:holds|touches)\s+(?:the\s+|your\s+|any\s+|their\s+)?(?:funds|money|usdc|it|them)\b/gi,
];
export const OPT_OUT = /escrow["'`\\]*\s*[:=]\s*(?:false|False)|--no-escrow|sign-at-accept|pay[- ]at[- ]accept|opt(?:s|ed)?[- ]out/i;

// Sentence ends: terminal punctuation (+ closing quotes/markup) then whitespace;
// a list item or a blank line also starts a new sentence.
const BOUNDARY = /[.!?]["'`*_)\]]*\s+|\n\s*\n|\n\s*(?:[-*]|\d+\.)\s+/g;

/** [start, end) offsets of every sentence in `text`. */
function sentences(text) {
  const out = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const end = m.index + m[0].length;
    out.push([start, end]);
    start = end;
  }
  out.push([start, text.length]);
  return out;
}

/** Custody claims in `text` that no adjacent opt-out wording scopes, as `"claim" at line N`. */
export function custodyViolations(text) {
  const spans = sentences(text);
  const out = [];
  for (const re of CUSTODY_CLAIMS) {
    for (const m of text.matchAll(re)) {
      const i = spans.findIndex(([s, e]) => m.index >= s && m.index < e);
      const from = spans[Math.max(0, i - 1)][0];
      const scope = text.slice(from, spans[i][1]);
      if (!OPT_OUT.test(scope)) out.push(`"${m[0]}" at line ${text.slice(0, m.index).split('\n').length}`);
    }
  }
  return out;
}
