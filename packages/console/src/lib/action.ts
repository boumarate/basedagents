import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { bytesToBase64url } from './webauthn.js';

/**
 * Lowercase hex sha256 of a UTF-8 string — the control plane's `sha256hex`
 * (control/routes.ts). Content-bound action types fold this into the action
 * string itself (`board.post:<sha256hex(body)>`, `task.accept:<id>:<sha256hex(note)>`),
 * so the passkey signs a canonical that names the exact bytes being sent.
 */
export function sha256hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}

/**
 * Canonical JSON (RFC 8785 subset): recursively sorts object keys. This MUST
 * match the control plane's `canonicalJsonStringify` (packages/api/src/crypto)
 * byte for byte — the task-create action folds `sha256hex(canonicalJsonStringify
 * (fields))` into its action type, and the server re-derives the same hash from
 * the fields it receives. A drift here makes every post fail WYSIWYS.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) => JSON.stringify(k) + ':' + canonicalJsonStringify((value as Record<string, unknown>)[k]),
    );
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * The action hash a passkey signs: base64url(sha256(utf8(canonical))).
 *
 * This MUST match the control plane's actionChallenge byte for byte — they are
 * the two sides of the same contract (CONTROL_PLANE.md §2.1). The console recomputes it
 * from the server-returned `action_canonical` and refuses to sign unless it
 * equals the server-returned `challenge`: client-side WYSIWYS, so a compromised
 * control plane cannot make the human sign a challenge that does not match the
 * action shown on screen.
 */
export function actionChallenge(canonical: string): string {
  return bytesToBase64url(sha256(new TextEncoder().encode(canonical)));
}
