/**
 * SDK CLI — loadKeypair behavior tests (NEW-2)
 *
 * Tests the keypair serialization/deserialization used by the CLI,
 * simulating the multi-keypair selection logic from wallet.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateKeypair, serializeKeypair, deserializeKeypair, publicKeyToAgentId, base58Encode } from '../index.js';
import { isKeypairPath, loadKeypair, resolveKeypairPath, prepareNewKeypairPath, stageNewKeypair, commitNewKeypair, discardNewKeypair } from './wallet.js';

describe('loadKeypair — keypair round-trip (NEW-2)', () => {
  it('generates a valid keypair', async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it('serialize → deserialize round-trip produces same keys', async () => {
    const kp = await generateKeypair();
    const serialized = serializeKeypair(kp);
    const restored = deserializeKeypair(serialized);

    expect(restored.publicKey).toEqual(kp.publicKey);
    expect(restored.privateKey).toEqual(kp.privateKey);
  });

  it('serialized keypair is valid JSON with publicKey and privateKey fields', async () => {
    const kp = await generateKeypair();
    const serialized = serializeKeypair(kp);
    const parsed = JSON.parse(serialized) as { publicKey: string; privateKey: string };
    expect(typeof parsed.publicKey).toBe('string');
    expect(typeof parsed.privateKey).toBe('string');
    expect(parsed.publicKey.length).toBe(64); // 32 bytes as hex = 64 chars
    expect(parsed.privateKey.length).toBe(64);
  });

  it('deserialize throws on invalid JSON', () => {
    expect(() => deserializeKeypair('not-json')).toThrow();
  });

  it('deserialize throws on missing keys', () => {
    expect(() => deserializeKeypair(JSON.stringify({}))).toThrow();
  });

  it('two different keypairs have different agent IDs', async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const id1 = publicKeyToAgentId(kp1.publicKey);
    const id2 = publicKeyToAgentId(kp2.publicKey);
    expect(id1).not.toBe(id2);
  });
});

describe('deserializeKeypair — legacy shape (public_key_b58 / private_key_hex)', () => {
  /** The legacy file shape written by the Python SDK, the MCP server and scripts/register-*.mjs. */
  function legacyFile(kp: { publicKey: Uint8Array; privateKey: Uint8Array }): string {
    const { privateKey } = JSON.parse(serializeKeypair(kp)) as { privateKey: string };
    return JSON.stringify({
      agent_id: publicKeyToAgentId(kp.publicKey),
      public_key_b58: base58Encode(kp.publicKey), // base58, NOT hex — decoded with base58Decode
      private_key_hex: privateKey,
    });
  }

  it('deserializes a legacy file to the same key bytes as the generated keypair', async () => {
    const kp = await generateKeypair();
    const restored = deserializeKeypair(legacyFile(kp));
    expect(restored.publicKey).toEqual(kp.publicKey);
    expect(restored.privateKey).toEqual(kp.privateKey);
  });

  it('throws an error naming both accepted formats on an unrecognized shape', () => {
    let message = '';
    try { deserializeKeypair(JSON.stringify({ some: 'other', shape: true })); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('publicKey');       // the SDK hex shape
    expect(message).toContain('public_key_b58');  // the legacy shape
  });

  it('loadKeypair reads a legacy-shape file given as a --keypair path (the path that was broken)', async () => {
    const kp = await generateKeypair();
    const dir = mkdtempSync(join(tmpdir(), 'ba-keys-'));
    const file = join(dir, 'hans-keypair.json');
    writeFileSync(file, legacyFile(kp));
    try {
      const loaded = loadKeypair(file);
      expect(loaded.publicKey).toEqual(kp.publicKey);
      expect(loaded.privateKey).toEqual(kp.privateKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadKeypair — multi-keypair selection logic (NEW-2)', () => {
  /**
   * Simulate the loadKeypair() file-selection logic from wallet.ts:
   * - Sort files alphabetically
   * - Use the last (most recent) one
   * - Warn if multiple exist
   */
  function simulateKeypairSelection(files: string[]): {
    selectedFile: string;
    warned: boolean;
  } {
    const keypairFiles = files.filter(f => f.endsWith('-keypair.json'));
    if (keypairFiles.length === 0) throw new Error('No keypairs found');

    const warned = keypairFiles.length > 1;
    const selectedFile = keypairFiles[keypairFiles.length - 1]; // last alphabetical
    return { selectedFile, warned };
  }

  it('selects the only keypair when one file exists', () => {
    const { selectedFile, warned } = simulateKeypairSelection(['my-agent-keypair.json']);
    expect(selectedFile).toBe('my-agent-keypair.json');
    expect(warned).toBe(false);
  });

  it('selects last alphabetical keypair when multiple files exist', () => {
    const files = [
      'agent-a-keypair.json',
      'agent-b-keypair.json',
      'agent-c-keypair.json',
    ];
    const { selectedFile, warned } = simulateKeypairSelection(files);
    expect(selectedFile).toBe('agent-c-keypair.json');
    expect(warned).toBe(true);
  });

  it('warns when multiple keypairs found (NEW-2)', () => {
    const { warned } = simulateKeypairSelection(['a-keypair.json', 'b-keypair.json']);
    expect(warned).toBe(true);
  });

  it('does not warn when only one keypair found', () => {
    const { warned } = simulateKeypairSelection(['only-keypair.json']);
    expect(warned).toBe(false);
  });

  it('throws when no keypair files found', () => {
    expect(() => simulateKeypairSelection([])).toThrow('No keypairs found');
    expect(() => simulateKeypairSelection(['readme.txt', 'config.json'])).toThrow('No keypairs found');
  });

  it('ignores non-keypair files', () => {
    const files = ['readme.txt', 'my-keypair.json', 'config.json', 'notes.md'];
    const { selectedFile } = simulateKeypairSelection(files);
    expect(selectedFile).toBe('my-keypair.json');
  });
});

describe('resolveKeypairPath — which file a signed command uses', () => {
  const keysDir = join(homedir(), '.basedagents', 'keys');

  it('treats Windows drive, UNC and backslash-relative paths as paths, not names in the keys directory', () => {
    // A first-task report: a backslash path was joined onto the keys directory,
    // giving C:\Users\me\.basedagents\keys\C:\Users\me\... (ENOENT).
    for (const p of [
      'C:\\Users\\me\\.basedagents\\keys\\me-keypair.json',
      'C:/Users/me/.basedagents/keys/me-keypair.json',
      '\\\\server\\share\\me-keypair.json',
      '.\\me-keypair.json',
      'keys\\me-keypair.json',
      '/home/me/.basedagents/keys/me-keypair.json',
      './me-keypair.json',
    ]) {
      expect(isKeypairPath(p), p).toBe(true);
      expect(resolveKeypairPath(p, {})).toBe(p);
    }
  });

  it('resolves a bare filename inside ~/.basedagents/keys/', () => {
    expect(isKeypairPath('me-keypair.json')).toBe(false);
    expect(resolveKeypairPath('me-keypair.json', {})).toBe(join(keysDir, 'me-keypair.json'));
  });

  it('uses BASEDAGENTS_KEYPAIR_PATH when --keypair is not given', () => {
    const file = '/profiles/jobs/home/.basedagents/keys/jobs-keypair.json';
    expect(resolveKeypairPath(undefined, { BASEDAGENTS_KEYPAIR_PATH: file })).toBe(file);
    expect(resolveKeypairPath(undefined, { BASEDAGENTS_KEYPAIR_PATH: `  ${file}\n` })).toBe(file);
  });

  it('--keypair wins over BASEDAGENTS_KEYPAIR_PATH', () => {
    expect(resolveKeypairPath('/a/flag-keypair.json', { BASEDAGENTS_KEYPAIR_PATH: '/b/env-keypair.json' })).toBe('/a/flag-keypair.json');
  });

  it('an empty BASEDAGENTS_KEYPAIR_PATH falls through to the keys directory', () => {
    let result: string | Error;
    try { result = resolveKeypairPath(undefined, { BASEDAGENTS_KEYPAIR_PATH: '  ' }); } catch (e) { result = e as Error; }
    // Either the last key in ~/.basedagents/keys/ or "No keypairs found in <that dir>": never the blank value.
    if (result instanceof Error) expect(result.message).toContain(keysDir);
    else expect(result.startsWith(keysDir)).toBe(true);
  });

  it('loadKeypair reads the file BASEDAGENTS_KEYPAIR_PATH names', async () => {
    const kp = await generateKeypair();
    const dir = mkdtempSync(join(tmpdir(), 'ba-env-keys-'));
    const file = join(dir, 'jobs-keypair.json');
    writeFileSync(file, serializeKeypair(kp));
    const prev = process.env.BASEDAGENTS_KEYPAIR_PATH;
    process.env.BASEDAGENTS_KEYPAIR_PATH = file;
    try {
      expect(loadKeypair().publicKey).toEqual(kp.publicKey);
    } finally {
      if (prev === undefined) delete process.env.BASEDAGENTS_KEYPAIR_PATH; else process.env.BASEDAGENTS_KEYPAIR_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prepareNewKeypairPath + stage/commit — where registration saves a new key', () => {
  let home: string;
  afterEach(() => {
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    if (home && existsSync(home)) { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); }
    home = '';
  });
  const tempHome = () => { home = mkdtempSync(join(tmpdir(), 'ba-home-')); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); return home; };

  it('saves to BASEDAGENTS_KEYPAIR_PATH when it names no file yet, creating its directory', () => {
    const h = tempHome();
    const target = join(h, 'profiles', 'jobs', 'jobs-keypair.json');
    const { path, envInUse } = prepareNewKeypairPath('jobs', { BASEDAGENTS_KEYPAIR_PATH: target });
    expect(path).toBe(target);
    expect(envInUse).toBeUndefined();
    const staged = stageNewKeypair(path, '{"k":1}');
    expect(commitNewKeypair(staged, path, 'jobs')).toBe(target);
    expect(existsSync(staged)).toBe(false);
    // ...so the id / signed-command lookup (which prefers the variable) finds it.
    expect(resolveKeypairPath(undefined, { BASEDAGENTS_KEYPAIR_PATH: target })).toBe(target);
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('uses the keys directory, numbered past existing files, and reports a variable that already names a key', () => {
    const h = tempHome();
    const keys = join(h, '.basedagents', 'keys');
    const existing = join(h, 'existing-keypair.json');
    writeFileSync(existing, '{}');
    const first = prepareNewKeypairPath('hans', { BASEDAGENTS_KEYPAIR_PATH: existing });
    expect(first).toEqual({ path: join(keys, 'hans-keypair.json'), envInUse: existing });
    writeFileSync(first.path, '{}');
    expect(prepareNewKeypairPath('hans', {}).path).toBe(join(keys, 'hans-2-keypair.json'));
  });

  it('the staged file is on disk before registration and invisible to the keypair lookup', () => {
    const h = tempHome();
    const path = prepareNewKeypairPath('solo', {}).path;
    const staged = stageNewKeypair(path, '{"k":1}');
    expect(readFileSync(staged, 'utf8')).toBe('{"k":1}');
    expect(readdirSync(join(h, '.basedagents', 'keys')).filter((f) => f.endsWith('-keypair.json'))).toEqual([]);
    discardNewKeypair(staged);
    expect(existsSync(staged)).toBe(false);
  });

  it('never replaces a file: one that appeared since the path was chosen sends the key to the keys directory', () => {
    const h = tempHome();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const raced = join(h, 'raced-keypair.json');
    const staged = stageNewKeypair(raced, '{"new":true}');
    writeFileSync(raced, 'someone else');
    const landed = commitNewKeypair(staged, raced, 'raced');
    expect(readFileSync(raced, 'utf8')).toBe('someone else');
    expect(landed).toBe(join(h, '.basedagents', 'keys', 'raced-keypair.json'));
    expect(readFileSync(landed, 'utf8')).toBe('{"new":true}');
  });

  it('keeps the staged file when nothing else is writable, so a registered key is never lost', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // permission bits don't bind here
    const h = tempHome();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = join(h, 'jobs');
    const target = prepareNewKeypairPath('jobs', { BASEDAGENTS_KEYPAIR_PATH: join(dir, 'jobs-keypair.json') }).path;
    const staged = stageNewKeypair(target, '{"only":"copy"}');
    writeFileSync(target, 'raced');           // the final name is taken
    chmodSync(h, 0o500);                      // and ~/.basedagents/keys/ can't be created
    const landed = commitNewKeypair(staged, target, 'jobs');
    expect(landed).toBe(staged);
    expect(readFileSync(staged, 'utf8')).toBe('{"only":"copy"}');
  });
});
