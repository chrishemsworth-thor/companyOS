import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ToastProvider } from "./components/Toast";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { AcceptInvite } from "./pages/AcceptInvite";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { Dashboard } from "./pages/Dashboard";
import { Departments } from "./pages/Departments";
import { AgentActivity } from "./pages/AgentActivity";
import { Users } from "./pages/Users";
import { MyProfile } from "./pages/me/MyProfile";
import { InvoiceList } from "./pages/finance/InvoiceList";
import { InvoiceDetail } from "./pages/finance/InvoiceDetail";
import { Ledger } from "./pages/finance/Ledger";
import { CustomerList } from "./pages/crm/CustomerList";
import { CustomerDetail } from "./pages/crm/CustomerDetail";
import { LeadList } from "./pages/crm/LeadList";
import { LeadDetail } from "./pages/crm/LeadDetail";
import { DealList } from "./pages/crm/DealList";
import { DealDetail } from "./pages/crm/DealDetail";
import { TicketList } from "./pages/support/TicketList";
import { TicketDetail } from "./pages/support/TicketDetail";
import { ProjectList } from "./pages/build/ProjectList";
import { ProjectDetail } from "./pages/build/ProjectDetail";
import { IssueList } from "./pages/build/IssueList";
import { IssueDetail } from "./pages/build/IssueDetail";
import { QuoteList } from "./pages/quotes/QuoteList";
import { QuoteDetail } from "./pages/quotes/QuoteDetail";
import { CompanyProfile } from "./pages/settings/CompanyProfile";
import { QuoteBranding } from "./pages/settings/QuoteBranding";
import { EmployeeList } from "./pages/people/EmployeeList";
import { EmployeeDetail } from "./pages/people/EmployeeDetail";
import { TeamList } from "./pages/people/TeamList";
import { Onboarding } from "./pages/onboarding/Onboarding";
import { ApprovalsInbox } from "./pages/approvals/ApprovalsInbox";
import { MyLeave } from "./pages/leave/MyLeave";
import { TeamLeaveCalendar } from "./pages/leave/TeamLeaveCalendar";
import { LeaveRequestDetail } from "./pages/leave/LeaveRequestDetail";
import { ClaimDetail } from "./pages/claims/ClaimDetail";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
});

function RequireAuth({ children }: { children: ReactElement }) {
  const { status, user, tenant, can } = useAuth();
  const location = useLocation();
  if (status === "loading") return <div className="login-screen">Loading…</div>;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  // The self-service tier holds no business capability, so the dashboard (which
  // reads insights) would only 403 for them. Land them on their own record —
  // the one surface their role is for (PRD-008).
  if (!can("insights:read") && location.pathname === "/") {
    return <Navigate to="/me" replace />;
  }
  // First-run: send the company's admin into the setup journey until it is
  // finished or dismissed. Only admins — other roles can't create teams or
  // employees, so the wizard would be a dead end for them.
  if (
    tenant?.onboarded_at === null &&
    user?.role === "admin" &&
    location.pathname !== "/onboarding"
  ) {
    return <Navigate to="/onboarding" replace />;
  }
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="onboarding" element={<Onboarding />} />
        <Route path="departments" element={<Departments />} />
        {/* Cross-module approvals inbox (PRD-007). Not under a department: a
            manager's queue spans leave, claims and quotes. */}
        <Route path="approvals" element={<ApprovalsInbox />} />
        {/* Read-only, and the destination `subjectRoutes.ts` maps `expense_claim`
            to — every link here comes from the inbox or the bell. Filing a claim
            from the console is PRD-006 P1. Sits inside the authenticated layout
            with no capability guard of its own: the API answers per row (owner,
            approver, or finance), which is the boundary that actually matters. */}
        <Route path="claims/:id" element={<ClaimDetail />} />
        <Route path="agent" element={<AgentActivity />} />
        <Route path="invoices" element={<InvoiceList />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="ledger" element={<Ledger />} />
        <Route path="leads" element={<LeadList />} />
        <Route path="leads/:id" element={<LeadDetail />} />
        <Route path="customers" element={<CustomerList />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="deals" element={<DealList />} />
        <Route path="deals/:id" element={<DealDetail />} />
        <Route path="quotes" element={<QuoteList />} />
        <Route path="quotes/:id" element={<QuoteDetail />} />
        <Route path="settings/company" element={<CompanyProfile />} />
        <Route path="settings/quote-branding" element={<QuoteBranding />} />
        <Route path="tickets" element={<TicketList />} />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="projects" element={<ProjectList />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="issues" element={<IssueList />} />
        <Route path="issues/:id" element={<IssueDetail />} />
        <Route path="employees" element={<EmployeeList />} />
        <Route path="employees/:id" element={<EmployeeDetail />} />
        <Route path="teams" element={<TeamList />} />
        <Route path="users" element={<Users />} />
        <Route path="me" element={<MyProfile />} />
        {/* Leave (PRD-006c). Like /approvals these are not under a department:
            the request/balance screens are on the `self` axis and must be
            reachable by the self-service tier, which sees no departments at all.
            The calendar IS a People tool and is listed in the department
            registry, but it shares this route prefix. */}
        <Route path="leave" element={<MyLeave />} />
        <Route path="leave/calendar" element={<TeamLeaveCalendar />} />
        <Route path="leave/requests/:id" element={<LeaveRequestDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
