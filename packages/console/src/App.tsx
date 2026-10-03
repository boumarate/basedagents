import { Component, lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { OwnerProvider, useOwner } from './state/session.js';
import { rememberIntent } from './lib/intent.js';
import { useStaleTabGuard } from './lib/version.js';
import Layout from './components/Layout.js';
// /login stays in the entry chunk: it is the console's main cold-entry URL
// (external links and every logged-out redirect land there), so its first
// paint must not wait on a second JS round-trip.
import Login from './pages/Login.js';
// Every other page is code-split. Before this, a cold hit on /login had to
// download and execute the WHOLE console before anything painted — the LCP
// problem the Core Web Vitals report pinned on /login.
const Start = lazy(() => import('./pages/Start.js'));
const Recover = lazy(() => import('./pages/Recover.js'));
const Home = lazy(() => import('./pages/Home.js'));
const AgentPage = lazy(() => import('./pages/Agent.js'));
const AddAgent = lazy(() => import('./pages/AddAgent.js'));
const BoardPage = lazy(() => import('./pages/Board.js'));
const TasksPage = lazy(() => import('./pages/Tasks.js'));
const Explore = lazy(() => import('./pages/Explore.js'));
const TaskNew = lazy(() => import('./pages/TaskNew.js'));
const TaskReview = lazy(() => import('./pages/TaskReview.js'));
const SignWallet = lazy(() => import('./pages/SignWallet.js'));
const AdminFeedback = lazy(() => import('./pages/AdminFeedback.js'));
const AdminAcquisition = lazy(() => import('./pages/AdminAcquisition.js'));
const TestingAudits = lazy(() => import('./pages/testing/Audits.js'));
const TestingIntake = lazy(() => import('./pages/testing/Intake.js'));
const TestingRequestDetail = lazy(() => import('./pages/testing/RequestDetail.js'));
const TestingOrder = lazy(() => import('./pages/testing/OrderDetail.js'));
const TestingReport = lazy(() => import('./pages/testing/ReportView.js'));
const TestingAdminQueue = lazy(() => import('./pages/testing/AdminQueue.js'));
const TestingAdminRequest = lazy(() => import('./pages/testing/AdminRequest.js'));
const TestingAdminOrder = lazy(() => import('./pages/testing/AdminOrder.js'));

/** /agents with nothing after it: first agent when one exists, else the add page. */
function AgentsIndex() {
  const { owner } = useOwner();
  const first = owner?.delegations.find((d) => d.status === 'active');
  return <Navigate to={first ? `/agents/${encodeURIComponent(first.agent_id)}` : '/agents/new'} replace />;
}

/** Gate the console behind a live look-session; render the shell once in. */
function Protected() {
  const { owner, loading } = useOwner();
  const location = useLocation();
  if (loading) return <div className="boot">Loading…</div>;
  if (!owner) {
    // Remember where they were headed so sign-in returns them here, not /home.
    rememberIntent(location.pathname + location.search);
    return <Navigate to="/login" replace />;
  }
  return <Layout />;
}

/** Fixed banner shown when this tab's bundle is older than the deploy. */
function StaleTabBanner() {
  const stale = useStaleTabGuard();
  if (!stale) return null;
  return (
    <div className="stale-banner" role="status">
      <span>This page has been updated since this tab loaded.</span>
      <button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
        Refresh
      </button>
    </div>
  );
}

/**
 * Recovery for a lazy page chunk that fails to load (network blip, or a
 * redeploy swept the old hashed chunk this tab's bundle still points at).
 * Without it the route throws and the console goes blank. Refresh refetches
 * index.html, which repairs both causes; in-app navigation also clears the
 * error (resetKey changes), so a transient blip recovers without a reload.
 */
class ChunkErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(prev: { resetKey: string }): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="boot" role="alert">
          <span>This page didn&rsquo;t load — check your connection.</span>
          <button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** The boundary needs the location so a navigation retries after a failure. */
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ChunkErrorBoundary resetKey={location.key}>{children}</ChunkErrorBoundary>;
}

export default function App() {
  return (
    <OwnerProvider>
      <StaleTabBanner />
      <BrowserRouter>
        <RoutedErrorBoundary>
          <Suspense fallback={<div className="boot">Loading…</div>}>
            <Routes>
              {/* Public pages (no session yet): sign in, get started, recover. Their
                  magic links land back on the same paths as /login#t=, /start#t=
                  and /recover#t=. */}
              <Route path="/login" element={<Login />} />
              <Route path="/start" element={<Start />} />
              <Route path="/signup" element={<Navigate to="/start" replace />} />
              <Route path="/recover" element={<Recover />} />
              {/* Public audit intake: no account — every request is operator-
                  reviewed, so submission needs only an email (signed-in visitors
                  are redirected to the in-app form). */}
              <Route path="/testing/request" element={<TestingIntake />} />
              <Route path="/sign-wallet" element={<SignWallet />} />
              <Route element={<Protected />}>
                <Route path="/" element={<Navigate to="/home" replace />} />
                <Route path="/home" element={<Home />} />
                <Route path="/agents" element={<AgentsIndex />} />
                <Route path="/agents/new" element={<AddAgent />} />
                <Route path="/agents/:agentId" element={<AgentPage />} />
                {/* The old manager page: connecting an agent by its id lives on /agents/new now. */}
                <Route path="/delegations" element={<Navigate to="/agents/new" replace />} />
                <Route path="/explore" element={<Explore />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/tasks/new" element={<TaskNew />} />
                <Route path="/tasks/:taskId" element={<TaskReview />} />
                <Route path="/board" element={<BoardPage />} />
                <Route path="/admin/feedback" element={<AdminFeedback />} />
                <Route path="/admin/acquisition" element={<AdminAcquisition />} />
                {/* Agent Testing (customer + operator) */}
                <Route path="/testing" element={<TestingAudits />} />
                <Route path="/testing/new" element={<TestingIntake />} />
                <Route path="/testing/requests/:requestId" element={<TestingRequestDetail />} />
                <Route path="/testing/requests/:requestId/edit" element={<TestingIntake />} />
                <Route path="/testing/orders/:orderId" element={<TestingOrder />} />
                <Route path="/testing/reports/:reportId" element={<TestingReport />} />
                <Route path="/testing/admin" element={<TestingAdminQueue />} />
                <Route path="/testing/admin/requests/:requestId" element={<TestingAdminRequest />} />
                <Route path="/testing/admin/orders/:orderId" element={<TestingAdminOrder />} />
              </Route>
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </Suspense>
        </RoutedErrorBoundary>
      </BrowserRouter>
    </OwnerProvider>
  );
}
