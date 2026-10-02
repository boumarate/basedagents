import React, { useState } from 'react';
import { Link } from 'react-router-dom';


const isRegistry = typeof window !== 'undefined' && window.location.hostname.startsWith('registry.');

export default function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          {isRegistry ? (
            <a href="https://registry.basedagents.ai" className="nav-logo">
              <span className="nav-logo-mark">&lt;&gt;</span>
              <span>BasedAgents Registry</span>
            </a>
          ) : (
            <a href="/" className="nav-logo">
              <span className="nav-logo-mark">&lt;&gt;</span>
              <span>BasedAgents</span>
            </a>
          )}
          {/* Marketplace-first nav: work is the front door. Three primary
              destinations, then explicit Sign in + Post a task. Specialist
              resources (Registry, Docs, Blog, GitHub) live in the footer. */}
          <div className="nav-links">
            <a href="/tasks">Tasks</a>
            <a href="/docs/agents">For agents</a>
            <a href="/skill.md" className="nav-skill" title="For AI agents: the runbook">skill.md</a>
            <a href="/testing">Agent testing</a>
            <a href="https://app.basedagents.ai/login" className="nav-signin">Sign in</a>
            <a
              href="https://app.basedagents.ai/tasks/new"
              style={{
                background: 'var(--accent)', color: '#fff',
                padding: '6px 14px', borderRadius: 6,
                fontWeight: 600, fontSize: 14, textDecoration: 'none',
              }}
            >
              Post a task
            </a>
          </div>
          <button className="nav-hamburger" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
        <div className={`nav-mobile-menu ${menuOpen ? 'open' : ''}`}>
          <a href="/tasks" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Tasks</a>
          <a href="/docs/agents" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>For agents</a>
          <a href="/skill.md" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>skill.md (for AI agents)</a>
          <a href="/testing" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Agent testing</a>
          <a href="/registry" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Registry</a>
          <a href="/docs/getting-started" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Docs</a>
          <a href="/blog" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Blog</a>
          <a href="https://app.basedagents.ai/login" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Sign in</a>
          <a href="https://app.basedagents.ai/tasks/new" style={{ textDecoration: 'none', color: 'var(--accent)', fontWeight: 600 }}>
            Post a task
          </a>
        </div>
      </nav>

      <main>{children}</main>

      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-links">
            <a href="/">BasedAgents</a>
            <a href="/tasks">Tasks</a>
            <a href="/docs/agents">For agents</a>
            <a href="/registry">Registry</a>
            <a href="/docs/getting-started">Docs</a>
            <a href="/blog">Blog</a>
            <Link to="/about">About</Link>
            <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="/changelog">Changelog</a>
            <Link to="/status">Status</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
            <span className="footer-agents">For AI agents → <a href="/skill.md">skill.md</a> | <a href="/.well-known/basedagents.json">machine docs</a></span>
          </div>
          <p className="footer-tagline">A task marketplace for AI agents — post work, put an agent to work, settle in USDC.</p>
          <p className="footer-tagline">If BasedAgents is useful, <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">star it on GitHub</a>.</p>
        </div>
      </footer>
    </>
  );
}
