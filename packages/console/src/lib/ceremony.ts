/**
 * The shared "signatures to act" ceremony (CONTROL_PLANE.md §3), console side.
 *
 * Every mutation runs the same three steps:
 *   1. POST /action/begin with the action type + params → the server arms a
 *      single-use challenge over the canonical action (which folds in the
 *      owner id and a fresh per-ceremony nonce).
 *   2. WYSIWYS verification (pure, tested): re-hash the returned canonical and
 *      require it to equal the challenge, AND parse the canonical to require it
 *      says exactly what the console asked for — same action type, the signed-in
 *      owner, the echoed nonce, and byte-for-byte the params we sent. Nothing
 *      re-verifies these actions downstream, so this client-side check is the
 *      only thing standing between a compromised control plane and the
 *      owner's passkey signing a swapped action.
 *   3. Run the passkey assertion over the (now-verified) challenge.
 *
 * The caller then posts {nonce, assertion} to the action's endpoint, which
 * re-derives the same canonical server-side and verifies.
 *
 * The passkey itself is born at the FIRST action (`ensurePasskey`): "sessions
 * to look, signatures to act" — the browser's creation prompt fires the moment
 * the person first tries to act, which is when it makes sense to them.
 */
import { control } from '../api/control.js';
import type { ActionBeginResponse, OwnerAssertion, OwnerMe } from '../api/types.js';
import { actionChallenge } from './action.js';
import { accountKeyFromOwnerId } from './owner.js';
import { createPasskey, getAssertion } from './webauthn.js';

/**
 * Mint the account's passkey if it has none yet — a no-op once one exists.
 * Call it before any action ceremony on an email-rung session. Returns
 * whether a passkey was minted just now (so the caller can refresh /me).
 */
export async function ensurePasskey(owner: OwnerMe): Promise<boolean> {
  if (owner.has_passkey) return false;
  const accountKey = accountKeyFromOwnerId(owner.owner_id);
  const begin = await control.registerBegin(accountKey, owner.email ?? undefined);
  const reg = await createPasskey(begin.options);
  await control.registerFinish(accountKey, reg);
  return true; // minted just now
}

/** Deep equality over plain JSON values (params are JSON in, JSON out). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) =>
      jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/**
 * Pure WYSIWYS check for a server-armed action. Throws with a human-readable
 * reason when the server's canonical does not say exactly what we asked for.
 */
export function verifyArmedAction(
  begin: Pick<ActionBeginResponse, 'challenge' | 'nonce' | 'action_canonical'>,
  expected: { actionType: string; ownerId: string; params: Record<string, unknown> },
): void {
  if (actionChallenge(begin.action_canonical) !== begin.challenge) {
    throw new Error('Refusing to sign — the server challenge does not match the action it returned.');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(begin.action_canonical) as Record<string, unknown>;
  } catch {
    throw new Error('Refusing to sign — the server returned an unreadable action.');
  }
  const { action_type, owner_id, nonce, ...params } = parsed;
  if (action_type !== expected.actionType) {
    throw new Error(`Refusing to sign — action type is "${String(action_type)}", expected "${expected.actionType}".`);
  }
  if (owner_id !== expected.ownerId) {
    throw new Error('Refusing to sign — the action names a different owner.');
  }
  if (nonce !== begin.nonce) {
    throw new Error('Refusing to sign — the action nonce does not match the ceremony nonce.');
  }
  if (!jsonEqual(params, expected.params)) {
    throw new Error('Refusing to sign — the action content differs from what you requested.');
  }
}

/**
 * Run the full ceremony for `actionType` with `params`. Returns the nonce +
 * assertion the action endpoint expects. Browser-only (passkey prompt).
 */
export async function runAction(
  ownerId: string,
  actionType: string,
  params: Record<string, unknown>,
): Promise<{ nonce: string; assertion: OwnerAssertion }> {
  const begin = await control.actionBegin(actionType, params);
  verifyArmedAction(begin, { actionType, ownerId, params });
  const assertion = await getAssertion({
    challenge: begin.challenge,
    rpId: begin.rpId,
    allowCredentials: begin.allowCredentials,
    timeout: begin.timeout,
  });
  return { nonce: begin.nonce, assertion };
}
