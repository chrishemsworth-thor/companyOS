import { PageHeader } from "../../components/PageHeader";
import { CompanyProfileForm } from "../../components/CompanyProfileForm";

export function CompanyProfile() {
  return (
    <div>
      <PageHeader title="Company Profile" />
      <p className="mb-4 text-sm text-muted">
        This is the seller identity that appears in the <strong>From</strong> block of every quote,
        and where the company-wide base currency is set.
      </p>
      <CompanyProfileForm />
    </div>
  );
}
