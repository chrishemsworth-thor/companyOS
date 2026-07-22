import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ToastProvider } from "./components/Toast";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Departments } from "./pages/Departments";
import { AgentActivity } from "./pages/AgentActivity";
import { Users } from "./pages/Users";
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
});

function RequireAuth({ children }: { children: ReactElement }) {
  const { status, user, tenant } = useAuth();
  const location = useLocation();
  if (status === "loading") return <div className="login-screen">Loading…</div>;
  if (status === "anonymous") return <Navigate to="/login" replace />;
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
