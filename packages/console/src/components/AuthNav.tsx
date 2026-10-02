/**
 * Top nav for the public auth pages (e.g. /start). The console lives on a
 * different origin from the marketing site, so the section links are real
 * cross-origin <a>s back to basedagents.ai. The brand doubles as "back home".
 */
export function AuthNav() {
  return (
    <nav className="auth-nav">
      <a className="auth-nav-brand" href="https://basedagents.ai" title="Back to basedagents.ai">
        <span className="brand-mark">◈</span> BasedAgents
      </a>
      <div className="auth-nav-links">
        <a href="https://basedagents.ai/tasks">Tasks</a>
        <a href="https://basedagents.ai/registry">Registry</a>
        <a href="https://basedagents.ai/docs/getting-started">Docs</a>
        <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">GitHub</a>
        <a className="auth-nav-signin" href="/login">Sign in</a>
      </div>
    </nav>
  );
}
