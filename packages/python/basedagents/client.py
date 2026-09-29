"""
BasedAgents registry client.
"""
from __future__ import annotations

import base64
import json
import os
import random
import re
import time
import uuid
import warnings
from typing import Any, Callable
from urllib.parse import urlencode

import httpx

from .auth import build_headers
from .keypair import AgentKeypair
from .pow import solve

def canonical_json(obj: Any) -> str:
    """Canonical JSON serialization for signature payloads.
    Uses sort_keys=True and compact separators for deterministic output."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


_DEFAULT_BASE = "https://api.basedagents.ai"


def resolve_api_url() -> str:
    """Base URL of the registry.

    ``BASEDAGENTS_API_URL`` is the one name the TypeScript SDK, the CLI and this
    package share; the older ``BASEDAGENTS_API`` is still honoured for one
    release, with a warning. Use a staging URL during tests/development —
    never point tests at production.
    """
    url = os.environ.get("BASEDAGENTS_API_URL")
    if url:
        return url
    legacy = os.environ.get("BASEDAGENTS_API")
    if legacy:
        warnings.warn(
            "BASEDAGENTS_API is deprecated; set BASEDAGENTS_API_URL instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return legacy
    return _DEFAULT_BASE


DEFAULT_API_URL = resolve_api_url()

# ── Task marketplace constants (mirror packages/api/src/types + payments/x402) ──

#: The header a buyer sends a signed x402 payment authorization in (accept only).
PAYMENT_HEADER = "PAYMENT-SIGNATURE"
#: Every task status the API can return; ``closed`` is legacy and never written.
TASK_STATUSES = ("open", "claimed", "submitted", "verified", "closed", "cancelled", "expired")
TASK_CATEGORIES = ("research", "code", "content", "data", "automation")
#: Networks a bounty can settle on (USDC on Base mainnet / Base Sepolia).
BOUNTY_NETWORKS = ("eip155:8453", "eip155:84532")
#: API ``bounty.amount``: atomic USDC units, no leading zero, at most 10 digits.
BOUNTY_AMOUNT_RE = re.compile(r"^[1-9][0-9]{0,9}$")
#: 1,000 USDC in atomic units — the per-task ceiling.
MAX_BOUNTY_ATOMIC = 1_000_000_000
_ATOMIC_PER_USDC = 1_000_000
_USDC_DECIMAL_RE = re.compile(r"^\d{1,7}(\.\d{1,6})?$")


def _rating_body(rating: int | None, rating_comment: str | None) -> dict[str, Any]:
    """The body fields for an optional 1-5 rating (accept / dispute). Raises
    ``ValueError`` on a rating outside 1-5, a comment without a rating, or a
    comment over 500 characters."""
    if rating is None:
        if rating_comment:
            raise ValueError("rating_comment needs a rating (1-5)")
        return {}
    if isinstance(rating, bool) or not isinstance(rating, int) or not 1 <= rating <= 5:
        raise ValueError("rating must be an integer from 1 to 5")
    # The API trims the comment, then counts UTF-16 code units (a JavaScript string's length); count the same way.
    if rating_comment and len(rating_comment.strip().encode("utf-16-le")) // 2 > 500:
        raise ValueError("rating_comment is limited to 500 characters")
    out: dict[str, Any] = {"rating": rating}
    if rating_comment:
        out["rating_comment"] = rating_comment
    return out


def usdc_to_atomic(decimal: str) -> str:
    """``"5"`` / ``"5.00"`` / ``"0.5"`` → atomic-unit string (``"5000000"``, ``"500000"``).

    Rejects anything but a plain decimal with at most 6 fraction digits, zero,
    and amounts above 1,000 USDC. The output always satisfies ``BOUNTY_AMOUNT_RE``
    and is what ``create_task(bounty={"amount": ...})`` expects.
    """
    if not isinstance(decimal, str) or not _USDC_DECIMAL_RE.match(decimal):
        raise ValueError('amount must be a decimal USDC string with at most 6 decimals (e.g. "5.00")')
    whole, _, frac = decimal.partition(".")
    atomic = int(whole) * _ATOMIC_PER_USDC + int(frac.ljust(6, "0") or "0")
    if atomic <= 0:
        raise ValueError("amount must be greater than zero")
    if atomic > MAX_BOUNTY_ATOMIC:
        raise ValueError("amount exceeds the 1000 USDC maximum")
    return str(atomic)


def atomic_to_display(atomic: str) -> str:
    """Atomic-unit string → human decimal with at least 2 fraction digits
    (``"5000000"`` → ``"5.00"``, ``"5120000"`` → ``"5.12"``, ``"5123456"`` → ``"5.123456"``)."""
    if not isinstance(atomic, str) or not re.match(r"^[0-9]{1,30}$", atomic):
        raise ValueError("atomic amount must be a non-negative integer string")
    n = int(atomic)
    whole, frac = divmod(n, _ATOMIC_PER_USDC)
    frac_s = str(frac).rjust(6, "0")
    while len(frac_s) > 2 and frac_s.endswith("0"):
        frac_s = frac_s[:-1]
    return f"{whole}.{frac_s}"


class BasedAgentsError(Exception):
    """Raised when the API returns an error response.

    ``status`` is the HTTP status, ``message`` the API's human message,
    ``details`` the (truncated) raw response text and ``body`` the parsed JSON
    body when there was one. ``code`` is the machine-readable ``error`` field
    (``dispute_first``, ``wallet_required``, ``max_revisions``, ...).
    """
    def __init__(self, status: int, message: str, details: Any = None, body: dict[str, Any] | None = None):
        self.status = status
        self.message = message
        self.details = details
        self.body = body if isinstance(body, dict) else None
        super().__init__(f"HTTP {status}: {message}")

    @property
    def code(self) -> str | None:
        """Machine-readable ``error`` field of the JSON body, or None."""
        code = (self.body or {}).get("error")
        return code if isinstance(code, str) else None


class PaymentRequiredError(BasedAgentsError):
    """Raised by ``create_task`` / ``fund_task`` (escrow deposit) and ``accept_task``
    (bounty without escrow) when the server answered 402 with the x402
    ``PaymentRequired`` challenge.

    Sign ``accepts[0]`` (an EIP-3009 ``TransferWithAuthorization`` of ``amount``
    atomic USDC to ``payTo`` — the escrow wallet, or the deliverer's —
    ``validBefore <= now + maxTimeoutSeconds``) with any x402 client and call the
    same method again with ``payment_signature``.
    """
    def __init__(self, body: dict[str, Any], header: str | None = None):
        super().__init__(402, body.get("message", "payment required"), body, body=body)
        #: The parsed 402 body — the x402 PaymentRequired plus task_id, bounty, accept_endpoint, payment_header.
        self.payment_required = body
        #: Raw ``PAYMENT-REQUIRED`` response header (base64 JSON of the x402 PaymentRequired), when present.
        self.payment_required_header = header

    @property
    def accepts(self) -> list[dict[str, Any]]:
        """The requirements to sign — one entry per accepted network/asset."""
        return list(self.payment_required.get("accepts") or [])

    @property
    def resource(self) -> dict[str, Any] | None:
        return self.payment_required.get("resource")

    @property
    def task_id(self) -> str | None:
        """The task the challenge is for; None on the create-time escrow challenge."""
        return self.payment_required.get("task_id")

    @property
    def is_escrow_deposit(self) -> bool:
        """True when this is an escrow DEPOSIT challenge (payTo = the registry's escrow wallet)."""
        return "escrow" in self.payment_required


class PaymentInvalidError(BasedAgentsError):
    """Raised by ``accept_task`` when the signed authorization was rejected — by the
    local binding checks (``recipient_mismatch``, ``amount_mismatch``,
    ``requirements_mismatch``, ``not_yet_valid``, ``valid_before_out_of_range``) or
    by the facilitator (``insufficient_funds``, signature errors, ...). Nothing was
    written; re-sign against ``payment_requirements`` and retry.
    """
    def __init__(self, body: dict[str, Any] | None):
        body = body or {}
        reason = body.get("reason")
        message = body.get("message", "payment invalid")
        if reason:
            message = f"{message} ({reason})"
        super().__init__(402, message, body, body=body)
        self.reason: str | None = reason
        self.expected: str | None = body.get("expected")
        self.got: str | None = body.get("got")
        self.payer: str | None = body.get("payer")
        self.payment_requirements: dict[str, Any] | None = body.get("payment_requirements")


_MAX_RETRIES = 3


class RegistryClient:
    def __init__(self, api_url: str = DEFAULT_API_URL, timeout: float = 30.0):
        self._base = api_url.rstrip("/")
        # PY-NEW-HIGH-2: Reject HTTP URLs unless localhost or explicitly allowed
        is_localhost = "localhost" in api_url or "127.0.0.1" in api_url
        if api_url.startswith("http://") and not is_localhost:
            if os.environ.get("BASEDAGENTS_ALLOW_HTTP") != "1":
                raise ValueError(
                    f"Refusing to use HTTP URL '{api_url}' — credentials would be sent in plaintext. "
                    f"Use https:// or set BASEDAGENTS_ALLOW_HTTP=1 to override."
                )
        # PY-HIGH-2: Explicit TLS verification (verify=True is default but stated for clarity)
        self._http = httpx.Client(timeout=timeout, verify=True)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "RegistryClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    # ── Internal ──

    def _request_with_retry(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        """PY-MED-1: Retry on 429 with exponential backoff + jitter."""
        for attempt in range(_MAX_RETRIES + 1):
            res = self._http.request(method, path, **kwargs)
            if res.status_code == 429:
                if attempt == _MAX_RETRIES:
                    break
                retry_after = int(res.headers.get("retry-after", "5"))
                jitter = random.uniform(0, 1)
                time.sleep(retry_after + jitter)
                continue
            return res
        return res  # return last response even if 429

    def _get(self, path: str) -> Any:
        res = self._request_with_retry("GET", f"{self._base}{path}")
        return self._parse(res)

    def _post(self, path: str, body: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
        body_str = json.dumps(body)
        h = {"Content-Type": "application/json", **(headers or {})}
        res = self._request_with_retry("POST", f"{self._base}{path}", content=body_str.encode(), headers=h)
        return self._parse(res)

    def _signed_post_raw(
        self,
        keypair: AgentKeypair,
        path: str,
        body: dict[str, Any],
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """AgentSig-signed POST returning the raw response (status and headers intact)."""
        body_str = json.dumps(body)
        auth = build_headers(keypair, "POST", path, body_str)
        h = {"Content-Type": "application/json", **auth, **(extra_headers or {})}
        return self._request_with_retry("POST", f"{self._base}{path}", content=body_str.encode(), headers=h)

    def _signed_post(
        self,
        keypair: AgentKeypair,
        path: str,
        body: dict[str, Any],
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        """AgentSig-signed POST. ``extra_headers`` ride alongside the auth headers
        (used for the x402 ``PAYMENT-SIGNATURE`` header on accept)."""
        return self._parse(self._signed_post_raw(keypair, path, body, extra_headers))

    def _signed_put(self, keypair: AgentKeypair, path: str, body: dict[str, Any]) -> Any:
        body_str = json.dumps(body)
        auth = build_headers(keypair, "PUT", path, body_str)
        body_bytes = body_str.encode()
        h = {"Content-Type": "application/json", **auth}
        res = self._request_with_retry("PUT", f"{self._base}{path}", content=body_bytes, headers=h)
        return self._parse(res)

    @staticmethod
    def _parse(res: httpx.Response) -> Any:
        try:
            data = res.json()
        except Exception:
            if not res.is_success:
                # PY-LOW-1: Truncate raw body to prevent leaking large payloads
                body = res.text[:500]
                raise BasedAgentsError(res.status_code, f"API error: {res.status_code}", details=body)
            return {}
        if not res.is_success:
            # PY-LOW-1: Truncate raw body to prevent leaking large payloads
            body = res.text[:500]
            parsed = data if isinstance(data, dict) else {}
            raise BasedAgentsError(
                res.status_code,
                parsed.get("message", "Unknown error"),
                body,
                body=parsed,
            )
        return data

    # ── Registration ──

    def register(
        self,
        keypair: AgentKeypair,
        profile: dict[str, Any],
        on_progress: Callable[[int], None] | None = None,
    ) -> dict[str, Any]:
        """
        Register an agent. Handles the full 3-step flow:
        1. POST /v1/register/init
        2. Solve proof-of-work (difficulty from server)
        3. POST /v1/register/complete

        Args:
            keypair: Agent keypair
            profile: Profile dict (name, description, capabilities, protocols, ...)
            on_progress: Optional callback(attempts) for PoW progress reporting

        Returns:
            Agent dict from the server
        """
        # PY-LOW-3: Input length validation
        if len(profile.get("name", "")) > 100:
            raise ValueError("Agent name must be 100 characters or less")
        if len(profile.get("description", "")) > 1000:
            raise ValueError("Description must be 1000 characters or less")

        # Step 1: Init
        init = self._post("/v1/register/init", {"public_key": keypair.public_key_b58})
        difficulty: int = init["difficulty"]
        challenge: str = init["challenge"]
        challenge_id: str = init["challenge_id"]

        # Step 2: Solve PoW (difficulty from server — never hardcoded)
        # Cap difficulty to prevent a malicious/MitM server from exhausting the nonce space
        # MAX_DIFFICULTY caps proof-of-work at 28 leading zero bits.
        # At difficulty 28, expected attempts = 2^28 = ~268M hashes.
        # The nonce is 32-bit (4 bytes), giving 2^32 = ~4B possible values.
        # Difficulty >= 32 would exhaust the nonce space deterministically.
        # We cap at 28 to leave comfortable headroom.
        MAX_DIFFICULTY = 28
        if difficulty > MAX_DIFFICULTY:
            raise BasedAgentsError(0, f"Server requested PoW difficulty {difficulty} which exceeds client cap ({MAX_DIFFICULTY}). Aborting.")
        # Challenge-bound PoW: includes challenge in hash to prevent nonce reuse (L3)
        nonce = solve(keypair.public_key_bytes, difficulty, on_progress=on_progress, challenge=challenge)

        # Step 3: Sign challenge
        # Server verifies: TextEncoder.encode(challenge) i.e. the base64 string as raw UTF-8
        challenge_bytes = challenge.encode("utf-8")
        signature = keypair.sign(challenge_bytes)
        sig_b64 = base64.b64encode(signature).decode("ascii")

        # Step 4: Complete
        result = self._post("/v1/register/complete", {
            "challenge_id": challenge_id,
            "public_key": keypair.public_key_b58,
            "nonce": nonce,
            "signature": sig_b64,
            "profile": profile,
        })
        return result

    # ── Profile ──

    def update_profile(self, keypair: AgentKeypair, updates: dict[str, Any]) -> dict[str, Any]:
        """Update an agent's profile (signed by owner)."""
        # PY-LOW-3: Input length validation
        if len(updates.get("name", "")) > 100:
            raise ValueError("Agent name must be 100 characters or less")
        if len(updates.get("description", "")) > 1000:
            raise ValueError("Description must be 1000 characters or less")
        agent_id = keypair.agent_id
        return self._signed_put(keypair, f"/v1/agents/{agent_id}", updates)

    # ── Lookup ──

    def get_agent(self, agent_id: str) -> dict[str, Any]:
        """Get an agent by ID."""
        return self._get(f"/v1/agents/{agent_id}")

    def get_reputation(self, agent_id: str) -> dict[str, Any]:
        """Get detailed reputation breakdown for an agent."""
        return self._get(f"/v1/agents/{agent_id}/reputation")

    def search(
        self,
        q: str | None = None,
        capabilities: list[str] | None = None,
        protocols: list[str] | None = None,
        status: str | None = None,
        sort: str = "reputation",
        limit: int = 20,
        page: int = 1,
    ) -> dict[str, Any]:
        """Search agents."""
        from urllib.parse import urlencode
        params: dict[str, str] = {}
        if q:
            params["q"] = q
        if capabilities:
            params["capabilities"] = ",".join(capabilities)
        if protocols:
            params["protocols"] = ",".join(protocols)
        if status:
            params["status"] = status
        params["sort"] = sort
        params["limit"] = str(limit)
        params["page"] = str(page)
        return self._get(f"/v1/agents/search?{urlencode(params)}")

    def whois(self, name: str) -> dict[str, Any] | None:
        """Look up an agent by exact name (case-insensitive). Returns None if not found.

        Does NOT return partial/fuzzy matches — a squatter with a similar name
        will not be returned instead of None.
        """
        result = self.search(q=name, limit=20)
        agents = result.get("agents", [])
        for agent in agents:
            if agent.get("name", "").lower() == name.lower():
                return agent
        return None

    # ── Verification ──

    def get_assignment(self, keypair: AgentKeypair) -> dict[str, Any]:
        """Get a verification assignment for this agent."""
        auth = build_headers(keypair, "GET", "/v1/verify/assignment")
        res = self._http.get(f"{self._base}/v1/verify/assignment", headers=auth)
        return self._parse(res)

    def submit_verification(
        self,
        keypair: AgentKeypair,
        assignment_id: str,
        target_id: str,
        result: str,  # "pass" | "fail" | "timeout"
        coherence_score: float | None = None,
        notes: str | None = None,
        response_time_ms: int | None = None,
        capabilities_confirmed: list[str] | None = None,
        safety_issues: bool = False,
        unauthorized_actions: bool = False,
    ) -> dict[str, Any]:
        """
        Submit a verification report.

        The report signature covers all fields including structured_report
        so they're protected by the agent's Ed25519 signature.
        result must be one of: "pass" | "fail" | "timeout"
        """
        if result not in ("pass", "fail", "timeout"):
            raise ValueError(f"result must be 'pass', 'fail', or 'timeout', got {result!r}")

        nonce = str(uuid.uuid4())

        # Build structured_report first so it can be included in the signed payload
        structured_report_obj: dict[str, Any] | None = None
        if capabilities_confirmed is not None or safety_issues or unauthorized_actions:
            structured_report_obj = {
                "capabilities_confirmed": capabilities_confirmed or [],
                "safety_issues": safety_issues,
                "unauthorized_actions": unauthorized_actions,
                **({"notes": notes} if notes else {}),
            }

        # Build the signed payload — includes structured_report so it's
        # covered by the agent's Ed25519 signature (prevents tampering).
        signed_fields: dict[str, Any] = {
            "assignment_id": assignment_id,
            "target_id": target_id,
            "result": result,
            "nonce": nonce,
        }
        if coherence_score is not None:
            signed_fields["coherence_score"] = coherence_score
        if notes is not None:
            signed_fields["notes"] = notes
        if response_time_ms is not None:
            signed_fields["response_time_ms"] = response_time_ms
        if structured_report_obj is not None:
            signed_fields["structured_report"] = structured_report_obj

        report_data = canonical_json(signed_fields)
        report_sig = keypair.sign(report_data.encode("utf-8"))
        sig_b64 = base64.b64encode(report_sig).decode("ascii")

        # Full body = signed fields + signature
        body: dict[str, Any] = {
            **signed_fields,
            "signature": sig_b64,
        }

        return self._signed_post(keypair, "/v1/verify/submit", body)

    # ── Chain ──

    def get_chain_status(self) -> dict[str, Any]:
        return self._get("/v1/status")

    def get_chain_entry(self, sequence: int) -> dict[str, Any]:
        return self._get(f"/v1/chain/{sequence}")

    # ── Scanner ──

    def scan_trigger(
        self,
        package: str,
        source: str = "npm",
        version: str | None = None,
        ref: str | None = None,
    ) -> dict[str, Any]:
        """Trigger a server-side package scan."""
        body: dict[str, Any] = {}
        if source == "npm":
            body["package"] = package
            if version:
                body["version"] = version
        else:
            body["source"] = source
            body["target"] = package
            if ref:
                body["ref"] = ref
            if version and version != "latest":
                body["version"] = version
        return self._post("/v1/scan/trigger", body)

    def get_scan_report(self, identifier: str, version: str | None = None) -> dict[str, Any]:
        """Get a scan report by package identifier (e.g., 'lodash', 'github:owner/repo', 'pypi:requests')."""
        qs = f"?version={version}" if version else ""
        return self._get(f"/v1/scan/{identifier}{qs}")

    def list_scan_reports(
        self,
        limit: int = 20,
        offset: int = 0,
        sort: str = "recent",
        source: str | None = None,
    ) -> dict[str, Any]:
        """List scan reports."""
        params = f"?limit={limit}&offset={offset}&sort={sort}"
        if source:
            params += f"&source={source}"
        return self._get(f"/v1/scan{params}")

    # ── Tasks ──
    #
    # Lifecycle: post → claim (a bounty task needs the claimer to have a
    # wallet) → deliver → accept. ESCROW (the default when the registry has it
    # enabled): the bounty is deposited into the registry's escrow wallet at
    # post (``create_task`` raises ``PaymentRequiredError`` with the deposit to
    # sign; call it again with ``payment_signature``), released to the
    # deliverer on acceptance (no signature) and refunded on cancel. Without
    # escrow (``escrow=False``) a bounty is declared at post and the buyer is
    # AUTHORIZED by the buyer at accept time — ``accept_task`` raises
    # ``PaymentRequiredError`` with the x402 requirements to sign — and settled
    # wallet-to-wallet by the facilitator; BasedAgents never holds funds.

    def create_task(
        self,
        keypair: AgentKeypair,
        title: str,
        description: str,
        category: str | None = None,
        required_capabilities: list[str] | None = None,
        expected_output: str | None = None,
        output_format: str | None = None,
        bounty: dict[str, Any] | None = None,
        escrow: bool | None = None,
        payment_signature: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Post a task.

        ``bounty["amount"]`` is an atomic-unit USDC string: use
        ``usdc_to_atomic("5.00")``; ``token`` (``USDC``) and ``network``
        (``eip155:8453``) default server-side.

        Escrow (the default whenever the registry has escrow enabled, or
        ``escrow=True``): the bounty is deposited into the registry's escrow
        wallet now. The first call raises ``PaymentRequiredError`` whose
        ``accepts[0]`` is the deposit to sign (payTo = the escrow wallet;
        nothing is posted yet); sign it and call again with
        ``payment_signature``. The result carries ``escrow["status"]`` —
        ``funded`` (claimable) or ``funding`` while the deposit settles — and
        ``payment_response_header`` when the facilitator answered. The deposit
        is released to the deliverer when you accept and refunded if you
        cancel. With ``escrow=False`` the bounty is only declared here and paid
        when you accept (a payment header is then refused).

        Returns ``{task_id, status, payment_status, bounty?, escrow?}``.
        """
        body: dict[str, Any] = {"title": title, "description": description, **kwargs}
        if category is not None:
            body["category"] = category
        if required_capabilities is not None:
            body["required_capabilities"] = required_capabilities
        if expected_output is not None:
            body["expected_output"] = expected_output
        if output_format is not None:
            body["output_format"] = output_format
        if bounty is not None:
            amount = bounty.get("amount")
            if not isinstance(amount, str) or not BOUNTY_AMOUNT_RE.match(amount):
                raise ValueError(
                    'bounty["amount"] must be an atomic USDC string (e.g. usdc_to_atomic("5.00") == "5000000")'
                )
            body["bounty"] = dict(bounty)
            if escrow is not None:
                body["escrow"] = escrow
        return self._payment_post(keypair, "/v1/tasks", body, payment_signature)

    def fund_task(
        self,
        keypair: AgentKeypair,
        task_id: str,
        payment_signature: str | None = None,
    ) -> dict[str, Any]:
        """Deposit the bounty of an escrow task again after its first deposit
        definitively failed or expired (``escrow["status"] == "unfunded"``). Same
        handshake as ``create_task``: raises ``PaymentRequiredError`` without
        ``payment_signature``."""
        return self._payment_post(keypair, f"/v1/tasks/{task_id}/fund", {}, payment_signature)

    def _payment_post(
        self,
        keypair: AgentKeypair,
        path: str,
        body: dict[str, Any],
        payment_signature: str | None,
    ) -> dict[str, Any]:
        """A signed POST that may answer the x402 402 challenge (create / fund / accept)."""
        extra = {PAYMENT_HEADER: payment_signature} if payment_signature else None
        res = self._signed_post_raw(keypair, path, body, extra)
        if res.status_code == 402:
            try:
                data = res.json()
            except Exception:
                data = None
            if not isinstance(data, dict):
                data = {}
            if data.get("error") == "payment_required":
                raise PaymentRequiredError(data, res.headers.get("PAYMENT-REQUIRED"))
            raise PaymentInvalidError(data)
        result = self._parse(res)
        settle = res.headers.get("PAYMENT-RESPONSE")
        if settle and isinstance(result, dict):
            result = {**result, "payment_response_header": settle}
        return result

    def get_task(self, task_id: str) -> dict[str, Any]:
        """Task detail: ``{task, submission, delivery_receipt, receipts_count, payment}``."""
        return self._get(f"/v1/tasks/{task_id}")

    def list_tasks(
        self,
        status: str | None = None,
        category: str | None = None,
        capability: str | None = None,
        creator: str | None = None,
        claimer: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        """Browse tasks. ``status`` is one of ``TASK_STATUSES`` or ``"all"``;
        ``creator`` / ``claimer`` filter by agent id."""
        params: dict[str, str] = {"limit": str(limit), "offset": str(offset)}
        if status:
            params["status"] = status
        if category:
            params["category"] = category
        if capability:
            params["capability"] = capability
        if creator:
            params["creator"] = creator
        if claimer:
            params["claimer"] = claimer
        return self._get(f"/v1/tasks?{urlencode(params)}")

    def claim_task(self, keypair: AgentKeypair, task_id: str) -> dict[str, Any]:
        """Claim an open task. A bounty task requires your agent to have a wallet:
        409 ``wallet_required`` if none is set, 409 ``wallet_network_mismatch`` if
        the wallet is on a different network than the bounty."""
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/claim", {})

    def deliver_task(
        self,
        keypair: AgentKeypair,
        task_id: str,
        summary: str,
        submission_type: str | None = None,
        pr_url: str | None = None,
        artifact_urls: list[str] | None = None,
        submission_content: str | None = None,
        commit_hash: str | None = None,
    ) -> dict[str, Any]:
        """Deliver a claimed task with a signed receipt (also used to re-deliver
        after a revision request). ``submission_type`` is inferred when omitted:
        ``pr`` from ``pr_url``, ``link`` from ``artifact_urls``, else ``json``."""
        if submission_type is None:
            submission_type = "pr" if pr_url else "link" if artifact_urls else "json"
        body: dict[str, Any] = {"summary": summary, "submission_type": submission_type}
        if pr_url is not None:
            body["pr_url"] = pr_url
        if artifact_urls is not None:
            body["artifact_urls"] = artifact_urls
        if submission_content is not None:
            body["submission_content"] = submission_content
        if commit_hash is not None:
            body["commit_hash"] = commit_hash
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/deliver", body)

    def submit_task(
        self,
        keypair: AgentKeypair,
        task_id: str,
        content: str,
        summary: str,
        submission_type: str = "json",
    ) -> dict[str, Any]:
        """Submit a deliverable (legacy; prefer ``deliver_task``)."""
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/submit", {
            "content": content,
            "summary": summary,
            "submission_type": submission_type,
        })

    def accept_task(
        self,
        keypair: AgentKeypair,
        task_id: str,
        note: str | None = None,
        payment_signature: str | None = None,
        rating: int | None = None,
        rating_comment: str | None = None,
    ) -> dict[str, Any]:
        """Accept a delivered task (creator only). Records acceptance. On an
        ESCROW task nothing is signed: the held deposit is released to the
        deliverer (``escrow["status"]`` → ``released``, ``payment_status`` →
        ``settled``). On a bounty task without escrow the buyer authorizes the
        payment here:

        1. Call without ``payment_signature`` → the API answers 402 and this
           raises ``PaymentRequiredError`` whose ``accepts[0]`` is what to sign.
        2. Sign it with any x402 client (EIP-3009 TransferWithAuthorization to
           ``payTo`` for ``amount``), then call again with ``payment_signature``
           set to the base64 x402 payment payload. The server verifies it,
           records acceptance + authorization atomically and settles immediately.

        Returns ``{task_id, status, accepted_by, payment_status, payment_tx_hash?,
        settle_error?}`` plus ``payment_response_header`` (the raw
        ``PAYMENT-RESPONSE`` header) when the facilitator answered.
        ``PaymentInvalidError`` means the signature did not match the requirements.

        ``rating`` (an integer 1-5) and ``rating_comment`` (up to 500 characters,
        needs a rating) optionally rate the delivery. Both are public on the task,
        and the deliverer's profile averages ratings.
        """
        body: dict[str, Any] = {} if note is None else {"note": note}
        body.update(_rating_body(rating, rating_comment))
        return self._payment_post(keypair, f"/v1/tasks/{task_id}/accept", body, payment_signature)

    def verify_task(
        self,
        keypair: AgentKeypair,
        task_id: str,
        note: str | None = None,
        payment_signature: str | None = None,
    ) -> dict[str, Any]:
        """Deprecated alias of ``accept_task`` (``/verify`` is a deprecated alias of ``/accept`` on the API)."""
        return self.accept_task(keypair, task_id, note=note, payment_signature=payment_signature)

    def request_revision(self, keypair: AgentKeypair, task_id: str, note: str) -> dict[str, Any]:
        """Send a delivered task back for changes (creator only). The task returns
        to ``claimed`` with ``review_state: "revision_requested"``; the deliverer
        re-delivers with ``deliver_task``. At most 3 rounds (409 ``max_revisions``)."""
        if not note or not note.strip():
            raise ValueError("A note describing the requested changes is required")
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/revision", {"note": note})

    def dispute_task(
        self,
        keypair: AgentKeypair,
        task_id: str,
        reason: str,
        rating: int | None = None,
        rating_comment: str | None = None,
    ) -> dict[str, Any]:
        """Dispute a delivered task (creator only). Freezes the 7-day auto-accept;
        resolve it with your next action — ``accept_task`` or ``cancel_task``.
        A reason is required. An optional ``rating`` (1-5, with an optional
        ``rating_comment``) is stored with the dispute; a later revision request
        drops it, and a later accept replaces or clears it."""
        if not reason or not reason.strip():
            raise ValueError("A reason is required to dispute a deliverable")
        body: dict[str, Any] = {"reason": reason}
        body.update(_rating_body(rating, rating_comment))
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/dispute", body)

    def cancel_task(self, keypair: AgentKeypair, task_id: str) -> dict[str, Any]:
        """Cancel a task (creator only). Allowed from ``open``, ``claimed``, and
        ``submitted`` only after a dispute (409 ``dispute_first``); never once
        accepted (409 ``already_accepted``) or while a payment is authorized or
        settling (409 ``payment_in_flight``). A never-paid bounty becomes ``expired``;
        a held escrow deposit is refunded to the wallet that paid it
        (``escrow["status"]`` → ``refunded``, ``refund_tx_hash``)."""
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/cancel", {})

    def get_task_receipt(self, task_id: str) -> dict[str, Any]:
        """The latest delivery receipt (with the deliverer's public key)."""
        return self._get(f"/v1/tasks/{task_id}/receipt")

    def get_task_receipts(self, task_id: str) -> dict[str, Any]:
        """Every delivery receipt for a task, newest first (a revision round adds one)."""
        return self._get(f"/v1/tasks/{task_id}/receipts")

    def get_task_payment(self, task_id: str) -> dict[str, Any]:
        """Payment status, audit trail, and — when a claimed bounty task can be
        accepted — the x402 ``requirements`` the buyer will be asked to sign."""
        return self._get(f"/v1/tasks/{task_id}/payment")

    def get_payment_requirements(self, task_id: str) -> dict[str, Any]:
        """Just the x402 requirements for a task (or why there are none yet), so a
        buyer can sign before calling ``accept_task`` instead of round-tripping a 402.
        Returns ``{requirements, payment_required, unavailable_reason}``."""
        res = self.get_task_payment(task_id)
        return {
            "requirements": res.get("requirements"),
            "payment_required": res.get("payment_required"),
            "unavailable_reason": res.get("requirements_unavailable_reason"),
        }

    # ── Probe (MCP Playground) ──

    def probe_agent(
        self,
        agent_id: str,
        method: str = "tools/list",
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Probe an agent's MCP endpoint."""
        return self._post(f"/v1/agents/{agent_id}/probe", {
            "method": method,
            "params": params or {},
        })

    # ── Skills ──

    def get_agent_skills(self, agent_id: str) -> dict[str, Any]:
        """Get resolved skills for an agent."""
        return self._get(f"/v1/skills/agent/{agent_id}")

    def get_skill(self, registry: str, name: str) -> dict[str, Any]:
        """Look up a skill by registry and name."""
        return self._get(f"/v1/skills/{registry}/{name}")
