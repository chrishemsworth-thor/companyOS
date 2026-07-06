import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { InvoiceList } from "./pages/finance/InvoiceList";
import { InvoiceDetail } from "./pages/finance/InvoiceDetail";
import { Ledger } from "./pages/finance/Ledger";
import { CustomerList } from "./pages/crm/CustomerList";
import { CustomerDetail } from "./pages/crm/CustomerDetail";
import { DealList } from "./pages/crm/DealList";
import { DealDetail } from "./pages/crm/DealDetail";
import { TicketList } from "./pages/support/TicketList";
import { TicketDetail } from "./pages/support/TicketDetail";
import { ProjectList } from "./pages/build/ProjectList";
import { ProjectDetail } from "./pages/build/ProjectDetail";
import { IssueList } from "./pages/build/IssueList";
import { IssueDetail } from "./pages/build/IssueDetail";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
});

function RequireAuth({ children }: { children: ReactElement }) {
  const { apiKey } = useAuth();
  if (!apiKey) return <Navigate to="/login" replace />;
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
        <Route path="invoices" element={<InvoiceList />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="ledger" element={<Ledger />} />
        <Route path="customers" element={<CustomerList />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="deals" element={<DealList />} />
        <Route path="deals/:id" element={<DealDetail />} />
        <Route path="tickets" element={<TicketList />} />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="projects" element={<ProjectList />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="issues" element={<IssueList />} />
        <Route path="issues/:id" element={<IssueDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
