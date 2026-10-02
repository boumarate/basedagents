/**
 * Secret redaction (agent-first plan §0.2). Private keys must never reach
 * stdout, logs, transcripts or API responses. The CLI never prints a key; this
 * is the backstop on its diagnostic output: every `tasks` error line (which
 * can echo server messages and user input) passes through redactSecrets.
 * Data outputs (--json results) are printed verbatim, since rewriting a
 * deliverable would corrupt it. The CLI output tests scan every captured line
 * with `containsSecret` against the real key material of their test keypairs.
 *
 * Patterns are deliberately narrow. A bare 0x + 64 hex is also a transaction
 * hash, which the CLI prints on purpose, so it is only redacted when a key-ish
 * label sits right before it.
 */
const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** `"privateKey": "…"`, `private_key_hex=…`, `secret: …` — JSON, env or YAML style. */
const LABELED_SECRET = /(["']?(?:private[_-]?key(?:[_-]?hex)?|privateKey|secret[_-]?key|seed(?:[_-]?phrase)?|mnemonic)["']?\s*[:=]\s*)(["']?)([^"'\s,}]{16,})\2/gi;
/** A labeled 0x-hex key: `key 0x…64`, `PRIVATE_KEY=0x…`. */
const LABELED_HEX_KEY = /((?:private|secret|signing)[_ -]?key\W{0,3})(0x)?[0-9a-fA-F]{64}\b/gi;

export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string): string {
  return text
    .replace(PEM_PRIVATE, REDACTED)
    .replace(LABELED_SECRET, (_m, label: string, q: string) => `${label}${q}${REDACTED}${q}`)
    .replace(LABELED_HEX_KEY, (_m, label: string) => `${label}${REDACTED}`);
}

/**
 * True when `text` contains any encoding of `privateKey` (hex, 0x-hex, base64,
 * base64url) or a PEM private-key block. Used by tests that scan CLI output.
 */
export function containsSecret(text: string, privateKey?: Uint8Array): boolean {
  PEM_PRIVATE.lastIndex = 0;
  if (PEM_PRIVATE.test(text)) return true;
  if (!privateKey) return false;
  const hex = Array.from(privateKey, (b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = typeof Buffer !== 'undefined' ? Buffer.from(privateKey).toString('base64') : btoa(String.fromCharCode(...privateKey));
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const lower = text.toLowerCase();
  return lower.includes(hex) || text.includes(b64.replace(/=+$/, '')) || text.includes(b64url);
}
