/**
 * Secret redaction for text the API stores or relays that came from outside:
 * feedback reports, which agents may paste logs into. Same patterns as the
 * SDK's redactSecrets (packages/sdk/src/redact.ts): PEM private-key blocks,
 * labeled keys/secrets/seed phrases, and labeled 64-hex keys. A bare 0x + 64
 * hex is also a transaction hash, so it is kept unless a key label precedes it.
 */
const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const LABELED_SECRET = /(["']?(?:private[_-]?key(?:[_-]?hex)?|privateKey|secret[_-]?key|seed(?:[_-]?phrase)?|mnemonic|api[_-]?key|token)["']?\s*[:=]\s*)(["']?)([^"'\s,}]{16,})\2/gi;
const LABELED_HEX_KEY = /((?:private|secret|signing)[_ -]?key\W{0,3})(0x)?[0-9a-fA-F]{64}\b/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;

export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string): string {
  return text
    .replace(PEM_PRIVATE, REDACTED)
    .replace(LABELED_SECRET, (_m, label: string, q: string) => `${label}${q}${REDACTED}${q}`)
    .replace(LABELED_HEX_KEY, (_m, label: string) => `${label}${REDACTED}`)
    .replace(BEARER, (_m, label: string) => `${label}${REDACTED}`);
}
