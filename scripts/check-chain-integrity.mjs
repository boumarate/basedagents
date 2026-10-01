#!/usr/bin/env node
/**
 * Chain integrity self-check — the registry verifies its own public hash
 * chain the way an outside verifier would, so a linkage break is OUR page
 * before it is someone else's finding (it was an independent agent's once:
 * Agent18, 2026-09-30, found the dev-era seam now pinned as a checkpoint).
 *
 * For every entry: entry_hash must recompute from the entry's public fields
 * (v2 length-prefixed format, falling back to the pre-migration v1 raw
 * concatenation used by the earliest entries). For every entry above the
 * highest checkpoint: previous_hash must equal the prior entry_hash.
 * Checkpoint rows must carry EXACTLY their pinned entry_hash — history is
 * never rewritten, and this is the alarm if it ever is.
 *
 * Usage: node scripts/check-chain-integrity.mjs [--api https://api.basedagents.ai] [--retries 0] [--delay 15]
 */
import { createHash } from 'node:crypto';

// Pinned checkpoints — keep in lockstep with CHAIN_CHECKPOINTS in
// packages/api/src/crypto/index.ts (pinned here too so this script guards
// the API's served values instead of trusting them).
const CHECKPOINTS = [
  { sequence: 2, entry_hash: '1900d053ff9cd2a0dcd0402b22fd745d866505a52b5599ed4caea2291fb1880d' },
];
const GENESIS = '0'.repeat(64);

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const API = flag('--api', 'https://api.basedagents.ai');
const RETRIES = Number(flag('--retries', '0'));
const DELAY = Number(flag('--delay', '15')) * 1000;

const hexToBytes = (h) => Uint8Array.from(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

function v2Hash(prev, pk, nonce, profile, ts) {
  const e = new TextEncoder();
  const parts = [e.encode(prev), pk, e.encode(nonce), e.encode(profile), e.encode(ts)];
  const data = new Uint8Array(parts.reduce((s, p) => s + 4 + p.length, 0));
  let o = 0;
  for (const p of parts) {
    new DataView(data.buffer).setUint32(o, p.length, false);
    data.set(p, o + 4);
    o += 4 + p.length;
  }
  return sha256hex(data);
}

function v1Hash(prev, pk, nonce, profile, ts) {
  const e = new TextEncoder();
  const parts = [e.encode(prev), pk, e.encode(nonce), e.encode(profile), e.encode(ts)];
  const data = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { data.set(p, o); o += p.length; }
  return sha256hex(data);
}

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function run() {
  const head = await getJson('/v1/chain/latest');
  const height = head.sequence;
  if (!Number.isInteger(height) || height < 1) throw new Error(`bad head sequence: ${height}`);

  const entries = new Map();
  for (let from = 1; from <= height; from += 1000) {
    const page = await getJson(`/v1/chain?from=${from}&to=${Math.min(from + 999, height)}`);
    for (const e of page.entries) entries.set(e.sequence, e);
  }
  if (entries.size !== height) throw new Error(`fetched ${entries.size} entries, head says ${height}`);

  const maxCheckpoint = Math.max(...CHECKPOINTS.map((c) => c.sequence));
  const problems = [];
  let v1Count = 0;

  for (const cp of CHECKPOINTS) {
    const row = entries.get(cp.sequence);
    if (!row) problems.push(`checkpoint seq ${cp.sequence}: row missing`);
    else if (row.entry_hash !== cp.entry_hash) {
      problems.push(`checkpoint seq ${cp.sequence}: entry_hash ${row.entry_hash} != pinned ${cp.entry_hash} — HISTORY CHANGED`);
    }
  }

  for (let seq = 1; seq <= height; seq++) {
    const e = entries.get(seq);
    if (!e) { problems.push(`seq ${seq}: missing`); continue; }
    const pk = hexToBytes(e.public_key);
    const v2 = v2Hash(e.previous_hash, pk, e.nonce, e.profile_hash, e.timestamp);
    if (v2 !== e.entry_hash) {
      const v1 = v1Hash(e.previous_hash, pk, e.nonce, e.profile_hash, e.timestamp);
      if (v1 !== e.entry_hash) { problems.push(`seq ${seq}: entry_hash recomputes under neither v2 nor v1`); continue; }
      v1Count++;
    }
    if (seq > maxCheckpoint) {
      const expectedPrev = seq === 1 ? GENESIS : entries.get(seq - 1)?.entry_hash;
      if (e.previous_hash !== expectedPrev) problems.push(`seq ${seq}: previous_hash ${e.previous_hash} != prior entry_hash ${expectedPrev}`);
    }
  }

  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    throw new Error(`${problems.length} chain integrity problem(s)`);
  }
  console.log(
    `✓ chain integrity: ${height} entries recompute (${v1Count} v1-era, ${height - v1Count} v2); ` +
    `links verified from seq ${maxCheckpoint + 1} to head; ${CHECKPOINTS.length} checkpoint(s) match their pins.`,
  );
}

for (let attempt = 0; ; attempt++) {
  try {
    await run();
    process.exit(0);
  } catch (err) {
    console.error(`attempt ${attempt + 1} failed: ${err.message}`);
    if (attempt >= RETRIES) process.exit(1);
    await new Promise((r) => setTimeout(r, DELAY));
  }
}
