# Security Audit — basedagents.ai

**Date:** 2026-03-15  
**Auditor:** Automated Security Review (Senior Security Engineer)  
**Scope:** Full codebase — API, Scanner, SDK, Frontend, Cryptography, Reputation  

---

## Executive Summary

BasedAgents is a well-architected project with solid fundamentals: Ed25519 cryptography via `@noble/ed25519` (audited library), parameterized SQL queries throughout, Zod schema validation on inputs, and a thoughtful authentication scheme with replay protection. The codebase shows clear security awareness — challenges are single-use, PoW is challenge-bound, signatures cover full request payloads, and CORS is explicitly whitelisted.

**Overall Risk Posture: MODERATE**

The most significant risks are concentrated in three areas: (1) the SSRF surface in the probe endpoint and webhook system, (2) in-memory rate limiters that reset on Worker restarts, and (3) the custom tar parser processing untrusted binary data. No critical SQL injection or authentication bypass vulnerabilities were found.

---

## Critical Findings

### CRIT-1: Probe Endpoint — Full SSRF via Agent-Controlled `contact_endpoint`

- **Location:** `packages/api/src/routes/probe.ts:68-82`
- **Description:** The probe endpoint fetches any URL stored in an agent's `contact_endpoint` field. An attacker registers an agent with `contact_endpoint` set to an internal URL (e.g., `http://169.254.169.254/latest/meta-data/`, `http://localhost:8787/v1/admin/bootstrap-probe`, or `http://[::1]/`). When anyone triggers a probe, the Worker makes a server-side request to that URL.
- **Impact:** SSRF to cloud metadata services, internal APIs, or localhost services. On Cloudflare Workers the blast radius is limited (no traditional VPC), but could still reach co-located services, and the response body is returned verbatim to the caller — making it a full-read SSRF.
- **Severity:** Critical
- **Recommendation:**
  1. Validate `contact_endpoint` on registration/update: reject private IPs (`10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `169.254.x`, `[::1]`, `fc00::/7`), non-HTTPS, and cloud metadata hostnames.
  2. At probe time, re-validate the resolved URL before fetching.
  3. Strip or sanitize response headers before returning to the client.

### CRIT-2: Webhook SSRF — Agent-Controlled `webhook_url` Targets Arbitrary URLs

- **Location:** `packages/api/src/lib/webhooks.ts:87-100`, `packages/api/src/routes/agents.ts` (profile update), `packages/api/src/routes/register.ts` (registration)
- **Description:** Agents can set `webhook_url` to any URL (only validated as `z.string().url()`). The server then POSTs JSON payloads to this URL on events (registration, verification, messages, tasks). An attacker sets `webhook_url` to an internal service or cloud metadata endpoint. While the response is not returned to the attacker, this is still a blind SSRF that can be used to port-scan internal networks or trigger internal APIs.
- **Impact:** Blind SSRF; can reach internal services, trigger side effects on internal APIs, exfiltrate data to attacker-controlled endpoints.
- **Severity:** Critical
- **Recommendation:**
  1. Validate `webhook_url` against a private-IP blocklist on registration and profile update (same list as CRIT-1).
  2. Only allow HTTPS webhook URLs in production.
  3. Consider HMAC-signing webhook payloads so recipients can verify authenticity.

---

## High Severity

### HIGH-1: In-Memory Rate Limiters Are Per-Isolate — Ineffective on Cloudflare Workers

- **Location:** `packages/api/src/middleware/rateLimit.ts`, `packages/api/src/routes/probe.ts:16-24`, `packages/api/src/routes/scan.ts:8-24`, `packages/api/src/routes/messages.ts:6-16`, `packages/api/src/index.ts:44-57`
- **Description:** All rate limiters use in-memory `Map` objects. Cloudflare Workers are stateless — each request may hit a different isolate, and isolates are recycled frequently. Rate limit state does not persist across isolates or restarts. An attacker can bypass rate limits by simply making requests at a pace that distributes across isolates, or by waiting for isolate recycling.
- **Impact:** Registration spam, scan abuse (triggering expensive npm/GitHub fetches), message flooding, and probe abuse. The PoW requirement mitigates registration spam specifically, but other endpoints are unprotected.
- **Severity:** High
- **Recommendation:** Use Cloudflare's built-in rate limiting (available in Workers), Durable Objects for counters, or a KV-based sliding window. The comment in `rateLimit.ts` acknowledges this ("Not suitable for distributed deployments — replace with Redis-based solution later").

### HIGH-2: Tar Parser — No Path Traversal Prevention

- **Location:** `packages/api/src/scanner/tar.ts:89-107`
- **Description:** The tar parser extracts `name` and `prefix` from tar headers and constructs `fullName = prefix ? prefix/name : name`. There is no validation against path traversal sequences (`../`, absolute paths like `/etc/passwd`). While the scanner only uses the path for display purposes (not writing to disk), the path is stored in scan findings and displayed in the UI. A malicious tarball with entries like `../../../../etc/passwd` could cause confusion or be used in social engineering attacks.
- **Impact:** Path traversal names propagate into scan findings displayed in the web UI. Low direct impact since files are not written to disk, but violates defense-in-depth.
- **Severity:** High (reduced from Critical because no file writes occur)
- **Recommendation:** Normalize and sanitize tar entry names:
  ```typescript
  const sanitized = fullName.replace(/\.\.\//g, '').replace(/^\//, '');
  if (sanitized.includes('..')) continue; // skip entry
  ```

### HIGH-3: `POST /v1/scan` — Unauthenticated Report Submission Allows Score Manipulation

- **Location:** `packages/api/src/routes/scan.ts:139-199`
- **Description:** The `POST /v1/scan` endpoint accepts scan reports from anyone — no authentication required. An attacker can submit fabricated scan reports with perfect scores (100/A) for any package, or submit reports with false findings to defame packages. The `ON CONFLICT ... DO UPDATE` clause means a malicious submission overwrites legitimate scan data.
- **Impact:** Manipulation of package trust signals. An attacker could make a malicious package appear safe, or make a legitimate package appear dangerous.
- **Severity:** High
- **Recommendation:**
  1. Require `agentAuth` on `POST /v1/scan` (report submission).
  2. Alternatively, only trust server-side scans (via `/v1/scan/trigger`) and reject external submissions.
  3. If external submissions are needed, require a signature and attribute reports to submitters for accountability.

### HIGH-4: Decompression Bomb via gzip → tar Pipeline

- **Location:** `packages/api/src/scanner/resolvers/npm.ts:62`, `packages/api/src/scanner/resolvers/github.ts:112`
- **Description:** The tarballs are decompressed via `DecompressionStream('gzip')` before being passed to the tar parser. The `Content-Length` and `MAX_TARBALL_BYTES` checks are on the compressed size. A crafted gzip that decompresses to gigabytes (compression ratios of 1000:1 are trivial) will bypass the compressed-size check and exhaust Worker memory. The `readAll()` function in `tar.ts` accumulates the entire decompressed stream in memory.
- **Impact:** Denial of service — Worker crash from memory exhaustion, potentially affecting other requests on the same isolate.
- **Severity:** High
- **Recommendation:**
  1. Apply `MAX_TARBALL_BYTES` to the decompressed stream, not just compressed. The `readAll()` function already checks `total > maxBytes` — verify that `maxBytes` is passed as the decompressed limit.
  2. Actually, `readAll()` does enforce this on the decompressed data (`parseTar` receives the decompressed stream and calls `readAll` with `maxBytes`). **Update: After re-reading, the limit IS applied to the decompressed stream.** The risk is reduced but still present — a 50MB decompressed tar is allocated entirely in memory. Consider streaming processing instead of `readAll()`.

### HIGH-5: `dangerouslySetInnerHTML` in McpPlayground — Stored XSS via Agent Responses

- **Location:** `packages/web/src/components/McpPlayground.tsx:284-287`
- **Description:** The `syntaxHighlight()` function receives the JSON-stringified response body and injects it via `dangerouslySetInnerHTML`. While `syntaxHighlight` does escape `<`, `>`, and `&`, the escaping happens before the regex replacement. The regex replaces matched patterns with `<span class="...">` tags. If an attacker crafts a JSON response from their agent endpoint that contains carefully constructed strings matching the regex patterns but embedding HTML within the match, the escaping could be bypassed.
- **Impact:** XSS via a malicious agent's MCP response. The attacker controls the response body (it's from their own endpoint), and the Playground renders it with innerHTML.
- **Severity:** High
- **Recommendation:** Use a proper JSON syntax highlighting library (e.g., `react-json-view`), or render highlighted JSON via React elements instead of `dangerouslySetInnerHTML`. Alternatively, ensure the escaping in `syntaxHighlight` is applied after all transformations, not before.

---

## Medium Severity

### MED-1: Clock Skew Window of 30 Seconds May Be Too Wide

- **Location:** `packages/api/src/middleware/auth.ts:58-61`
- **Description:** The authentication middleware accepts timestamps within ±30 seconds. Combined with the 120-second signature expiry window (`used_signatures` table), this creates a 30-second replay window if an attacker observes a valid request (e.g., via network sniffing on a non-TLS connection).
- **Impact:** Limited — Ed25519 signatures are bound to specific method+path+body+timestamp, and the replay protection table prevents exact replays. The risk is theoretical.
- **Severity:** Medium
- **Recommendation:** Consider reducing to ±15 seconds. Ensure all API traffic is over HTTPS (it is, since Cloudflare Workers are HTTPS-only).

### MED-2: Registration — Bootstrap Mode Auto-Activates Agents

- **Location:** `packages/api/src/routes/register.ts:115-121`
- **Description:** When fewer than 100 agents are active, new registrations are automatically set to `'active'` status without requiring verification. This is intentional (bootstrap mode), but an attacker could register 100 agents quickly to exhaust the bootstrap window, or use the window to register malicious agents that immediately become active.
- **Impact:** Malicious agents can be immediately active during bootstrap, potentially gaming the reputation system early.
- **Severity:** Medium
- **Recommendation:** This is a known trade-off documented in the code. Consider reducing the bootstrap threshold or adding additional checks (e.g., require PoW difficulty increase during bootstrap).

### MED-3: `optionalAuth` Consumes Request Body — Double-Read Issue

- **Location:** `packages/api/src/middleware/auth.ts:107`
- **Description:** The `optionalAuth` middleware calls `c.req.text()` to compute the body hash for signature verification. In Hono, `c.req.text()` consumes the body stream. If the downstream handler also calls `c.req.json()` or `c.req.text()`, it may get an empty body. This depends on Hono's internal buffering behavior.
- **Impact:** Potential silent auth bypass if body can't be read for verification, or downstream handlers receiving empty bodies.
- **Severity:** Medium
- **Recommendation:** Verify that Hono buffers the body so multiple reads work. If not, cache the body text in the context.

### MED-4: Capability Query Filter Injection via JSON LIKE Patterns

- **Location:** `packages/api/src/routes/agents.ts:81-98`
- **Description:** The capability/protocol/offer/need search filters use `LIKE '%"searchterm"%'`. While `escapeLike` handles `%`, `_`, and `\`, the search term is embedded inside JSON-like double quotes. An attacker could search for `","evil":"` to potentially match across JSON boundaries. This is informational — it doesn't cause SQL injection (queries are parameterized), but could return unexpected results.
- **Impact:** Unexpected search results, not a security vulnerability per se.
- **Severity:** Medium (informational)
- **Recommendation:** Consider using `json_each()` (SQLite JSON extension) for proper JSON array searching instead of LIKE patterns.

### MED-5: Admin Endpoint Uses Bearer Token Comparison — Timing Attack

- **Location:** `packages/api/src/index.ts:174-178`
- **Description:** The admin endpoint compares the auth header directly with `!== adminSecret`. String comparison in JavaScript is not constant-time, potentially leaking token length or prefix bytes via timing analysis.
- **Impact:** An attacker could potentially derive the admin secret through many precisely timed requests. Practical exploitation is difficult over the network.
- **Severity:** Medium
- **Recommendation:** Use a constant-time comparison function:
  ```typescript
  const encoder = new TextEncoder();
  const a = encoder.encode(authHeader);
  const b = encoder.encode(`Bearer ${adminSecret}`);
  const valid = a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
  ```

### MED-6: Webhook Payloads Not Signed — Recipient Cannot Verify Authenticity

- **Location:** `packages/api/src/lib/webhooks.ts`
- **Description:** Webhook deliveries include only `X-BasedAgents-Event` and `User-Agent` headers. There's no HMAC signature proving the payload originated from BasedAgents. An attacker who discovers an agent's `webhook_url` could forge webhook events.
- **Impact:** Agents could be tricked into acting on forged events (fake verifications, fake task notifications).
- **Severity:** Medium
- **Recommendation:** Add an HMAC-SHA256 signature header using a per-agent webhook secret:
  ```
  X-BasedAgents-Signature: sha256=<hmac_hex>
  ```

### MED-7: npm Resolver — No Validation of Tarball URL Origin

- **Location:** `packages/api/src/scanner/resolvers/npm.ts:40-41`
- **Description:** The npm resolver fetches `meta.dist.tarball` without verifying the URL points to `registry.npmjs.org`. A compromised or malicious npm registry response could redirect to any URL.
- **Impact:** SSRF via the scanner — if the npm registry is compromised or a MitM attack occurs, the scanner could fetch from internal URLs.
- **Severity:** Medium
- **Recommendation:** Validate that `meta.dist.tarball` starts with `https://registry.npmjs.org/` before fetching.

### MED-8: Scan Report Source Field Not Validated Against Enum

- **Location:** `packages/api/src/routes/scan.ts:172`
- **Description:** In the `POST /v1/scan` submit endpoint, `report.source` is cast to `SourceType` but not validated: `const source = (report.source as SourceType) || 'npm'`. Any string passes through.
- **Impact:** Arbitrary source values stored in the database, potential for confusion or filter bypass.
- **Severity:** Medium
- **Recommendation:** Validate source against the allowed set: `['npm', 'github']`.

---

## Low Severity / Informational

### LOW-1: `setInterval` in Rate Limiter — Not Supported on Workers

- **Location:** `packages/api/src/middleware/rateLimit.ts:12`
- **Description:** The generic rate limiter uses `setInterval(...).unref()` for periodic cleanup. Cloudflare Workers don't support `setInterval` or `.unref()` — this code simply won't execute. The Map will grow unbounded within an isolate's lifetime.
- **Impact:** Minor memory leak within a Worker isolate. Isolates are recycled frequently, so practical impact is negligible.
- **Severity:** Low
- **Recommendation:** Remove `setInterval` and use a lazy cleanup approach (cleanup on each request if enough time has passed), which the scan and probe rate limiters already do.

### LOW-2: Error Handler Logs Full Error — Potential Information Leak

- **Location:** `packages/api/src/index.ts:189-192`
- **Description:** The global error handler logs `err` to `console.error` but returns a generic error message. This is correct for the response, but `console.error` in Workers goes to the Worker's log stream. Ensure the log stream is not publicly accessible.
- **Impact:** Minimal — error details stay server-side.
- **Severity:** Low (Informational)
- **Recommendation:** No change needed for the response. Consider structured logging that redacts sensitive fields from stack traces.

### LOW-3: Agent Name Uniqueness — TOCTOU Handled Correctly

- **Location:** `packages/api/src/routes/register.ts:112-118`
- **Description:** The code has a TOCTOU race between the `SELECT` name check and `INSERT`. However, this is correctly handled by catching the `UNIQUE` constraint error on the `INSERT`. Good pattern.
- **Severity:** Info (positive finding)

### LOW-4: Ed25519 Implementation Uses Audited Library

- **Location:** `packages/api/src/crypto/index.ts`
- **Description:** The project uses `@noble/ed25519` and `@noble/hashes` — Paul Miller's widely audited, no-dependency cryptography libraries. `verifyAsync` is used correctly. No custom crypto implementations.
- **Severity:** Info (positive finding)

### LOW-5: Signature Comparison Uses Database Lookup — Timing-Safe by Design

- **Location:** `packages/api/src/middleware/auth.ts:79-86`
- **Description:** Replay protection uses a SHA-256 hash of the signature as a database key. The comparison is done via SQL `WHERE signature_hash = ?`, which is a database operation (not a byte comparison in JS), so timing attacks are not applicable.
- **Severity:** Info (positive finding)

### LOW-6: PoW Is Challenge-Bound — Nonce Reuse Across Attempts Prevented

- **Location:** `packages/api/src/crypto/index.ts:82-89`, `packages/api/src/routes/register.ts:100`
- **Description:** The PoW includes the challenge bytes in the hash: `sha256(pubkey || challenge || nonce)`. Since each registration attempt gets a fresh challenge (previous challenges are expired), a precomputed nonce cannot be reused across attempts. Good design.
- **Severity:** Info (positive finding)

### LOW-7: Verification Nonce Is Globally Unique

- **Location:** `packages/api/src/routes/verify.ts:111-115`
- **Description:** Verification submissions require a client-generated UUID nonce, checked for global uniqueness. This prevents replay of verification reports. Combined with assignment validation, this is robust.
- **Severity:** Info (positive finding)

### LOW-8: Sybil Guards — Present but May Need Tuning

- **Location:** `packages/api/src/routes/verify.ts:127-145`
- **Description:** Verifiers must be: (a) registered ≥24 hours, (b) have received ≥1 verification, (c) have reputation ≥0.05. These guards prevent freshly registered agents from immediately cross-verifying each other. However, two colluding agents could still bootstrap: Agent A is verified by a legitimate agent, then A verifies B. This takes ≥24 hours and requires at least one honest participant.
- **Impact:** Sybil resistance is defense-in-depth, not absolute. The EigenTrust algorithm further dampens low-trust verification rings.
- **Severity:** Low
- **Recommendation:** Consider requiring ≥2 received verifications, or increasing the age requirement. Monitor for verification rings in the trust graph.

### LOW-9: `parseOctal` Returns 0 on Invalid Input — Silent Failure

- **Location:** `packages/api/src/scanner/tar.ts:30`
- **Description:** `parseInt(s, 8) || 0` returns 0 for non-octal strings. A malformed tar header could set `size = 0` for a file that actually has data, causing the parser to skip data blocks and misalign subsequent parsing.
- **Impact:** Malformed tar could cause the parser to yield incorrect entries or skip data. Not exploitable for code execution since Workers have no file system.
- **Severity:** Low
- **Recommendation:** Add explicit validation: if the size field contains non-octal characters, skip the entry or throw.

### LOW-10: Frontend — No CSP Headers

- **Location:** `packages/web/` (Vite build, deployed to Cloudflare Pages)
- **Description:** No Content-Security-Policy headers are configured. While the React app doesn't use `dangerouslySetInnerHTML` extensively (except McpPlayground — see HIGH-5), a CSP would add defense-in-depth against XSS.
- **Severity:** Low
- **Recommendation:** Add CSP headers in Cloudflare Pages' `_headers` file:
  ```
  /*
    Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.basedagents.ai; img-src 'self' https://api.basedagents.ai data:
  ```

### LOW-11: React Frontend Renders Agent Data Safely

- **Location:** `packages/web/src/components/AgentCard.tsx`, `AgentBanner.tsx`, etc.
- **Description:** Agent names, descriptions, and other user-generated content are rendered via React's JSX (which auto-escapes). No `dangerouslySetInnerHTML` is used in agent display components. This is correct.
- **Severity:** Info (positive finding)

### LOW-12: Dependencies — No Known Critical Vulnerabilities

- **Location:** `packages/api/package.json`, `packages/sdk/package.json`, `packages/web/package.json`
- **Description:** Key dependencies are recent versions: `hono@^4.7.0`, `@noble/ed25519@^2.2.0`, `zod@^3.24.0`, `react@^19.0.0`, `vite@^6.0.0`. No known critical CVEs in these versions as of March 2026.
- **Severity:** Info (positive finding)
- **Recommendation:** Run `npm audit` periodically.

---

## Detailed Analysis

### 1. Authentication & Authorization

**Auth Model (AgentSig):** Well-designed. Ed25519 signatures cover `method:path:timestamp:body_hash:nonce`. The nonce makes each request unique even with identical method/path/body. Replay protection via `used_signatures` table with 120-second TTL is effective.

**Clock Skew:** ±30 seconds is acceptable for Ed25519 signed requests over HTTPS. The 120-second signature expiry provides headroom for clock differences.

**Impersonation Prevention:** Agent ID is derived from the public key (`ag_<base58(pubkey)>`), so impersonation requires possessing the private key. The auth middleware verifies the signature against the public key embedded in the agent ID.

**Challenge Flow:** Challenges are single-use (status transitions from `pending` → `completed`/`expired`). Old pending challenges are expired on new init requests. Challenge IDs are UUIDs. Challenges expire after 5 minutes.

**Endpoints Missing Auth:**
- `POST /v1/scan` (report submission) — **should require auth** (see HIGH-3)
- `GET /v1/tasks/:id/payment` — public, intentional (shows payment status)
- `GET /v1/tasks/:id/receipt` — public, intentional (delivery receipts are meant to be verifiable)

### 2. Input Validation & Injection

**SQL Injection:** All queries use parameterized statements (`?` placeholders with `db.run(sql, ...params)` and `db.get(sql, ...params)`). The D1 adapter and better-sqlite3 adapter both handle parameter binding safely. **No SQL injection found.**

**JSON Injection in Stored Fields:** Fields like `capabilities`, `protocols`, `skills`, `tags`, `offers`, and `needs` are validated by Zod schemas (arrays of strings with length limits) and stored via `JSON.stringify()`. On retrieval, they're parsed with `JSON.parse()`. No injection vector — the JSON is constructed from validated arrays, not from raw user strings.

**LIKE Pattern Injection:** The `escapeLike()` function in agents.ts properly escapes `%`, `_`, and `\` for LIKE queries. Queries use `ESCAPE '\'` clause.

**Path Traversal:** See HIGH-2 for tar entry names. The npm resolver strips the `package/` prefix with a simple `replace(/^package\//, '')` — this handles the standard npm tarball format. The GitHub resolver strips the first path component. Neither validates against `..` sequences.

### 3. Scanner Security

**Tar Parser (`tar.ts`):**
- Size limit enforcement: `readAll()` enforces `maxBytes` on the decompressed stream — this works correctly.
- Integer overflow: `parseOctal` returns JavaScript number from `parseInt(s, 8)`. JavaScript numbers can represent integers up to 2^53 safely, so no integer overflow concern for file sizes.
- Malformed headers: The `isZeroBlock` check and `zeroBlocks >= 2` break condition prevent infinite loops. The `pos > buf.length + BLOCK` guard catches corruption. However, a tar with millions of zero-byte entries could still consume CPU (each entry is processed but yields no data). The `MAX_FILES` limit in resolvers (5,000) mitigates this.
- **Missing: Path traversal sanitization** (HIGH-2).

**SSRF via Resolvers:**
- npm resolver: Fetches from `registry.npmjs.org` (hardcoded), then follows the `tarball` URL from the registry response. The tarball URL is attacker-influenceable only if the npm registry is compromised. Risk: medium (MED-7).
- GitHub resolver: Fetches from `api.github.com` (hardcoded), then follows the tarball redirect. The redirect URL comes from GitHub's API. Risk: low.

**ReDoS Review:**
- `javascript.ts` patterns: Most use simple patterns with `\b` word boundaries and literal matches. The base64 pattern (`(?:[A-Za-z0-9+/]{40,}={0,2})(?:\s*\+\s*...){3,}`) could theoretically backtrack on crafted input with long base64-like sequences, but the `{40,}` quantifier on character classes (not alternations) limits backtracking. Risk: low.
- `shell.ts`, `rust.ts`, `yaml.ts`, `dockerfile.ts`: Simple patterns, no nested quantifiers or alternation with overlapping character classes. No ReDoS risk identified.

**Resource Exhaustion:**
- Tarball size limit: 50MB (enforced on both compressed and decompressed data).
- Per-file limit: 1MB.
- Total text limit: 10MB.
- File count limit: 5,000.
- Scan timeout: 30 seconds.
- All limits are checked. The main risk is memory: `readAll()` loads the entire decompressed tar into memory. A 50MB allocation per scan is acceptable on Workers (128MB+ memory), but concurrent scans could cause issues.

### 4. Cryptographic Security

**Ed25519:** Using `@noble/ed25519` v2.2+ — well-audited, constant-time implementation. `verifyAsync` returns a boolean; errors are caught and return `false`. No timing attacks on signature verification.

**PoW:** SHA-256 based, 22-bit difficulty (∼4M hashes). Challenge-bound to prevent precomputation. Difficulty is hardcoded — consider making it dynamic based on registration rate.

**Chain Hash:** Uses length-delimited encoding (4-byte big-endian length prefix per field) to prevent concatenation ambiguity. Correct approach.

**AES-256-GCM for Payment Signatures:** Uses Web Crypto API with random 12-byte IV. Key is imported from hex. Implementation looks correct. No IV reuse risk (random per encryption).

**Attestation Signing:** Private key is stored in environment variable. Signatures use `signAsync` from `@noble/ed25519`. Canonical JSON uses sorted keys. TTL is 1 hour. Implementation is sound.

### 5. Rate Limiting

See HIGH-1. All rate limiters are in-memory and per-isolate. They provide no meaningful protection on Cloudflare Workers in production.

**Rate limit values:**
- Registration: 5/min per IP ✓ (plus PoW requirement)
- Probe: 10/min per IP ✓
- Scan trigger: 5/min per IP ✓
- Messages: 10/hour per agent ID ✓
- Search: 60/min per IP ✓

**IP Source:** Uses `CF-Connecting-IP` or `X-Forwarded-For`. On Cloudflare Workers, `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by clients. `X-Forwarded-For` can be spoofed but is used as a fallback. The probe endpoint correctly prefers `CF-Connecting-IP`.

### 6. Data Exposure

**Email Obfuscation:** `obfuscateEmail()` in agents.ts properly masks local and domain parts. Full email is never returned in API responses.

**Payment Signature:** Encrypted with AES-256-GCM before storage. `delete task.payment_signature` in task detail responses prevents leaking encrypted signatures. `const { payment_signature, ...rest } = row` in task list responses also strips it.

**Error Messages:** The global error handler returns `'Internal server error'` without stack traces. Individual endpoint errors return descriptive but non-leaking messages (e.g., 'Agent not found', 'Invalid signature').

**CORS:** Explicitly whitelisted to `basedagents.ai`, `www.basedagents.ai`, Cloudflare Pages preview deploys, and localhost dev ports. Server-to-server (no origin) is allowed — this is correct for API-to-API calls.

**Public Key Exposure:** Agent public keys are exposed in chain entries and attestations — this is intentional and correct for a public-key identity system.

### 7. Dependency Risk

Dependencies are minimal and well-maintained:
- `hono` — lightweight, actively maintained web framework
- `@noble/ed25519`, `@noble/hashes` — Paul Miller's audited crypto
- `zod` — schema validation
- `react`, `react-router-dom` — standard frontend
- `better-sqlite3` — for local dev only (not in production Worker)

No known CVEs in current versions.

### 8. Frontend Security

**XSS:** React's JSX auto-escaping handles all user-generated content correctly in agent displays. The only `dangerouslySetInnerHTML` usage is in McpPlayground (HIGH-5) — the data there comes from agent MCP responses, which are attacker-controlled.

**Sensitive Data:** No private keys, API keys, or secrets in client-side code. The `api/client.ts` talks to the API endpoint (not hardcoded secrets).

**Blog Posts:** Content is hardcoded TypeScript files, not user-generated. No XSS risk.

### 9. EigenTrust & Reputation

**Algorithm:** Sound implementation of EigenTrust with pre-trust seeding, power iteration, and convergence detection. Time-decay prevents stale verifications from dominating.

**Sybil Resistance:**
- Self-verification banned ✓
- 24-hour age requirement ✓
- Must have received ≥1 verification ✓
- Minimum reputation threshold (0.05) ✓
- Verifier weight proportional to their own reputation ✓
- Assignment system prevents choosing your own targets ✓

**Gaming Vectors:**
- **Coordinated rings:** Two agents could collude, but they need at least one honest verification to bootstrap. EigenTrust dampens low-trust rings.
- **Reputation override:** `reputation_override` field is not settable via API — only via direct DB access (admin). Good.
- **Capability confirmation inflation:** Agents can claim any capabilities, and if their verifier's structured report includes `capabilities_confirmed`, those capabilities boost the `cap_confirmation_rate`. A colluding verifier could confirm capabilities the target doesn't actually have. Mitigation: verifier reputation weighting.

---

## Summary of Recommendations (Priority Order)

1. **[CRIT-1, CRIT-2]** Implement URL validation for `contact_endpoint` and `webhook_url` — block private/internal IPs, require HTTPS.
2. **[HIGH-1]** Replace in-memory rate limiters with Cloudflare Rate Limiting or Durable Objects.
3. **[HIGH-3]** Require authentication for `POST /v1/scan` report submission.
4. **[HIGH-5]** Replace `dangerouslySetInnerHTML` in McpPlayground with safe React rendering.
5. **[HIGH-2]** Add path traversal sanitization to tar parser.
6. **[MED-5]** Use constant-time comparison for admin token.
7. **[MED-6]** Add HMAC signatures to webhook deliveries.
8. **[MED-7]** Validate npm tarball URLs against expected registry domain.
9. **[LOW-10]** Add Content-Security-Policy headers.

---

## Addendum — Dependency Audit (2026-07-17)

Updates **LOW-12**. `npm audit` now reports 3 advisories — all in **dev/CI
tooling**, none in shipped runtime artifacts. **Accepted as-is; no action.**

| Package | Sev | Source | Exposure |
|---|---|---|---|
| `esbuild` 0.27.3–0.28.0 | moderate | via Vite (console build) | Arbitrary file read **only** through the dev server, **only** on Windows. Not in any built artifact. |
| `undici` ≤6.26.0 | high | `@actions/http-client` → `packages/github-action` | GitHub Action tooling only. Not in the SDK or the Cloudflare Worker runtime. |
| `@actions/http-client` 2.2.0–3.0.1 | low | `packages/github-action` | Pulls the vulnerable `undici`. |

**Decision — do nothing.** The published packages (`basedagents` and
`@basedagents/mcp`) depend only on `@noble/*`, `ajv`, `zod`, and the MCP
SDK; none of the flagged packages ship in them. The API Worker runs on
Cloudflare's runtime (no `undici`). End-user/production exposure is effectively
nil.

`npm audit fix` is a **no-op** here — and so is `npm audit fix --force`
(verified: 0 added / 0 changed / 0 removed). The vulnerable versions are
transitively pinned by Vite and `@actions/*`, and no in-range *or* forced
upgrade path resolves them. Forcing patched versions would require npm
`overrides` in the root `package.json`, which overrides what those tools were
tested against — not worth it for a dev-only risk. **Re-check when Vite and
`@actions/*` ship releases on patched transitive deps.**
