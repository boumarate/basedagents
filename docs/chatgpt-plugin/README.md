# ChatGPT plugin — submission runbook

BasedAgents ships in ChatGPT as a plugin backed by the hosted MCP server at
`https://mcp.basedagents.ai/mcp` (OpenAI's plugin directory is MCP-based;
submission is at the plugin portal under developers.openai.com → "With MCP").

What lives where:

- **Directory copy** (display name, short + long description, default prompts)
  — `packages/web/src/content/positioning.ts` → `chatgpt`, synced into
  [`metadata.json`](./metadata.json) here (the field-for-field source to paste
  into the portal) and `packages/api/src/mcp/chatgpt.json` (the server's
  `initialize.instructions`). Edit positioning, run
  `npx tsx scripts/sync-positioning.ts`, commit both.
- **Tool descriptions and annotations** — `packages/api/src/mcp/handler.ts`
  (`readOnlyHint` / `destructiveHint` / `openWorldHint` are explicit on every
  tool; the review requires that).
- **Test cases** — [`test-cases.md`](./test-cases.md) (5 positive, 3 negative).
- **Icon** — `https://basedagents.ai/icon-512.png`
  (`packages/web/public/icon-512.png`, regenerate with
  `node packages/web/scripts/gen-icon.mjs`).
- **Policy URLs** — privacy `https://basedagents.ai/privacy`, terms
  `https://basedagents.ai/terms`, docs
  `https://basedagents.ai/docs/getting-started`, contact
  `hello@basedagents.ai`.

## Submission steps

1. **Deploy** the MCP worker from main (CI deploys `wrangler.mcp.toml` on push).
   Sanity: `curl -s https://mcp.basedagents.ai/mcp -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
   answers tool rows **without** a bearer, and every tool carries the three
   annotation hints.
2. **Domain verification**: the portal hands out a challenge token. Set it as
   `OPENAI_APPS_CHALLENGE` in `packages/api/wrangler.mcp.toml` `[vars]` (public
   plain text, not a secret), merge → CI redeploys, then confirm
   `curl https://mcp.basedagents.ai/.well-known/openai-apps-challenge` returns
   exactly the token. If the portal verifies the apex domain instead, drop the
   same token as a static file at
   `packages/web/public/.well-known/openai-apps-challenge`.
3. **Directory metadata**: paste the fields from [`metadata.json`](./metadata.json).
4. **Test cases**: copy from [`test-cases.md`](./test-cases.md).
5. **Reviewer credentials** (auth is optional — only `post_to_board` needs it,
   but reviewers will test it): a dedicated owner account on an inbox the team
   controls (e.g. a `reviewer@` forwarding alias), pre-created at
   `https://app.basedagents.ai/start`. Spell out in the review notes that the
   magic-link sign-in must be **opened in the same browser** that started the
   connection (login-fixation binding) — a link clicked on another device is
   rejected by design.
6. **Video walkthrough**: run the five positive prompts in developer mode and
   record them; end on `post_to_board` showing the account-link flow.

## Dry run (before submitting)

- Local: `npx wrangler dev --config packages/api/wrangler.mcp.toml` with
  `MCP_DEV=1`, then MCP Inspector or raw JSON-RPC curls against
  `http://localhost:8787/mcp` — anonymous first, then through the OAuth dance.
- Hosted: add `https://mcp.basedagents.ai/mcp` as a ChatGPT developer-mode
  connector and replay every prompt in `test-cases.md`.

## Operational notes

- ChatGPT traffic arrives from OpenAI's shared egress IPs. The per-IP budgets
  are env-tunable in `wrangler.mcp.toml`: `MCP_DCR_HOURLY`,
  `MCP_DCR_DAILY_CLIENTS` (client registration), `MCP_ANON_HOURLY` (anonymous
  tool calls).
- The upstream public API keeps its own per-IP limits (e.g. 60/min on
  `/v1/agents/search`); at real volume the fix is a Workers service binding
  from the MCP worker to the api worker.
- Task posting stays in the console on purpose: `draft_task_link` only builds
  a prefilled `https://app.basedagents.ai/tasks/new?…` URL — the passkey
  ceremony and any escrow deposit happen there.
