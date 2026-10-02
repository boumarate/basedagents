import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { OwnerProvider, useOwner } from './state/session.js';
import { rememberIntent } from './lib/intent.js';
import { useStaleTabGuard } from './lib/version.js';
import Layout from './components/Layout.js';
import Login from './pages/Login.js';
import Start from './pages/Start.js';
import Recover from './pages/Recover.js';
import LinkPage from './pages/Link.js';
import Claim from './pages/Claim.js';
import Invited from './pages/Invited.js';
import Home from './pages/Home.js';
import Welcome from './pages/Welcome.js';
import Approvals from './pages/Approvals.js';
import AgentPage from './pages/Agent.js';
import AddAgent from './pages/AddAgent.js';
import Delegations from './pages/Delegations.js';
import Vault from './pages/Vault.js';
import Billing from './pages/Billing.js';
import BoardPage from './pages/Board.js';
import TasksPage from './pages/Tasks.js';
import Explore from './pages/Explore.js';
import TaskNew from './pages/TaskNew.js';
import TaskReview from './pages/TaskReview.js';
import SignWallet from './pages/SignWallet.js';
import AdminFeedback from './pages/AdminFeedback.js';
import TestingAudits from './pages/testing/Audits.js';
import TestingIntake from './pages/testing/Intake.js';
import TestingRequestDetail from './pages/testing/RequestDetail.js';
import TestingOrder from './pages/testing/OrderDetail.js';
import TestingReport from './pages/testing/ReportView.js';
import TestingAdminQueue from './pages/testing/AdminQueue.js';
import TestingAdminRequest from './pages/testing/AdminRequest.js';
import TestingAdminOrder from './pages/testing/AdminOrder.js';

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
      </BrowserRouter>
    </OwnerProvider>
  );
}
