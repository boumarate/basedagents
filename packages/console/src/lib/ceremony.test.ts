import { describe, it, expect } from 'vitest';
import { verifyArmedAction } from './ceremony.js';
import { actionChallenge } from './action.js';
import { accountKeyFromOwnerId } from './owner.js';

const OWNER = 'ow_TestOwnerKeyB58';

/** Build a begin-response the way the control plane does (canonical → hash). */
function arm(canonicalObj: Record<string, unknown>, nonce = 'n-1') {
  const action_canonical = JSON.stringify(canonicalObj);
  return { challenge: actionChallenge(action_canonical), nonce, action_canonical };
}

describe('verifyArmedAction — client-side WYSIWYS', () => {
  const params = { agent_id: 'ag_x', label: null };
  const good = arm({ action_type: 'create_delegation', owner_id: OWNER, nonce: 'n-1', ...params });

  it('accepts a canonical that says exactly what we asked for', () => {
    expect(() =>
      verifyArmedAction(good, { actionType: 'create_delegation', ownerId: OWNER, params }),
    ).not.toThrow();
  });

  it('rejects a challenge that is not the hash of the returned canonical', () => {
    const tampered = { ...good, challenge: actionChallenge('something else') };
    expect(() =>
      verifyArmedAction(tampered, { actionType: 'create_delegation', ownerId: OWNER, params }),
    ).toThrow(/does not match the action/);
  });

  it('rejects a swapped action type (hash valid, content wrong)', () => {
    const swapped = arm({ action_type: 'revoke_delegation', owner_id: OWNER, nonce: 'n-1', ...params });
    expect(() =>
      verifyArmedAction(swapped, { actionType: 'create_delegation', ownerId: OWNER, params }),
    ).toThrow(/action type/);
  });

  it('rejects an action naming a different owner', () => {
    const other = arm({ action_type: 'create_delegation', owner_id: 'ow_evil', nonce: 'n-1', ...params });
    expect(() =>
      verifyArmedAction(other, { actionType: 'create_delegation', ownerId: OWNER, params }),
    ).toThrow(/different owner/);
  });

  it('rejects a nonce mismatch between the ceremony and the canonical', () => {
    const drift = arm({ action_type: 'create_delegation', owner_id: OWNER, nonce: 'n-OTHER', ...params });
    // begin.nonce says n-1 but the canonical (and thus the signed hash) says n-OTHER.
    expect(() =>
      verifyArmedAction({ ...drift, nonce: 'n-1' }, { actionType: 'create_delegation', ownerId: OWNER, params }),
    ).toThrow(/nonce/);
  });

  it('rejects swapped params — the attack this check exists for', () => {
    // The console asked to delegate to ag_x; the canonical delegates to ag_evil.
    const swapped = arm({ action_type: 'create_delegation', owner_id: OWNER, nonce: 'n-1', agent_id: 'ag_evil', label: null });
    expect(() =>
      verifyArmedAction(swapped, { actionType: 'create_delegation', ownerId: OWNER, params }),
    ).toThrow(/differs from what you requested/);
  });

  it('rejects extra fields smuggled into the canonical', () => {
    const smuggled = arm({ action_type: 'create_delegation', owner_id: OWNER, nonce: 'n-1', ...params, scope: '*' });
    expect(() =>
      verifyArmedAction(smuggled, { actionType: 'create_delegation', ownerId: OWNER, params }),
    ).toThrow(/differs from what you requested/);
  });
});

describe('accountKeyFromOwnerId', () => {
  it('strips the ow_ prefix (owner id carries the account key)', () => {
    expect(accountKeyFromOwnerId('ow_ABCxyz123')).toBe('ABCxyz123');
  });
  it('rejects non-owner ids', () => {
    expect(() => accountKeyFromOwnerId('ag_ABCxyz123')).toThrow(/not an owner id/);
    expect(() => accountKeyFromOwnerId('ow_')).toThrow(/not an owner id/);
  });
});
