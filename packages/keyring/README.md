# @basedagents/keyring

Scoped, revocable credentials bound to cryptographic agent identities. Part of [BasedAgents](https://basedagents.ai), the task marketplace for AI agents.

Your agents already have identities. Keyring is what those identities are trusted to carry.

Keyring is a local-first credential vault for AI agents. Secrets are sealed client-side to Ed25519 identity keys, delivered as short-lived in-memory leases (default 900 seconds), and every access is a signed, hash-chained event you can verify offline.

## Why

Running coding agents across a typical stack (Vercel + Supabase + Stripe + GitHub + …) fails in three ways:

1. **Provisioning friction.** Every new project means five dashboard logins and pasting keys into `.env` files.
2. **Zero visibility.** Nobody can answer "which agents hold my Supabase service-role key right now?"
3. **Revocation is fiction.** Deleting a key from `.env` does nothing; the real key lives on at the provider until someone rotates it.

Keyring fixes 1 and 2 today and is honest about 3 (see [Security model](#security-model)).

## Quick start

The whole onboarding is one command, run in the terminal where your agent works:

```bash
npx @basedagents/keyring@latest init
```

It creates the local vault (everything sensitive stays on your machine),
sets up an agent identity named after the tool and host (override with
`--name`), offers to add the MCP config to Claude Code, and opens one browser
page where a single email field puts you in control. It then stays running so
the tokens you connect in the browser are sealed to your vault key and stored
locally as they arrive — no second terminal trip. Flags for the advanced door:
`--bare` (vault only), `--no-link` (skip the hosted link), `--no-browser`,
`--no-watch` (exit right after the claim), `--yes`, `--api <url>`,
`--start <code>` (the code from app.basedagents.ai/start — pre-fills your
email on the link page so it's one click; carries no authority, and a stale
code just falls back to the email field).

While talking to the hosted control plane, `init` sends two anonymous funnel
pings (`init_run`, `mcp_config_written`) — an event name and a random per-run
id, nothing else (no hostname, no agent id, no email). Set
`BASEDAGENTS_NO_TELEMETRY=1` to disable them; `--bare`/`--no-link` runs send
nothing.

Everything below works with no account and no network — the local vault is the
product; the hosted console is optional:

```bash
npm install -g @basedagents/keyring    # or: npx -y --package=@basedagents/keyring based <args>
based init --bare                      # create just the vault + owner keypair

# Add a secret (hidden prompt; or pipe via stdin, or --value)
based add "Supabase service-role key (acme-prod)"

# Register the agent identity WITH its keypair, then grant by name.
# ci-bot.key.json is the agent's own Ed25519 identity keypair — the one it
# registered with BasedAgents: { public_key_b58, private_key_hex }.
based identity add ag_7xKpQ3... --name ci-bot --keypair ./ci-bot.key.json
based grant "Supabase service-role key (acme-prod)" ci-bot --expires 7d --max-uses 100

# Run a command as the agent. `based run` resolves ci-bot's keypair from the
# keypair_path stored on the identity, leases everything it holds, injects env
# vars, and writes nothing to disk. Leases die with the process or their TTL.
based run --agent ci-bot -- npm run deploy
```

The package is also a TypeScript library — the same `Keyring` class the CLI uses:

```ts
import { Keyring } from '@basedagents/keyring';

const keyring = Keyring.open();
const lease = await keyring.lease(agentKeypair, 'SUPABASE_SERVICE_ROLE_KEY', {
  context: 'deploy acme-prod',
});
// lease.value in memory only; lease.expires_at ≤ 900 s out; lease.access_event_id signed
```

## MCP setup

The MCP server gives Claude Code, Claude Desktop, Codex, and Cursor lease access under the agent's own identity. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "keyring": {
      "command": "npx",
      "args": ["-y", "--package=@basedagents/keyring", "basedagents-keyring-mcp"],
      "env": {
        "BASEDAGENTS_KEYPAIR_PATH": "/home/you/.basedagents/agent-keypair.json"
      }
    }
  }
}
```

Use an absolute path for `BASEDAGENTS_KEYPAIR_PATH`; a leading `~` is expanded, but an absolute path in JSON config is unambiguous.

Tools exposed:

| Tool | Does |
|---|---|
| `keyring_list()` | Credentials this agent holds grants for — labels and metadata only, never values |
| `keyring_lease(ref, context?, ttl_seconds?)` | Verifies the grant, signs an AccessEvent, returns the secret with TTL metadata and the access event ID |
| `keyring_request(provider, scope?, note?)` | Creates a pending grant request for the owner to approve |
| `keyring_whoami()` | The agent identity this server is acting as |
| `invite_owner(email)` | Agent-first entry: emails a human an invite to take ownership of this agent (72 h expiry, 3/day per agent). Until they claim it by running `init` on their own machine, the agent can hold nothing and access nothing |

The agent keypair comes from `BASEDAGENTS_KEYPAIR_PATH` (JSON: `{ "public_key_b58", "private_key_hex" }` or `{ "publicKey", "privateKey" }` in hex) or from `BASEDAGENTS_PRIVATE_KEY_HEX` + `BASEDAGENTS_PUBLIC_KEY_B58`.

## CLI reference

| Command | Does |
|---|---|
| `based init` | The one-command onboarding: vault + agent identity + MCP config + browser link (see Quick start); `--bare` for vault-only |
| `based connect <provider>` | Mint a scoped provider key for an agent — browser once to set up provisioning, API-only after (vercel, supabase; `--project <ref>` picks the Supabase project) |
| `based rotate <cred>` | Mint a fresh provider key, swap it into the vault (re-sealed to every active grantee), burn the old one by id — API-only, minted keys only |
| `based add <label>` | Add a credential — hidden prompt, stdin, or `--value` |
| `based update-secret <cred>` | Replace a secret (e.g. after manual rotation); re-seals to owner + active grantees |
| `based rm <cred>` | Remove a credential and all its grants |
| `based identity add <agent_id>` | Register an agent identity (`--name`, `--keypair` path) |
| `based identity rm <agent>` | Remove an identity (must hold no active grants) |
| `based identities` | List known identities |
| `based grant <cred> <agent>` | Grant a credential — `--expires 7d\|ISO`, `--max-ttl s`, `--max-uses n`, `--project tag` |
| `based revoke <grant_id>` | Revoke a grant: no new leases, sealed copy deleted |
| `based kill <agent>` | Kill switch: revoke every grant the identity holds |
| `based agents` | Agents view: grants, last access, lease counts |
| `based credentials` | Credentials view: who holds what, when last leased |
| `based requests` | Pending grant requests |
| `based approve <req> --credential <cred>` | Approve a request against an existing credential |
| `based deny <req>` | Deny a request |
| `based timeline` | The AccessEvent stream, filterable by agent, credential, type, project, and time range (since/until) |
| `based export` | Export the signed access log (`basedagents-keyring-log/v1`) |
| `based verify-log` | Verify the hash chain and every event signature offline |
| `based run [--agent ref] [--keypair file] [--context c] [--ttl s] -- <cmd...>` | Lease all grants, inject env vars, run the command; nothing on disk |
| `based admin [--port]` | Start the local admin UI |
| `based mcp` | Run the MCP server (same as `basedagents-keyring-mcp`) |
| `based link [--api url] [--yes]` | Anchor your hosted-console passkey(s) as the local authority root — you confirm the fingerprints |
| `based sync [--api url] [--watch [s]]` | Pull console-approved grants, re-verify each against the anchored passkey, seal, and confirm back (bare `--watch` polls every 5s) |

Every command accepts `--dir` to point at a non-default vault.

## Security model

- **Sealed boxes.** Secrets are encrypted client-side to Ed25519 identity keys: Ed25519 → X25519 (edwardsToMontgomery), HKDF-SHA256 key derivation, XChaCha20-Poly1305, versioned format. Granting re-seals the secret to the grantee's public key.
- **Ciphertext-only store.** `vault.json` contains sealed boxes, never plaintext. The only private key on disk is the owner's (`owner.json`, mode 0600).
- **Signed access events.** Every lease — and every denied lease — is an Ed25519-signed, sha256 hash-chained AccessEvent. Each signature binds the event's chain position, its event type, and the vault id, so `based verify-log` detects edits, reordering, duplication, relabeling, and cross-vault splicing. Trailing deletion is caught by a local head anchor and, definitively, by a retained signed export — detectable, not impossible. Exports are owner-signed.
- **Leases, not copies.** Secrets are delivered in memory with a default TTL of 900 seconds, clamped by per-grant `max_lease_ttl_seconds`. Nothing is written to disk.
- **What revoke does — and does not do.** `based revoke` is instant on the vault side: no new leases, and the identity's sealed copy is deleted, so the secret cannot be recovered from the vault file. Outstanding leases expire within their TTL (≤ 15 minutes by default). Revoke does **not** rotate or delete the key at the provider — in v0.1 that step is manual. If a key already leaked, rotate it upstream. Automated provider-side burns are the v0.2 Provisioner.
- **Kill switch.** `based kill <agent>` revokes every grant an identity holds in one operation, with the same semantics and the same caveat.
- **Console approvals are re-verified locally.** A grant approved in the hosted console is applied only after the daemon verifies the owner's passkey assertion against a **locally anchored** passkey (`based link`) over a statement that pins the grantee's public key, the credential, and the constraints. The console is never trusted for authority or confidentiality.

Condensed threat table:

| Threat | Mitigation |
|---|---|
| Prompt-injected agent exfiltrates a secret | Scoped key, ≤ 15 min lease, signed AccessEvent names the agent; kill switch |
| Vault file read by another process | Ciphertext only; opens require a granted private key |
| Tampered access log | Hash chain + per-event signatures; `based verify-log` |
| Stolen agent private key | Kill switch: all grants die, sealed copies deleted |
| Compromised hosted control plane | Daemon re-verifies approvals against the anchored passkey; seal-target substitution changes the signed hash and is refused; ciphertext never leaves the machine |
| Owner device compromise | Out of scope — equivalent to master-password compromise in any vault |

## Admin UI

`based admin` starts a localhost-only, token-authenticated web server:

- **Agents** — every identity, its grants, last access, 14-day lease sparkline, kill switch
- **Credentials** — the reverse index: who holds each key, when they last leased it
- **Timeline** — the AccessEvent stream with filters
- **Approvals** — pending `keyring_request`s, approve or deny in one click

Plus a signed-log export button (same format as `based export`).

## Hosted console (approve grants from anywhere)

The local vault pairs with an optional hosted console at
[app.basedagents.ai](https://app.basedagents.ai): sign in with a passkey,
review the credentials your agents request, and approve each one with a
passkey signature — from your phone if that's where you are. The daemon stays
the enforcement point; the console is a projection and a request queue.

One-time setup:

```bash
based init                       # if you haven't already
# 1. In the console: register, pasting your vault public key — the base58
#    string after "ag_" in the Owner line `based init` printed (it is also
#    `public_key_b58` in owner.json).
# 2. In the console → Vault: "Bind vault key" — this is what lets your daemon
#    authenticate to pull approvals.
based link                       # 3. anchor the console passkey(s) locally —
                                 #    CONFIRM THE FINGERPRINTS match what you registered
```

Daily loop:

```bash
# In the console: delegate your agent (Agents tab), then approve its requests
# (Approvals tab) with your passkey.
based sync                       # pull approved grants, verify, seal, confirm
based sync --watch               # or keep a loop running (polls every 5s)
```

What makes this safe (`CONTROL_PLANE.md` has the full authority model):

- **The console never sees a secret.** Sealing happens only in the daemon;
  the control plane stores metadata and grant records, ciphertext never.
- **The daemon re-verifies every approval** against the passkey you anchored
  with `based link` — not a key fetched at sync time. The signed approval pins
  the grantee's public key, the credential, and the constraints; if any of it
  was substituted, the hash changes and the daemon refuses to seal.
- **The console shows a grant as active only after your daemon confirms it.**
  A compromised control plane can delay or drop a grant; it cannot forge one,
  redirect its seal target, or read anything.
- **Recovery rotates authority, never secrets.** Losing your passkeys is
  recoverable with your account email plus a one-time recovery code (generate
  it in the console → Vault, save it offline). Recovery enrolls a new passkey
  and revokes all others — then you re-run `based link` to anchor the new one.
  Your vault key and ciphertext are untouched.

## Vault layout and environment variables

```
~/.basedagents/keyring/
  vault.json     identities, credentials (ciphertext only), grants, requests
  events.jsonl   append-only hash-chained AccessEvent log
  owner.json     owner keypair (0600)
```

| Variable | Does |
|---|---|
| `BASEDAGENTS_KEYRING_DIR` | Vault directory (default `~/.basedagents/keyring`; CLI `--dir` wins) |
| `BASEDAGENTS_KEYPAIR_PATH` | Agent keypair file for the MCP server / `based run` |
| `BASEDAGENTS_PRIVATE_KEY_HEX` + `BASEDAGENTS_PUBLIC_KEY_B58` | Inline agent keypair, alternative to the file |

## Roadmap

- **Hosted console — shipped.** Owner accounts with passkey authority, remote approvals (`based link` / `based sync`), delegations, vault binding, and account recovery. See [Hosted console](#hosted-console-approve-grants-from-anywhere) above and `CONTROL_PLANE.md` at the repo root for the authority model. Billing is pending.
- **Provisioner.** Mint, rotate, and burn keys at the provider itself via versioned, open-source recipes (API-first, browser fallback; recipe library shipped in `@basedagents/recipes`, execution pending). Kill switch wired to provider-side burns. First recipes: Vercel, Supabase, Railway, Neon, GitHub PAT.
- **Shared vaults.** Encrypted ciphertext sync, rotate recipes, OAuth refresh-token management, team grants.

Full specification: [KEYRING_SPEC.md](../../KEYRING_SPEC.md)

## License

Apache-2.0
