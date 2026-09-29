"""Tests for RegistryClient — all HTTP calls are mocked.

The client routes every verb through ``_http.request(method, url, **kwargs)``
(see ``RegistryClient._request_with_retry``), so tests mock ``request`` rather
than per-verb methods.
"""
import pytest
from unittest.mock import MagicMock, patch
import httpx

from basedagents import generate_keypair
from basedagents.client import RegistryClient, BasedAgentsError


# ─── Helpers ───

def make_agent(name="TestAgent", agent_id="ag_test123"):
    return {
        "agent_id": agent_id,
        "name": name,
        "description": "A test agent",
        "status": "active",
        "reputation_score": 0.8,
        "verification_count": 10,
        "capabilities": ["code"],
        "protocols": ["https"],
        "created_at": "2024-01-01T00:00:00Z",
    }


def make_mock_response(data, status_code=200):
    """Create a mock httpx.Response."""
    resp = MagicMock(spec=httpx.Response)
    resp.json.return_value = data
    resp.status_code = status_code
    resp.is_success = 200 <= status_code < 300
    resp.headers = {}
    resp.text = ""
    resp.raise_for_status = MagicMock()
    return resp


def make_client_with_mock(base_url="https://api.test.local"):
    """Create a RegistryClient with a mocked _http attribute."""
    client = RegistryClient(api_url=base_url)
    mock_http = MagicMock()
    client._http = mock_http
    return client, mock_http


def requested_url(mock_http, index=0):
    """URL of the index-th _http.request(method, url, ...) call."""
    return mock_http.request.call_args_list[index][0][1]


# ─── get_agent ───

class TestGetAgent:
    def test_sends_get_to_correct_url(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(make_agent())

        client.get_agent("ag_test123")

        mock_http.request.assert_called_once_with(
            "GET", "https://api.test.local/v1/agents/ag_test123"
        )

    def test_returns_agent_dict(self):
        client, mock_http = make_client_with_mock()
        agent = make_agent(name="MyBot")
        mock_http.request.return_value = make_mock_response(agent)

        result = client.get_agent("ag_test123")

        assert result["name"] == "MyBot"
        assert result["agent_id"] == "ag_test123"

    def test_raises_on_error_status(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"message": "Not found"}, 404)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.get_agent("ag_missing")
        assert exc_info.value.status == 404


# ─── search ───

class TestSearch:
    def test_sends_get_to_search_endpoint(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"agents": [], "total": 0})

        client.search(q="hello")

        call_url = requested_url(mock_http)
        assert "/v1/agents/search" in call_url
        assert "q=hello" in call_url

    def test_passes_capabilities_and_protocols(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"agents": [], "total": 0})

        client.search(capabilities=["code", "analysis"], protocols=["https"])

        call_url = requested_url(mock_http)
        assert "capabilities=code%2Canalysis" in call_url or "capabilities=code,analysis" in call_url
        assert "protocols=https" in call_url

    def test_returns_search_results(self):
        client, mock_http = make_client_with_mock()
        agents = [make_agent("Agent1"), make_agent("Agent2")]
        mock_http.request.return_value = make_mock_response({"agents": agents, "total": 2})

        result = client.search()

        assert len(result["agents"]) == 2
        assert result["total"] == 2

    def test_pagination_params(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"agents": [], "total": 0})

        client.search(limit=5, page=3)

        call_url = requested_url(mock_http)
        assert "limit=5" in call_url
        assert "page=3" in call_url


# ─── whois ───

class TestWhois:
    def test_returns_agent_by_exact_name(self):
        client, mock_http = make_client_with_mock()
        agents = [make_agent("TargetAgent"), make_agent("OtherAgent")]
        mock_http.request.return_value = make_mock_response({"agents": agents, "total": 2})

        result = client.whois("TargetAgent")

        assert result is not None
        assert result["name"] == "TargetAgent"

    def test_returns_none_when_not_found(self):
        client, mock_http = make_client_with_mock()
        agents = [make_agent("DifferentAgent")]
        mock_http.request.return_value = make_mock_response({"agents": agents, "total": 1})

        result = client.whois("NonExistentAgent")

        assert result is None

    def test_case_insensitive_match(self):
        client, mock_http = make_client_with_mock()
        agents = [make_agent("MyAgent")]
        mock_http.request.return_value = make_mock_response({"agents": agents, "total": 1})

        result = client.whois("myagent")

        assert result is not None
        assert result["name"] == "MyAgent"

    def test_returns_none_on_empty_results(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"agents": [], "total": 0})

        result = client.whois("AnyName")

        assert result is None


# ─── get_reputation ───

class TestGetReputation:
    def test_sends_get_to_reputation_endpoint(self):
        client, mock_http = make_client_with_mock()
        rep = {"agent_id": "ag_test", "reputation_score": 0.75}
        mock_http.request.return_value = make_mock_response(rep)

        client.get_reputation("ag_test")

        assert "/v1/agents/ag_test/reputation" in requested_url(mock_http)

    def test_returns_reputation_data(self):
        client, mock_http = make_client_with_mock()
        rep = {"agent_id": "ag_test", "reputation_score": 0.75, "confidence": 0.9}
        mock_http.request.return_value = make_mock_response(rep)

        result = client.get_reputation("ag_test")

        assert result["reputation_score"] == 0.75


# ─── register ───

class TestRegister:
    def test_full_registration_flow(self):
        """register() makes init POST, solves PoW, then makes complete POST."""
        kp = generate_keypair()

        client, mock_http = make_client_with_mock()

        # Mock init and complete responses
        init_resp = make_mock_response({
            "challenge_id": "chal_abc",
            "challenge": "dGVzdC1jaGFsbGVuZ2U=",  # base64 challenge string
            "difficulty": 4,  # Very low for speed
        })
        complete_resp = make_mock_response({
            "agent": make_agent("RegisteredAgent"),
            "agent_id": "ag_newagent123",
        })
        mock_http.request.side_effect = [init_resp, complete_resp]

        profile = {
            "name": "RegisteredAgent",
            "description": "Test registration",
            "capabilities": ["code"],
            "protocols": ["https"],
        }

        client.register(kp, profile)

        # Should have made 2 POST calls: init, then complete
        assert mock_http.request.call_count == 2
        assert mock_http.request.call_args_list[0][0][0] == "POST"
        assert "/v1/register/init" in requested_url(mock_http, 0)
        assert mock_http.request.call_args_list[1][0][0] == "POST"
        assert "/v1/register/complete" in requested_url(mock_http, 1)

    def test_register_raises_on_init_failure(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()

        mock_http.request.return_value = make_mock_response({"message": "Server error"}, 500)

        with pytest.raises(BasedAgentsError):
            client.register(kp, {
                "name": "TestAgent",
                "description": "desc",
                "capabilities": ["code"],
                "protocols": ["https"],
            })


# ─── update_profile ───

class TestUpdateProfile:
    def test_sends_put_with_auth_headers(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(make_agent("UpdatedAgent"))

        client.update_profile(kp, {"name": "UpdatedAgent"})

        mock_http.request.assert_called_once()
        assert mock_http.request.call_args[0][0] == "PUT"
        headers = mock_http.request.call_args[1].get("headers", {})
        assert "Authorization" in headers
        assert headers["Authorization"].startswith("AgentSig ")
        assert "X-Timestamp" in headers

    def test_sends_to_correct_url(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(make_agent())

        client.update_profile(kp, {"description": "Updated"})

        assert f"/v1/agents/{kp.agent_id}" in requested_url(mock_http)


# ─── BasedAgentsError ───

class TestBasedAgentsError:
    def test_error_has_status_code(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"message": "Unauthorized"}, 401)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.get_agent("ag_test")

        assert exc_info.value.status == 401
        assert "Unauthorized" in str(exc_info.value)

    def test_error_message_from_response(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"message": "Rate limited"}, 429)

        # 429 triggers retry with backoff — stub out the sleeps and verify the
        # retries exhaust into a BasedAgentsError carrying the API message.
        with patch("basedagents.client.time.sleep"):
            with pytest.raises(BasedAgentsError) as exc_info:
                client.get_agent("ag_test")

        assert exc_info.value.message == "Rate limited"
        assert mock_http.request.call_count > 1  # retried before giving up


# ─── Tasks ───

import json as _json
import warnings as _warnings

from basedagents.client import (
    PaymentRequiredError, PaymentInvalidError, PAYMENT_HEADER, TASK_STATUSES,
    usdc_to_atomic, atomic_to_display, resolve_api_url,
)


def requested_method(mock_http, index=0):
    return mock_http.request.call_args_list[index][0][0]


def requested_headers(mock_http, index=0):
    return mock_http.request.call_args_list[index][1].get("headers", {})


def requested_body(mock_http, index=0):
    return _json.loads(mock_http.request.call_args_list[index][1]["content"])


PAYMENT_REQUIRED_BODY = {
    "error": "payment_required",
    "message": "Sign an EIP-3009 USDC transfer of 5.00 USDC to the deliverer's wallet and retry with the PAYMENT-SIGNATURE header.",
    "x402Version": 2,
    "resource": {"url": "https://api.basedagents.ai/v1/tasks/task_paid/accept", "mimeType": "application/json"},
    "accepts": [{
        "scheme": "exact", "network": "eip155:8453", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": "5000000", "payTo": "0x" + "ab" * 20, "maxTimeoutSeconds": 3600,
        "extra": {"name": "USD Coin", "version": "2"},
    }],
    "task_id": "task_paid",
    "bounty": {"amount_atomic": "5000000", "amount_display": "5.00", "token": "USDC", "network": "eip155:8453"},
    "accept_endpoint": "POST /v1/tasks/task_paid/accept",
    "payment_header": "PAYMENT-SIGNATURE",
}


class TestUsdcHelpers:
    def test_usdc_to_atomic(self):
        assert usdc_to_atomic("5.00") == "5000000"
        assert usdc_to_atomic("5") == "5000000"
        assert usdc_to_atomic("0.5") == "500000"
        assert usdc_to_atomic("0.000001") == "1"
        assert usdc_to_atomic("1000") == "1000000000"

    def test_usdc_to_atomic_rejects_bad_input(self):
        for bad in ["5.1234567", "0", "0.0", "1000.01", "$5", "abc", "", "5,00"]:
            with pytest.raises(ValueError):
                usdc_to_atomic(bad)

    def test_atomic_to_display(self):
        assert atomic_to_display("5000000") == "5.00"
        assert atomic_to_display("5120000") == "5.12"
        assert atomic_to_display("5123456") == "5.123456"
        assert atomic_to_display("1") == "0.000001"
        assert atomic_to_display("0") == "0.00"

    def test_round_trip(self):
        for d in ["5.00", "0.5", "12.345678", "1000"]:
            assert usdc_to_atomic(atomic_to_display(usdc_to_atomic(d))) == usdc_to_atomic(d)

    def test_task_statuses_include_closed(self):
        assert TASK_STATUSES == ("open", "claimed", "submitted", "verified", "closed", "cancelled")
        assert PAYMENT_HEADER == "PAYMENT-SIGNATURE"


class TestResolveApiUrl:
    def test_prefers_basedagents_api_url(self, monkeypatch):
        monkeypatch.setenv("BASEDAGENTS_API_URL", "https://new.test.local")
        monkeypatch.setenv("BASEDAGENTS_API", "https://old.test.local")
        with _warnings.catch_warnings():
            _warnings.simplefilter("error")
            assert resolve_api_url() == "https://new.test.local"

    def test_legacy_name_still_works_with_a_warning(self, monkeypatch):
        monkeypatch.delenv("BASEDAGENTS_API_URL", raising=False)
        monkeypatch.setenv("BASEDAGENTS_API", "https://old.test.local")
        with pytest.warns(DeprecationWarning):
            assert resolve_api_url() == "https://old.test.local"

    def test_default(self, monkeypatch):
        monkeypatch.delenv("BASEDAGENTS_API_URL", raising=False)
        monkeypatch.delenv("BASEDAGENTS_API", raising=False)
        assert resolve_api_url() == "https://api.basedagents.ai"


class TestCreateTask:
    def test_posts_atomic_bounty_in_body_and_no_payment_header(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "ok": True, "task_id": "task_new", "status": "open", "payment_status": "pending",
            "bounty": {"amount_atomic": "5000000", "amount_display": "5.00", "token": "USDC", "network": "eip155:8453"},
        })

        result = client.create_task(
            kp, title="Summarize paper", description="Read and summarize",
            category="research", required_capabilities=["summarization"],
            expected_output="A 1-page summary", output_format="link",
            bounty={"amount": usdc_to_atomic("5.00")},
        )

        assert requested_method(mock_http) == "POST"
        assert requested_url(mock_http) == "https://api.test.local/v1/tasks"
        headers = requested_headers(mock_http)
        assert headers["Authorization"].startswith("AgentSig ")
        assert PAYMENT_HEADER not in headers
        assert "X-PAYMENT-SIGNATURE" not in headers
        assert requested_body(mock_http) == {
            "title": "Summarize paper", "description": "Read and summarize", "category": "research",
            "required_capabilities": ["summarization"], "expected_output": "A 1-page summary",
            "output_format": "link", "bounty": {"amount": "5000000"},
        }
        assert result["payment_status"] == "pending"

    def test_escrow_false_is_sent_and_escrow_omitted_is_left_to_the_server(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"ok": True, "task_id": "t", "status": "open", "payment_status": "pending", "escrow": None})
        client.create_task(kp, title="T", description="D", bounty={"amount": "5000000"}, escrow=False)
        assert requested_body(mock_http)["escrow"] is False
        client.create_task(kp, title="T", description="D", bounty={"amount": "5000000"})
        assert "escrow" not in requested_body(mock_http, 1)
        # Without a bounty the flag is meaningless and not sent.
        client.create_task(kp, title="T", description="D", escrow=True)
        assert "escrow" not in requested_body(mock_http, 2)

    def test_escrow_402_raises_payment_required_with_the_deposit_to_sign(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        body = {
            **{k: v for k, v in PAYMENT_REQUIRED_BODY.items() if k not in ("task_id", "accept_endpoint")},
            "resource": {"url": "https://api.basedagents.ai/v1/tasks", "mimeType": "application/json"},
            "escrow": {"wallet": "0x" + "ee" * 20},
            "fund_endpoint": "POST /v1/tasks",
        }
        resp = make_mock_response(body, 402)
        resp.headers = {"PAYMENT-REQUIRED": "eyJ4NDAyVmVyc2lvbiI6Mn0="}
        mock_http.request.return_value = resp

        with pytest.raises(PaymentRequiredError) as exc_info:
            client.create_task(kp, title="T", description="D", bounty={"amount": "5000000"})
        err = exc_info.value
        assert err.status == 402
        assert err.is_escrow_deposit is True
        assert err.task_id is None
        assert err.accepts[0]["amount"] == "5000000"
        assert PAYMENT_HEADER not in requested_headers(mock_http)

    def test_escrow_deposit_signature_is_sent_as_the_payment_header(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        resp = make_mock_response({
            "ok": True, "task_id": "task_esc", "status": "open", "payment_status": "pending",
            "escrow": {"status": "funded", "deposit_tx_hash": "0xdead"}, "claimable": True,
        })
        resp.headers = {"PAYMENT-RESPONSE": "eyJzdWNjZXNzIjp0cnVlfQ=="}
        mock_http.request.return_value = resp

        result = client.create_task(kp, title="T", description="D", bounty={"amount": "5000000"}, payment_signature="c2lnbmVk")

        assert requested_headers(mock_http)[PAYMENT_HEADER] == "c2lnbmVk"
        assert result["escrow"]["status"] == "funded"
        assert result["payment_response_header"] == "eyJzdWNjZXNzIjp0cnVlfQ=="

    def test_fund_task_posts_the_deposit_again(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"ok": True, "task_id": "task_esc", "status": "open", "payment_status": "pending", "escrow": {"status": "funded"}})
        result = client.fund_task(kp, "task_esc", payment_signature="c2lnbmVk")
        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_esc/fund"
        assert requested_headers(mock_http)[PAYMENT_HEADER] == "c2lnbmVk"
        assert requested_body(mock_http) == {}
        assert result["escrow"]["status"] == "funded"

    def test_unpaid_task_has_no_bounty_key(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"ok": True, "task_id": "task_free", "status": "open", "payment_status": "none"})

        client.create_task(kp, title="T", description="D")

        assert "bounty" not in requested_body(mock_http)

    def test_rejects_decimal_bounty_amount_locally(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()

        with pytest.raises(ValueError):
            client.create_task(kp, title="T", description="D", bounty={"amount": "5.00"})
        mock_http.request.assert_not_called()

    def test_surfaces_payments_unavailable_code(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"error": "payments_unavailable", "message": "Bounties are not enabled"}, 503)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.create_task(kp, title="T", description="D", bounty={"amount": "1"})
        assert exc_info.value.status == 503
        assert exc_info.value.code == "payments_unavailable"


class TestListTasks:
    def test_forwards_every_filter(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"ok": True, "tasks": []})

        client.list_tasks(status="open", category="code", capability="code-review",
                          creator="ag_x", claimer="ag_y", limit=5, offset=10)

        url = requested_url(mock_http)
        assert url.startswith("https://api.test.local/v1/tasks?")
        for q in ["status=open", "category=code", "capability=code-review", "creator=ag_x", "claimer=ag_y", "limit=5", "offset=10"]:
            assert q in url

    def test_defaults(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"ok": True, "tasks": []})

        client.list_tasks()

        url = requested_url(mock_http)
        assert "limit=20" in url and "offset=0" in url and "status=" not in url


class TestClaimAndDeliver:
    def test_claim_posts_with_agentsig(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"ok": True, "task_id": "task_1", "status": "claimed"})

        client.claim_task(kp, "task_1")

        assert requested_method(mock_http) == "POST"
        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_1/claim"
        assert requested_headers(mock_http)["Authorization"].startswith("AgentSig ")

    def test_claim_surfaces_wallet_required(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"error": "wallet_required", "message": "Set a wallet before claiming."}, 409)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.claim_task(kp, "task_1")
        assert exc_info.value.code == "wallet_required"

    def test_deliver_infers_submission_type(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"ok": True, "task_id": "task_1", "receipt_id": "rcpt_1", "status": "submitted", "revision_count": 0})

        client.deliver_task(kp, "task_1", summary="Done", pr_url="https://github.com/o/r/pull/1", commit_hash="b" * 40)
        client.deliver_task(kp, "task_1", summary="Done", artifact_urls=["https://a.example/1"])
        client.deliver_task(kp, "task_1", summary="Done", submission_content='{"ok":true}')
        client.deliver_task(kp, "task_1", summary="Done", submission_content="x", submission_type="link")

        assert requested_url(mock_http, 0) == "https://api.test.local/v1/tasks/task_1/deliver"
        assert requested_body(mock_http, 0) == {
            "summary": "Done", "submission_type": "pr", "pr_url": "https://github.com/o/r/pull/1", "commit_hash": "b" * 40}
        assert requested_body(mock_http, 1) == {
            "summary": "Done", "submission_type": "link", "artifact_urls": ["https://a.example/1"]}
        assert requested_body(mock_http, 2) == {
            "summary": "Done", "submission_type": "json", "submission_content": '{"ok":true}'}
        assert requested_body(mock_http, 3)["submission_type"] == "link"


class TestAcceptTask:
    def test_402_raises_payment_required_with_the_challenge(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        resp = make_mock_response(PAYMENT_REQUIRED_BODY, 402)
        resp.headers = {"PAYMENT-REQUIRED": "eyJ4NDAyVmVyc2lvbiI6Mn0="}
        mock_http.request.return_value = resp

        with pytest.raises(PaymentRequiredError) as exc_info:
            client.accept_task(kp, "task_paid")

        err = exc_info.value
        assert isinstance(err, BasedAgentsError)
        assert err.status == 402
        assert err.code == "payment_required"
        assert err.task_id == "task_paid"
        assert err.accepts[0]["payTo"] == "0x" + "ab" * 20
        assert err.accepts[0]["amount"] == "5000000"
        assert err.payment_required["x402Version"] == 2
        assert err.payment_required_header == "eyJ4NDAyVmVyc2lvbiI6Mn0="
        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_paid/accept"
        assert PAYMENT_HEADER not in requested_headers(mock_http)
        assert requested_body(mock_http) == {}

    def test_sends_payment_signature_header_and_surfaces_settlement(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        resp = make_mock_response({
            "ok": True, "task_id": "task_paid", "status": "verified", "accepted_by": "creator",
            "payment_status": "settled", "payment_tx_hash": "0xdead", "chain_sequence": 9, "chain_entry_hash": "h",
        })
        resp.headers = {"PAYMENT-RESPONSE": "eyJzdWNjZXNzIjp0cnVlfQ=="}
        mock_http.request.return_value = resp

        result = client.accept_task(kp, "task_paid", note="great work", payment_signature="c2lnbmVk")

        headers = requested_headers(mock_http)
        assert headers[PAYMENT_HEADER] == "c2lnbmVk"
        assert headers["Authorization"].startswith("AgentSig ")
        assert requested_body(mock_http) == {"note": "great work"}
        assert result["payment_status"] == "settled"
        assert result["payment_tx_hash"] == "0xdead"
        assert result["payment_response_header"] == "eyJzdWNjZXNzIjp0cnVlfQ=="

    def test_402_payment_invalid_raises_typed_error(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "error": "payment_invalid", "reason": "amount_mismatch", "expected": "5000000", "got": "4000000",
            "message": "The signed authorization does not match this task's payment requirements.",
            "payment_requirements": PAYMENT_REQUIRED_BODY["accepts"][0],
        }, 402)

        with pytest.raises(PaymentInvalidError) as exc_info:
            client.accept_task(kp, "task_paid", payment_signature="bad")

        err = exc_info.value
        assert err.reason == "amount_mismatch"
        assert err.expected == "5000000"
        assert err.got == "4000000"
        assert err.payment_requirements["payTo"] == "0x" + "ab" * 20
        assert "amount_mismatch" in str(err)

    def test_insufficient_funds_is_payment_invalid_too(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "error": "insufficient_funds", "reason": "insufficient_funds", "message": "Not enough USDC", "payer": "0x" + "cd" * 20,
        }, 402)

        with pytest.raises(PaymentInvalidError) as exc_info:
            client.accept_task(kp, "task_paid", payment_signature="sig")
        assert exc_info.value.payer == "0x" + "cd" * 20

    def test_409_is_a_plain_error_with_code(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"error": "invalid_state", "message": "Task is open; only a submitted task can be accepted", "status": "open"}, 409)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.accept_task(kp, "task_1")
        assert not isinstance(exc_info.value, (PaymentRequiredError, PaymentInvalidError))
        assert exc_info.value.status == 409
        assert exc_info.value.code == "invalid_state"

    def test_unpaid_task(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"ok": True, "task_id": "task_free", "status": "verified", "accepted_by": "creator", "payment_status": "none"})

        result = client.accept_task(kp, "task_free")

        assert result["payment_status"] == "none"
        assert "payment_response_header" not in result

    def test_verify_task_is_a_deprecated_alias_of_accept(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"ok": True, "task_id": "task_1", "status": "verified", "accepted_by": "creator", "payment_status": "none"})

        client.verify_task(kp, "task_1", note="ok")

        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_1/accept"
        assert requested_body(mock_http) == {"note": "ok"}


class TestReviewFlow:
    def test_request_revision_posts_the_note(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"ok": True, "task_id": "task_1", "status": "claimed", "review_state": "revision_requested", "revision_count": 1})

        result = client.request_revision(kp, "task_1", "Add tests")

        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_1/revision"
        assert requested_body(mock_http) == {"note": "Add tests"}
        assert result["review_state"] == "revision_requested"

    def test_request_revision_requires_a_note(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()

        with pytest.raises(ValueError):
            client.request_revision(kp, "task_1", "  ")
        mock_http.request.assert_not_called()

    def test_dispute_posts_the_reason(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "ok": True, "task_id": "task_1", "status": "submitted", "review_state": "disputed",
            "disputed_at": "2026-01-01T00:00:00Z", "payment_status": "pending"})

        result = client.dispute_task(kp, "task_1", "Incomplete")

        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_1/dispute"
        assert requested_body(mock_http) == {"reason": "Incomplete"}
        assert result["review_state"] == "disputed"

    def test_dispute_requires_a_reason(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()

        with pytest.raises(ValueError):
            client.dispute_task(kp, "task_1", "")
        mock_http.request.assert_not_called()

    def test_accept_and_dispute_send_an_optional_rating(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "ok": True, "task_id": "task_1", "status": "submitted", "review_state": "disputed",
            "disputed_at": "2026-01-01T00:00:00Z", "payment_status": "none", "rating": 2})
        client.dispute_task(kp, "task_1", "Half done", rating=2, rating_comment="Missing tests")
        assert requested_body(mock_http) == {"reason": "Half done", "rating": 2, "rating_comment": "Missing tests"}

        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "ok": True, "task_id": "task_1", "status": "verified", "accepted_by": "creator",
            "payment_status": "none", "rating": 5})
        result = client.accept_task(kp, "task_1", note="Thanks", rating=5)
        assert requested_body(mock_http) == {"note": "Thanks", "rating": 5}
        assert result["rating"] == 5

    def test_rating_is_checked_before_sending(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        for kwargs in ({"rating": 0}, {"rating": 6}, {"rating": 4.5}, {"rating": True}, {"rating_comment": "no score"},
                       {"rating": 4, "rating_comment": "x" * 501}, {"rating": 4, "rating_comment": "\U0001F600" * 251}):
            with pytest.raises(ValueError):
                client.accept_task(kp, "task_1", **kwargs)
        mock_http.request.assert_not_called()

    def test_padded_rating_comment_counts_like_the_api(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"ok": True, "task_id": "task_1", "status": "verified", "accepted_by": "creator", "payment_status": "none", "rating": 4})
        client.accept_task(kp, "task_1", rating=4, rating_comment="  " + "x" * 500 + "  ")
        mock_http.request.assert_called_once()

    def test_cancel_posts_and_returns_voided_payment(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response(
            {"ok": True, "task_id": "task_1", "status": "cancelled", "payment_status": "expired"})

        result = client.cancel_task(kp, "task_1")

        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_1/cancel"
        assert requested_body(mock_http) == {}
        assert result["payment_status"] == "expired"

    def test_cancel_surfaces_dispute_first(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "error": "dispute_first", "message": "Delivered work can only be cancelled after a dispute",
            "status": "submitted", "payment_status": "none"}, 409)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.cancel_task(kp, "task_1")
        assert exc_info.value.code == "dispute_first"


class TestPaymentAndReceipts:
    def test_get_task_payment(self):
        client, mock_http = make_client_with_mock()
        body = {
            "ok": True,
            "payment": {"task_id": "task_paid", "bounty": PAYMENT_REQUIRED_BODY["bounty"], "status": "pending", "pay_to": "0x" + "ab" * 20},
            "requirements": PAYMENT_REQUIRED_BODY["accepts"][0],
            "accept_endpoint": "POST /v1/tasks/task_paid/accept",
            "payment_header": "PAYMENT-SIGNATURE",
            "events": [{"id": "pev_1", "event_type": "bounty_declared", "details": {"amount_atomic": "5000000"}, "created_at": "2026-01-01T00:00:00Z"}],
        }
        mock_http.request.return_value = make_mock_response(body)

        result = client.get_task_payment("task_paid")

        assert requested_method(mock_http) == "GET"
        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_paid/payment"
        assert result["requirements"]["payTo"] == "0x" + "ab" * 20
        assert result["events"][0]["event_type"] == "bounty_declared"

    def test_get_payment_requirements_reports_why_there_are_none(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "ok": True, "payment": {"task_id": "task_1", "bounty": None, "status": "none"},
            "requirements": None, "requirements_unavailable_reason": "no_bounty",
            "accept_endpoint": "POST /v1/tasks/task_1/accept", "payment_header": "PAYMENT-SIGNATURE", "events": [],
        })

        result = client.get_payment_requirements("task_1")

        assert result == {"requirements": None, "payment_required": None, "unavailable_reason": "no_bounty"}

    def test_get_task_receipts_and_receipt(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({"ok": True, "receipts": [{"receipt_id": "rcpt_2"}, {"receipt_id": "rcpt_1"}]})

        result = client.get_task_receipts("task_1")
        client.get_task_receipt("task_1")

        assert requested_url(mock_http, 0) == "https://api.test.local/v1/tasks/task_1/receipts"
        assert requested_url(mock_http, 1) == "https://api.test.local/v1/tasks/task_1/receipt"
        assert result["receipts"][0]["receipt_id"] == "rcpt_2"

    def test_get_task_detail(self):
        client, mock_http = make_client_with_mock()
        mock_http.request.return_value = make_mock_response({
            "ok": True, "task": {"task_id": "task_1", "status": "submitted", "creator": {"kind": "owner", "id": None}},
            "submission": None, "delivery_receipt": {"receipt_id": "rcpt_1"}, "receipts_count": 1, "payment": {"status": "none"},
        })

        result = client.get_task("task_1")

        assert requested_url(mock_http) == "https://api.test.local/v1/tasks/task_1"
        assert result["task"]["creator"]["kind"] == "owner"
        assert result["receipts_count"] == 1
