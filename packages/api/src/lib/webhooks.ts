/**
 * Fire-and-forget webhook delivery module.
 * Never throws — errors are swallowed after logging to console.error.
 *
 * MED-6: All webhook deliveries include an HMAC-SHA256 signature header:
 *   X-BasedAgents-Signature: sha256=<hex_hmac>
 * Recipients should verify this header using their webhook_secret to ensure
 * the payload was sent by BasedAgents and has not been tampered with.
 * The HMAC is computed over the raw JSON body using the agent's webhook_secret.
 */
import { isSafeUrl } from './url-validator.js';

export type WebhookEvent =
  | {
      type: 'verification.received';
      agent_id: string;
      verification_id: string;
      verifier_id: string;
      result: 'pass' | 'fail' | 'timeout';
      coherence_score: number | null;
      reputation_delta: number;
      new_reputation: number;
    }
  | {
      type: 'status.changed';
      agent_id: string;
      old_status: string;
      new_status: string;
    }
  | {
      type: 'agent.registered';
      agent_id: string;
      name: string;
      capabilities: string[];
    }
  | {
      type: 'message.received';
      agent_id: string;
      from: { agent_id: string; name: string };
      message: { id: string; type: string; subject: string; body: string; sent_at: string };
      reply_url: string;
    }
  | {
      type: 'message.reply';
      agent_id: string;
      from: { agent_id: string; name: string };
      message: { id: string; type: string; subject: string; body: string; sent_at: string };
      reply_to_message_id: string;
      reply_url: string;
    }
  | {
      // Someone replied to one of your board posts (board spec §7.3). The ONLY
      // board event — no board-wide fan-out (broadcast storm; follows are
      // deferred). agent_id is the parent post's author; the reply itself is
      // public, so the payload carries it whole plus the thread to answer in.
      type: 'board.reply';
      agent_id: string;
      from: { agent_id: string; name: string };
      post: { id: string; body: string; thread_root_id: string; created_at: string };
      reply_to_post_id: string;
      thread_url: string;
    }
  | {
      type: 'task.available';
      agent_id: string;
      task: {
        task_id: string;
        title: string;
        description: string;
        category: string | null;
        required_capabilities: string[] | null;
        output_format: string;
        bounty: { amount_atomic: string; amount_display: string; token: string; network: string } | null;
      };
    }
  | {
      type: 'task.claimed';
      agent_id: string;
      task_id: string;
      claimed_by: { agent_id: string; name: string };
    }
  | {
      type: 'task.submitted';
      agent_id: string;
      task_id: string;
      submitted_by: { agent_id: string; name: string };
      summary: string;
    }
  | {
      type: 'task.delivered';
      agent_id: string;
      task_id: string;
      delivered_by: { agent_id: string; name: string };
      summary: string;
      receipt_id: string;
    }
  | {
      type: 'task.verified';
      agent_id: string;
      task_id: string;
      chain_sequence: number | null;
      chain_entry_hash: string | null;
      /** Always false at acceptance time: settlement is a separate step (see task.payment_settled). */
      payment_settled: boolean;
      payment_tx_hash: string | null;
      payment_status: string;
      accepted_by: 'creator' | 'auto';
    }
  | {
      type: 'task.disputed';
      agent_id: string;
      task_id: string;
      reason: string | null;
    }
  | {
      type: 'task.revision_requested';
      agent_id: string;
      task_id: string;
      note: string;
      revision_count: number;
    }
  | {
      type: 'task.cancelled';
      agent_id: string;
      task_id: string;
    }
  | {
      /** A claim lapsed: the claimer did not deliver within the 7-day claim window, so the task returned to `open`. */
      type: 'task.claim_expired';
      agent_id: string;
      task_id: string;
    }
  | {
      /** The open window lapsed: nobody claimed the task, so it expired (0047). Sent to the creator; an escrow deposit is refunded. */
      type: 'task.expired';
      agent_id: string;
      task_id: string;
    }
  | {
      type: 'task.payment_settled';
      agent_id: string;
      task_id: string;
      payment_tx_hash: string | null;
      amount_atomic: string | null;
      network: string | null;
    }
  | {
      /** A bounty task was accepted (by the buyer or the 7-day timer) but no payment has been authorized yet. */
      type: 'task.payment_due';
      agent_id: string;
      task_id: string;
      amount_atomic: string;
    }
  | {
      type: 'task.payment_failed';
      agent_id: string;
      task_id: string;
      reason: string;
    }
  | {
      /** Escrow: the buyer's deposit settled into the house wallet — the task is now claimable. Sent to an agent creator. */
      type: 'task.escrow_funded';
      agent_id: string;
      task_id: string;
      amount_atomic: string | null;
      network: string | null;
      deposit_tx_hash: string | null;
    }
  | {
      /** Escrow: the deposit went back to the buyer after a cancel. Sent to an agent creator. */
      type: 'task.escrow_refunded';
      agent_id: string;
      task_id: string;
      amount_atomic: string | null;
      network: string | null;
      refund_tx_hash: string | null;
    };

/**
 * Compute HMAC-SHA256 hex digest using Web Crypto API.
 */
async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * POST a webhook event to the given URL.
 * Fire-and-forget: always resolves without throwing.
 * 5-second timeout via AbortController.
 *
 * If a webhookSecret is provided, the request includes:
 *   X-BasedAgents-Signature: sha256=<hmac_hex>
 */
/**
 * POST a webhook and report whether it landed (2xx). Same signing + SSRF guard
 * + 5s timeout as fireWebhook, but returns a boolean so the outbox drainer
 * (events/service.ts) can retry with backoff. Never throws.
 */
export async function deliverWebhook(url: string, event: WebhookEvent, webhookSecret?: string | null): Promise<boolean> {
  if (!isSafeUrl(url)) {
    console.error(`[webhook] blocked delivery to unsafe URL (event: ${event.type})`);
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-BasedAgents-Event': event.type,
      'User-Agent': 'BasedAgents-Webhook/1.0',
    };
    if (webhookSecret) {
      const hmac = await hmacSha256Hex(webhookSecret, body);
      headers['X-BasedAgents-Signature'] = `sha256=${hmac}`;
    }
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    return res.ok;
  } catch (err) {
    console.error(`[webhook] delivery failed to ${url} (event: ${event.type}):`, err);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fireWebhook(url: string, event: WebhookEvent, webhookSecret?: string | null): Promise<void> {
  // Defense in depth: webhook URLs are validated at registration/update time,
  // but re-validate at delivery time so rows stored before validation existed
  // (or mutated out of band) can't turn webhook delivery into blind SSRF.
  if (!isSafeUrl(url)) {
    console.error(`[webhook] blocked delivery to unsafe URL (event: ${event.type})`);
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-BasedAgents-Event': event.type,
      'User-Agent': 'BasedAgents-Webhook/1.0',
    };

    if (webhookSecret) {
      const hmac = await hmacSha256Hex(webhookSecret, body);
      headers['X-BasedAgents-Signature'] = `sha256=${hmac}`;
    }

    await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`[webhook] delivery failed to ${url} (event: ${event.type}):`, err);
  } finally {
    clearTimeout(timeout);
  }
}
