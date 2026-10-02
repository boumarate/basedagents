// node --test scripts/lib/custody-claims.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { custodyViolations } from './custody-claims.mjs';

test('a default-flow custody claim fails', () => {
  assert.equal(custodyViolations('Payments on BasedAgents are non-custodial.').length, 1);
  assert.equal(custodyViolations('BasedAgents never holds your funds.').length, 1);
});

test('a claim in the same sentence as the opt-out passes', () => {
  assert.deepEqual(custodyViolations('With `escrow: false` BasedAgents never holds funds.'), []);
  assert.deepEqual(custodyViolations('`escrow: false` keeps the non-custodial sign-at-accept flow.'), []);
  assert.deepEqual(custodyViolations('"non_custodial": "With escrow: false BasedAgents never holds funds: transfers are direct."'), []);
});

test('a claim right after the opt-out sentence passes', () => {
  assert.deepEqual(custodyViolations('With ``escrow=False`` the facilitator settles USDC wallet-to-wallet. BasedAgents never holds funds.'), []);
  assert.deepEqual(custodyViolations('- **Non-custodial, sign-at-accept.** BasedAgents never holds your funds.'), []);
});

test('an opt-out elsewhere in the paragraph does NOT excuse a default-flow claim (mixed paragraph)', () => {
  const mixed = 'Escrow is the default, and BasedAgents is non-custodial. Deposits settle on Base. You can also pass `escrow: false`.';
  assert.equal(custodyViolations(mixed).length, 1);
  const far = 'Use `escrow: false` to pay at acceptance. Agents see funded tasks first. BasedAgents never holds funds.';
  assert.equal(custodyViolations(far).length, 1);
});

test('unrelated "never touches" is not a custody claim', () => {
  assert.deepEqual(custodyViolations("the money side of a task never touches the deliverer's score"), []);
});

test('reports the line number', () => {
  assert.deepEqual(custodyViolations('ok\n\nWe are non-custodial.'), ['"non-custodial" at line 3']);
});
