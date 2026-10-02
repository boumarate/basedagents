#!/usr/bin/env node
/**
 * Clean-container smoke test for the published `basedagents` package.
 *
 * Unit tests run against the source tree, so nothing there proves that the
 * PACKED tarball — dist/, bin/, the files whitelist — actually works once it
 * is installed from a registry into a fresh project. This script does:
 *
 *   1. build + `npm pack` the sdk exactly the way publish does;
 *   2. `npm install` the tarball into an empty project under a temp dir;
 *   3. drive the installed bin: --version, the task-board help, and a
 *      registration dry run that never touches the network.
 *
 * Runs in CI (ci.yml "smoke" job) and locally via `npm run smoke`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'ba-smoke-'));
let failed = false;

function log(msg) { process.stdout.write(`smoke: ${msg}\n`); }
function fail(msg) { failed = true; process.stdout.write(`smoke: ✗ ${msg}\n`); }

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function pack(pkgDir) {
  // Build with the SAME script publish uses (`npm pack` does not run
  // prepublishOnly, so we build explicitly first).
  const pkg = JSON.parse(readFileSync(join(ROOT, pkgDir, 'package.json'), 'utf8'));
  const buildScript = pkg.scripts?.['build:dist'] ? 'build:dist' : 'build';
  run('npm', ['run', buildScript], { cwd: join(ROOT, pkgDir) });
  const out = run('npm', ['pack', '--pack-destination', work], { cwd: join(ROOT, pkgDir) });
  const tgz = out.trim().split('\n').pop().trim();
  const full = join(work, tgz);
  if (!existsSync(full)) throw new Error(`pack did not produce ${full}`);
  return full;
}

try {
  log(`workdir ${work}`);
  log('packing basedagents (sdk) …');
  const sdkTgz = pack('packages/sdk');

  // Fresh project that depends only on the published tarball.
  const proj = join(work, 'proj');
  mkdirSync(proj, { recursive: true });
  run('npm', ['init', '-y'], { cwd: proj, stdio: 'ignore' });
  log('installing the tarball into a fresh project …');
  run('npm', ['install', '--no-audit', '--no-fund', sdkTgz], { cwd: proj });

  const sdkBin = join(proj, 'node_modules', 'basedagents', 'bin', 'basedagents.mjs');
  if (!existsSync(sdkBin)) fail(`basedagents bin missing at ${sdkBin}`);

  // 1) basedagents --version
  try {
    const v = run(process.execPath, [sdkBin, '--version'], { cwd: proj }).trim();
    if (/^\d+\.\d+\.\d+/.test(v)) log(`✓ basedagents --version → ${v}`);
    else fail(`basedagents --version returned "${v}"`);
  } catch (e) { fail(`basedagents --version threw: ${e.message}`); }

  // 2) the task-board CLI is wired into the built bin
  try {
    const help = run(process.execPath, [sdkBin, 'tasks', '--help'], { cwd: proj });
    if (/tasks post/.test(help) && /--bounty/.test(help)) log('✓ basedagents tasks --help lists the board commands');
    else fail('basedagents tasks --help does not describe the board commands');
  } catch (e) { fail(`basedagents tasks --help threw: ${e.message}`); }

  // 3) a manifest registration dry run: keypair generation + proof-of-work path
  //    from the packed dist, with no network call (dry runs never POST).
  try {
    const manifest = join(proj, 'smoke.manifest.json');
    writeFileSync(manifest, JSON.stringify({
      name: 'SmokeAgent', description: 'clean-container smoke test agent',
      capabilities: ['summarization'], protocols: ['https'],
    }));
    const out = run(process.execPath, [sdkBin, 'register', '--manifest', manifest, '--dry-run'], { cwd: proj });
    if (/SmokeAgent/.test(out)) log('✓ basedagents register --manifest --dry-run ran from the packed dist');
    else fail(`register dry run produced unexpected output:\n${out.slice(0, 400)}`);
  } catch (e) { fail(`register dry run threw: ${e.message}`); }
} catch (e) {
  fail(`fatal: ${e.message}`);
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failed) {
  process.stdout.write('smoke: FAILED\n');
  process.exit(1);
}
process.stdout.write('smoke: all clean-container checks passed ✓\n');
