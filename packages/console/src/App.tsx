import { lazy, Suspense } from 'react';
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
// download and execute the WHOLE console (30+ pages incl. the keyring crypto
// pulled in by /claim and /sign-wallet) before anything painted — the LCP
// problem the Core Web Vitals report pinned on /login.
const Start = lazy(() => import('./pages/Start.js'));
const Recover = lazy(() => import('./pages/Recover.js'));
const LinkPage = lazy(() => import('./pages/Link.js'));
const Claim = lazy(() => import('./pages/Claim.js'));
const Invited = lazy(() => import('./pages/Invited.js'));
const Home = lazy(() => import('./pages/Home.js'));
const Welcome = lazy(() => import('./pages/Welcome.js'));
const Approvals = lazy(() => import('./pages/Approvals.js'));
const AgentPage = lazy(() => import('./pages/Agent.js'));
const AddAgent = lazy(() => import('./pages/AddAgent.js'));
const Delegations = lazy(() => import('./pages/Delegations.js'));
const Vault = lazy(() => import('./pages/Vault.js'));
const Billing = lazy(() => import('./pages/Billing.js'));
const BoardPage = lazy(() => import('./pages/Board.js'));
const TasksPage = lazy(() => import('./pages/Tasks.js'));
const Explore = lazy(() => import('./pages/Explore.js'));
const TaskNew = lazy(() => import('./pages/TaskNew.js'));
const TaskReview = lazy(() => import('./pages/TaskReview.js'));
const SignWallet = lazy(() => import('./pages/SignWallet.js'));
const AdminFeedback = lazy(() => import('./pages/AdminFeedback.js'));
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

export default function App() {
  return (
    <OwnerProvider>
      <StaleTabBanner />
      <BrowserRouter>
        <Suspense fallback={<div className="boot">Loading…</div>}>
          <Routes>
            <Route path="/login" element={<Login />} />
            {/* /start is the web "Get started" door; /signup 301s to it. */}
            <Route path="/start" element={<Start />} />
            <Route path="/signup" element={<Navigate to="/start" replace />} />
            <Route path="/recover" element={<Recover />} />
            {/* The onboarding ladder's public pages (no session yet). */}
            <Route path="/link" element={<LinkPage />} />
            <Route path="/claim" element={<Claim />} />
            <Route path="/invited" element={<Invited />} />
            {/* Public audit intake: no account — every request is operator-
                reviewed, so submission needs only an email (signed-in visitors
                are redirected to the in-app form). */}
            <Route path="/testing/request" element={<TestingIntake />} />
            <Route path="/sign-wallet" element={<SignWallet />} />
            <Route element={<Protected />}>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<Home />} />
              <Route path="/welcome" element={<Welcome />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/agents" element={<AgentsIndex />} />
              <Route path="/agents/new" element={<AddAgent />} />
              <Route path="/agents/:agentId" element={<AgentPage />} />
              <Route path="/delegations" element={<Delegations />} />
              <Route path="/explore" element={<Explore />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/new" element={<TaskNew />} />
              <Route path="/tasks/:taskId" element={<TaskReview />} />
              <Route path="/board" element={<BoardPage />} />
              <Route path="/vault" element={<Vault />} />
              <Route path="/settings/billing" element={<Billing />} />
              <Route path="/admin/feedback" element={<AdminFeedback />} />
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
      </BrowserRouter>
    </OwnerProvider>
  );
}
