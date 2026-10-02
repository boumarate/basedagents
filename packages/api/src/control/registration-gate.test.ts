/**
 * Passkey registration is FIRST-enrollment only.
 *
 * /register/begin and /register/finish are unauthenticated, and the vault
 * public key they take is derivable from the PUBLIC owner id — so without a
 * gate, anyone who learned an owner id could enroll their own passkey on the
 * account and pass every ceremony. These tests pin the gate shut: an account
 * with an ACTIVE credential refuses new registrations at begin AND (via the
 * guarded insert, however the challenge was armed) at finish; a revoked
 * credential reopens first-enrollment, which is the operator's lost-passkey
 * break-glass. Replacement of a live passkey belongs to recovery alone.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeHarness, Passkey, type Harness } from './agent-testing/test-harness.js';

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => h.teardown());

async function begin(pk: Passkey): Promise<Response> {
  return h.post('/v1/owner/register/begin', { vault_public_key: pk.vaultB58 });
}

async function beginChallenge(pk: Passkey): Promise<string> {
  const res = await begin(pk);
  expect(res.status).toBe(200);
  return ((await res.json()) as { options: { challenge: string } }).options.challenge;
}

async function finish(pk: Passkey, reg: { attestationObject: string; clientDataJSON: string }): Promise<Response> {
  return h.post('/v1/owner/register/finish', { vault_public_key: pk.vaultB58, ...reg });
}

async function activeCredentials(ownerId: string): Promise<Array<{ credential_id: string }>> {
  return h.db.all<{ credential_id: string }>(
    `SELECT credential_id FROM owner_webauthn_credentials WHERE owner_id = ? AND status = 'active'`,
    ownerId,
  );
}

describe('passkey registration gate (first enrollment only)', () => {
  it('enrolls a first passkey, then refuses to arm a second registration for that owner', async () => {
    const pk = await Passkey.create();
    const reg = pk.registration(await beginChallenge(pk));
    expect((await finish(pk, reg)).status).toBe(200);

    const again = await begin(pk);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { message: string }).message).toContain('recovery');
  });

  it('refuses at finish even with a pre-armed challenge (the guarded insert closes the race)', async () => {
    const victim = await Passkey.create();
    // Two challenges armed while the account still has zero credentials —
    // the second is exactly what a racing attacker would hold.
    const c1 = await beginChallenge(victim);
    const c2 = await beginChallenge(victim);
    expect((await finish(victim, victim.registration(c1))).status).toBe(200);

    // A DIFFERENT authenticator finishing against the victim's owner id with
    // the still-valid second challenge must lose at the insert.
    const attacker = await Passkey.create();
    const res = await finish(victim, attacker.registration(c2));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('recovery');

    const creds = await activeCredentials(victim.ownerId);
    expect(creds).toHaveLength(1);
    expect(creds[0].credential_id).toBe(victim.credentialId);
  });

  it('a revoked credential reopens first-enrollment (lost-passkey break-glass)', async () => {
    const pk = await Passkey.create();
    expect((await finish(pk, pk.registration(await beginChallenge(pk)))).status).toBe(200);
    expect((await begin(pk)).status).toBe(409);

    await h.db.run(
      `UPDATE owner_webauthn_credentials SET status = 'revoked', revoked_at = ? WHERE owner_id = ?`,
      h.now(), pk.ownerId,
    );

    // Enrollment opens again, and a NEW authenticator can take the slot.
    const challenge = await beginChallenge(pk);
    const fresh = await Passkey.create();
    expect((await finish(pk, fresh.registration(challenge))).status).toBe(200);

    const creds = await activeCredentials(pk.ownerId);
    expect(creds).toHaveLength(1);
    expect(creds[0].credential_id).toBe(fresh.credentialId);
  });
});
