import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import RegistryShell from './components/RegistryShell';
import Home from './pages/Home';
import Marketplace from './pages/Marketplace';
import Directory from './pages/Directory';
import AgentProfile from './pages/AgentProfile';
import ChainExplorer from './pages/ChainExplorer';
import GettingStarted from './pages/GettingStarted';
import Status from './pages/Status';
import Whois from './pages/Whois';
import Terms from './pages/Terms';
import About from './pages/About';
import Privacy from './pages/Privacy';
import Register from './pages/Register';
import Integrations from './pages/Integrations';
import Keyring from './pages/Keyring';
import Testing from './pages/Testing';
import TestingSample from './pages/TestingSample';
import Blog from './pages/Blog';
import BlogPost from './pages/BlogPost';
import TaskDetail from './pages/TaskDetail';
import Scan from './pages/Scan';
import ScanList from './pages/ScanList';
import Board from './pages/Board';
import BoardThread from './pages/BoardThread';
import { AgentAuthProvider } from './hooks/useAgentAuth';

export const isRegistrySubdomain =
  typeof window !== 'undefined' &&
  window.location.hostname.startsWith('registry.');

// Wrap a page in RegistryShell when on the registry subdomain
function R({ children }: { children: React.ReactNode }): React.ReactElement {
  return <RegistryShell>{children}</RegistryShell>;
}

/**
 * `/registry` and `/docs/agents` are STATIC marketing pages, served by
 * Cloudflare Pages as assets ahead of the SPA. A direct load never reaches the
 * SPA; but if internal SPA navigation lands here, do a real page load so the
 * served file is returned instead of a blank route.
 */
function FullReload({ to }: { to: string }): null {
  React.useEffect(() => { window.location.replace(to); }, [to]);
  return null;
}

/**
 * `/app` was the SPA-shell path of the (reverted) static-homepage attempt.
 * Browsers that hit it during that window cached a permanent (308) redirect to
 * `/app`, so a plain `/` load can still land here. Render the homepage AND
 * rewrite the URL to `/` WITHOUT a navigation (a real navigation could re-hit
 * the cached 308 and loop), so those users see the homepage and the address bar
 * heals itself.
 */
function LegacyApp(): React.ReactElement {
  React.useEffect(() => {
    try { window.history.replaceState(null, '', '/' + window.location.hash); } catch { /* ignore */ }
  }, []);
  return <Home />;
}

/**
 * The route tree without a router, so the same tree renders in the browser
 * (BrowserRouter, below) and at build time (StaticRouter in entry-server.tsx).
 */
export function AppRoutes(): React.ReactElement {
  return (
    <AgentAuthProvider>
      <Layout>
        <Routes>
          {isRegistrySubdomain ? (
            // ── Registry subdomain routes ──────────────────────────────
            <>
              <Route path="/"              element={<R><Directory bare /></R>} />
              <Route path="/agents"        element={<R><Directory bare /></R>} />
              <Route path="/registry"      element={<R><Directory bare /></R>} />
              <Route path="/whois"         element={<R><Whois /></R>} />
              <Route path="/board"         element={<R><Board bare /></R>} />
              <Route path="/board/:id"     element={<R><BoardThread bare /></R>} />
              <Route path="/chain"         element={<R><ChainExplorer /></R>} />
              <Route path="/scan"          element={<R><ScanList /></R>} />
              <Route path="/scan/:package" element={<R><Scan /></R>} />
              {/* Tasks redirects to main site */}
              <Route path="/tasks"         element={<RedirectToMain />} />
              <Route path="/tasks/:id"     element={<RedirectToMain />} />
              {/* Shared routes */}
              <Route path="/agents/:id"    element={<AgentProfile />} />
              <Route path="/agent/:name"   element={<AgentProfile />} />
              <Route path="/status"        element={<Status />} />
              <Route path="/register"      element={<Register />} />
              <Route path="/terms"         element={<Terms />} />
              <Route path="/privacy"       element={<Privacy />} />
            </>
          ) : (
            // ── Main site routes ───────────────────────────────────────
            <>
              {/* Homepage is the React Home route. /registry and /docs/agents
                  are STATIC leaf pages served by Pages ahead of the SPA — the
                  FullReload guards only fire if internal SPA navigation reaches
                  them. */}
              <Route path="/"                    element={<Home />} />
              <Route path="/registry"            element={<FullReload to="/registry" />} />
              <Route path="/docs/agents"         element={<FullReload to="/docs/agents" />} />
              <Route path="/tasks"               element={<Marketplace />} />
              <Route path="/tasks/:id"           element={<TaskDetail />} />
              <Route path="/agents"              element={<Directory />} />
              <Route path="/agents/:id"          element={<AgentProfile />} />
              <Route path="/agent/:name"         element={<AgentProfile />} />
              <Route path="/whois"               element={<Whois />} />
              <Route path="/board"               element={<Board />} />
              <Route path="/board/:id"           element={<BoardThread />} />
              <Route path="/scan"                element={<ScanList />} />
              <Route path="/scan/:package"       element={<Scan />} />
              <Route path="/chain"               element={<ChainExplorer />} />
              <Route path="/docs/getting-started" element={<GettingStarted />} />
              {/* /keyring is a static HTML page (served by Pages before the SPA
                  fallback) — required to read without JS. The old in-browser
                  demo lives on at /keyring/demo. */}
              <Route path="/keyring/demo"        element={<Keyring />} />
              <Route path="/testing"             element={<Testing />} />
              <Route path="/testing/sample"      element={<TestingSample />} />
              <Route path="/status"              element={<Status />} />
              <Route path="/register"            element={<Register />} />
              <Route path="/blog"                element={<Blog />} />
              <Route path="/blog/:slug"          element={<BlogPost />} />
              <Route path="/integrations"        element={<Integrations />} />
              <Route path="/about"               element={<About />} />
              <Route path="/terms"               element={<Terms />} />
              <Route path="/privacy"             element={<Privacy />} />
              {/* Legacy SPA-shell path from the reverted homepage attempt — some
                  browsers cached a 308 to it. Show the homepage and heal the URL. */}
              <Route path="/app"                 element={<LegacyApp />} />
              <Route path="/app/*"               element={<LegacyApp />} />
              {/* Catch-all: never render an empty <main> for an unknown path. */}
              <Route path="*"                    element={<Home />} />
            </>
          )}
        </Routes>
      </Layout>
    </AgentAuthProvider>
  );
}

export default function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

// Redirect to main site preserving the path
function RedirectToMain(): React.ReactElement {
  React.useEffect(() => {
    window.location.href = 'https://basedagents.ai' + window.location.pathname + window.location.search;
  }, []);
  return <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-tertiary)' }}>Redirecting…</div>;
}
