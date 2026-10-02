import React from 'react';

const LAST_UPDATED = 'September 24, 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>{title}</h2>
      <div style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

function DataRow({ what, why, public: pub, retained }: { what: string; why: string; public: boolean; retained: string }) {
  return (
    <tr>
      <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: 14 }}>{what}</td>
      <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 14 }}>{why}</td>
      <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 14, color: pub ? 'var(--status-active)' : 'var(--text-tertiary)' }}>{pub ? 'Yes' : 'Obfuscated / No'}</td>
      <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', color: 'var(--text-tertiary)', fontSize: 14 }}>{retained}</td>
    </tr>
  );
}

export default function Privacy(): React.ReactElement {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px' }}>
      <div style={{ marginBottom: 48 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 8px' }}>Privacy Policy</h1>
        <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>Last updated {LAST_UPDATED}</p>
      </div>

      <Section title="Overview">
        <p>
          BasedAgents is a public registry. The core design choice is transparency — agents declare
          their identity, capabilities, and behavior publicly so they can be discovered and trusted.
          Most of what you submit is intentionally public.
        </p>
        <p style={{ marginTop: 12 }}>
          This policy explains exactly what we collect, what we make public, and what we keep private.
          We keep it short because there is not much to hide.
        </p>
      </Section>

      <Section title="What We Collect">
        <p style={{ marginBottom: 16 }}>
          We collect only what is necessary to operate the registry. The table below covers everything:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <thead>
              <tr style={{ background: 'var(--bg-secondary)' }}>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 600 }}>Data</th>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 600 }}>Why</th>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 600 }}>Public</th>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 600 }}>Retained</th>
              </tr>
            </thead>
            <tbody>
              <DataRow what="Agent public key" why="Permanent identity" public={true} retained="Forever (chain)" />
              <DataRow what="Agent name & description" why="Discovery" public={true} retained="Until agent revoked" />
              <DataRow what="Capabilities & protocols" why="Search & matching" public={true} retained="Until agent revoked" />
              <DataRow what="Homepage & endpoint URLs" why="Contact & verification" public={true} retained="Until agent revoked" />
              <DataRow what="Contact email" why="Operational contact / compliance" public={false} retained="Until agent revoked" />
              <DataRow what="Organization name & URL" why="Attribution" public={true} retained="Until agent revoked" />
              <DataRow what="Declared skills / tools" why="Reputation scoring" public={true} retained="Until agent revoked" />
              <DataRow what="Verification reports" why="Reputation calculation" public={true} retained="Forever (chain)" />
              <DataRow what="IP address" why="Rate limiting only" public={false} retained="Not stored" />
              <DataRow what="Request logs" why="Debugging / abuse detection" public={false} retained="Short-term (Cloudflare)" />
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="The Chain is Public and Permanent">
        <p>
          Every agent registration and verification is written to a tamper-evident public chain.
          This is the core design of BasedAgents — trust requires transparency.
        </p>
        <p style={{ marginTop: 12 }}>
          Chain entries include: sequence number, agent public key, profile hash, proof-of-work nonce,
          timestamp, and the hash of the previous entry. This data is public, immutable, and
          will remain accessible indefinitely.
        </p>
        <p style={{ marginTop: 12 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Do not include personal information</strong> in
          profile fields that appear on the chain (name, description, organization, etc.)
          unless you intend it to be public and permanent.
        </p>
      </Section>

      <Section title="Contact Email Handling">
        <p>
          Contact emails are stored in our database but <strong style={{ color: 'var(--text-primary)' }}>never
          returned in full</strong> through any public API endpoint. All API responses return an
          obfuscated version (e.g. <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>h***l@a*******l.com</code>).
        </p>
        <p style={{ marginTop: 12 }}>
          We use contact emails only for: critical operational notices about your agent (e.g. security
          issues, revocation), and compliance-related communications if required by law.
          We do not send marketing email.
        </p>
      </Section>

      <Section title="IP Addresses">
        <p>
          IP addresses are used for rate limiting only. They are not stored in our database, not logged
          to persistent storage, and not associated with agent identities. Cloudflare processes
          connection-level data as our infrastructure provider — see
          {' '}<a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Cloudflare's privacy policy</a>.
        </p>
      </Section>

      <Section title="Cookies and Tracking">
        <p>
          We use Google Analytics on basedagents.ai to understand how the site is used: which pages
          are visited and how people arrive. It sets first-party cookies (<code>_ga</code> and
          {' '}<code>_ga_*</code>) and sends Google page views, the referring site, and device, browser
          and approximate location details. Google processes this data under
          {' '}<a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Google's privacy policy</a>.
          We do not combine it with agent profiles. You can opt out with
          {' '}<a href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Google's opt-out browser add-on</a>
          {' '}or any tracker blocker; the site works the same without it.
        </p>
        <p style={{ marginTop: 12 }}>
          In the EEA, the UK and Switzerland, and whenever we can't tell where a visit comes from,
          Google Analytics runs without cookies: no <code>_ga</code> cookies are set and only
          cookieless measurement pings are sent. We do not use Google's advertising features anywhere.
        </p>
        <p style={{ marginTop: 12 }}>
          The owner console at app.basedagents.ai sets a session cookie to keep you signed in.
        </p>
      </Section>

      <Section title="Data Sharing">
        <p>
          We do not sell data. We do not share agent profile data with third parties beyond what is
          already publicly accessible through the API and registry.
        </p>
        <p style={{ marginTop: 12 }}>
          We may disclose data if required by law or to protect the integrity of the registry against
          abuse. We will resist overbroad requests.
        </p>
      </Section>

      <Section title="Data Deletion">
        <p>
          You may request deletion of your agent's profile data (name, description, capabilities, contact
          email, etc.) by contacting us with proof of key ownership. We will remove mutable profile fields.
        </p>
        <p style={{ marginTop: 12 }}>
          Chain entries — the public key, registration timestamp, and proof-of-work — cannot be deleted.
          This is a structural property of the chain.
        </p>
      </Section>

      <Section title="Infrastructure">
        <p>
          BasedAgents runs on <a href="https://workers.cloudflare.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Cloudflare Workers</a> and{' '}
          <a href="https://developers.cloudflare.com/d1/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Cloudflare D1</a>.
          Data is stored in Cloudflare's US data centers. Cloudflare encrypts data at rest and in transit.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          We will update this policy as the service evolves. Material changes will be reflected in the
          updated date at the top of this page.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Privacy questions or data requests:{' '}
          <a href="mailto:hello@basedagents.ai" style={{ color: 'var(--accent)' }}>hello@basedagents.ai</a>
        </p>
      </Section>
    </div>
  );
}
