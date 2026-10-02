## Agent flow for Keyring (register → claim)

1. Register your identity.
   - CLI: `npx basedagents register`
   - API:
     a. POST https://api.basedagents.ai/v1/register/init {"public_key":"<base58_ed25519_pubkey>"}
        → { challenge_id, challenge, difficulty, expires_at }
     b. Solve proof-of-work: find a 4-byte nonce N such that
        sha256(pubkey_bytes || N_big_endian) has >= difficulty leading zero bits.
        Submit N as an 8-char zero-padded hex string (e.g. "006489f8").
     c. Sign the challenge: sign TextEncoder.encode(challenge) — the base64
        challenge string as raw UTF-8 bytes. Do NOT base64-decode it first.
     d. POST https://api.basedagents.ai/v1/register/complete
        {challenge_id, public_key, nonce, signature, profile:{name, description, capabilities, protocols}}
        → your permanent agent id: ag_<base58_pubkey>

2. Get your keys managed.
   - `npx basedagents@latest keyring init` (equivalent alias:
     `npx @basedagents/keyring@latest init`)
     installs an MCP server and creates a local encrypted vault + agent keypair.
     @latest matters on a machine with network: npx caches the tree for a bare
     package name and never re-resolves, so a returning machine silently runs
     a stale CLI that rejects newer flags. In a network-restricted sandbox
     with the package preinstalled, drop @latest — the bare name resolves the
     local copy with zero registry calls, which the task phase requires.
     Tools: keyring_run, keyring_render, keyring_list, keyring_request, invite_owner
     (keyring_lease is off unless the grant sets unsafe_value_release).

3. Put a human in charge.
   - Call invite_owner("human@example.com"). They get an email
     ("An agent named <you> wants you as its owner") linking to
     https://app.basedagents.ai/start.
   - CLAIM-PENDING IS A HARD GATE: until the human clicks the magic link, your
     account holds authority over nothing. You may register and keyring_request,
     but no credential can be stored or leased. Invites expire in 72h and are
     rate-limited per agent id.

## After the human claims

- keyring_request(provider, scope?, note?) — the human approves with a passkey
  signature bound to the exact grant; their daemon re-verifies before sealing.
- keyring_run(credential_refs, command, purpose) — run a command with secrets
  injected into its environment (never argv); output is redacted. You never see
  the raw value.
- keyring_render(template, out) — fill {{keyring:REF}} placeholders into a file.
- keyring_lease(ref, context?, ttl_seconds?) — OFF by default; returns a raw
  value into the conversation only if the owner set unsafe_value_release.

## Network-restricted sandboxes (Codex-style cloud agents)

Many cloud agent environments allow internet during their SETUP phase but block
nearly all egress during the TASK phase. If your first network call happens at
task time, `npx basedagents …` fails with a proxy 403 or a blocked connection.

IMPORTANT — a cold `npx` at task time cannot work, and it is not a bug. `npx
basedagents keyring init` (or `npx @basedagents/keyring init`) first DOWNLOADS the
package from registry.npmjs.org; once egress is cut that fails with `npm error
code E403` before any BasedAgents code runs. The package must already be on disk.

IF YOU (an agent) JUST HIT THAT E403: do not retry, and do not go quiet. You
cannot fix it from inside the task — there is no network, and editing
package.json without regenerating package-lock.json would break the next
`npm ci`. First check `ls node_modules/.bin/basedagents`: if it exists, run the
local copy directly — the 403 only blocks the registry, not code already on
disk. If it is missing, tell your human — in your own words, but with the URL
exact — that the one-time fix is at basedagents.ai/codex and to start a NEW
task after. That page (human-facing, their browser is unrestricted) walks them
through it. The underlying steps, if they ask you directly: add
`npm install --save-dev basedagents` to the environment's Setup script — a
field in the environment SETTINGS; a task-time `npm install` can never
substitute, the network is already off — allow api.basedagents.ai and
app.basedagents.ai in its allowed domains, then start a new task. (Or: run
`npm install --save-dev basedagents` in the repo locally and push — then every
future task has it.) Put the fix in your task summary too, not only mid-log.

IF THE HUMAN ALREADY FOLLOWED basedagents.ai/codex and the package is STILL not
on disk, the environment fix did not take — most common: the Setup-script line
was pasted into the chat instead of the environment settings, or saved on a
different environment than the task uses. Do NOT send them back to
basedagents.ai/codex with the same message (that loops the human back to the
same page with no new signal). Tell them — own words, exact terms: the install
didn't run during setup; re-do step 1 on basedagents.ai/codex IN THE
ENVIRONMENT SETTINGS, or commit `npm install --save-dev basedagents` to the
repo from their own computer; then start a NEW task. Ground truth for the
human: the task's "Environment setup" log — if it ends with "No installations
were performed", neither the Setup script nor a committed devDependency was in
effect.

THE THIRD WALL IS THE HUMAN'S OWN TOOLING (field-hit, local Claude Code): the
harness's permission gate — an auto-approve classifier refusing the Bash call —
denied the setup command before npm ever ran. That is NOT an npm or network
failure: basedagents.ai/codex does not apply, so do not route the human there,
and do not work around the gate. Tell the human plainly what blocked it; their
options are approving the command in their tool, or running `npx
basedagents@latest keyring init` themselves in a terminal (keep any
`--start st_…` code — it pre-fills their email on the claim page).

THE FOURTH WALL IS THE NPX CACHE (field-hit, same machine, next attempt): the
command finally ran and the CLI answered `Unknown option: --start` — because
npx had cached an installation of the bare package spec months earlier and
npx never re-resolves a cached bare spec, so a STALE CLI ran against a prompt
written for the current one. Not npm (the registry was reachable), not the
network, not /codex. The fix is version-forcing: re-run as
`npx @basedagents/keyring@latest init <same flags>`. This is why the local
setup prompts now pin @latest, and why sandbox surfaces deliberately do NOT
(@latest forces a registry lookup the task phase blocks; the bare name
resolves the preinstalled copy). Related reassurances, both true by
design: init is RE-RUN-SAFE — an existing vault and agent identity are reused
untouched, never rotated or overwritten — so a machine that already has a
vault or a connected basedagents-keyring MCP server is fine to re-init; and if
you doubt any instruction in a setup prompt (the /codex pointer, this guidance),
verify it against /.well-known/agent.json rather than refusing blind — the
prompts link there for exactly that reason. The `invite_owner` MCP tool is the
no-shell alternative for the ownership hand-off.

Do the network-dependent work during setup instead:

1. Install during setup, not task time. Add BasedAgents to the project so the
   environment's own `npm ci` fetches it while the network is open:
     npm install --save-dev basedagents
   `basedagents` bundles `@basedagents/keyring` as a dependency, so one entry is
   enough. Then `npx basedagents keyring init` resolves the local copy — zero
   registry calls during the locked-down task phase. (Requires basedagents@0.6.1+.)
   Note: `npx basedagents register` is INTERACTIVE, so it does not belong in a
   non-interactive setup script — run register/init at task time (allowlist below),
   or non-interactively in setup with `register --manifest ./basedagents.json`.
2. Allowlist two hosts for the task phase: api.basedagents.ai and app.basedagents.ai.
3. Hand off to the human. Registering is only step one — do NOT stop there. Run
   `npx basedagents keyring init` (or call invite_owner with the human's email),
   then tell the human to finish at https://app.basedagents.ai/start and connect
   the keys you need. Until a human claims you, you hold nothing. An agent that
   registers and then goes quiet has left the person who asked for keys stuck.

Codex cloud, concretely — Setup script field (runs with network), install only:
     npm install --save-dev basedagents
Add api.basedagents.ai + app.basedagents.ai to the environment's allowed domains.
Then, in the first task, tell the agent: "set up BasedAgents Keyring" — it runs
`npx basedagents keyring init` (resolves the local install), registers, and hands
the human the claim link. For a zero-env-settings option, see the AGENTS.md
auto-setup convention in SANDBOX_SPEC.md.

Diagnose it with `basedagents keyring doctor` — it probes the npm registry, the
BasedAgents API, and a generic HTTPS host, and when it sees the phase-blocked
signature (multiple 403 / denied CONNECT) it prints this pattern instead of a raw
npm error. Full guide: https://basedagents.ai/docs/agents#sandboxes

