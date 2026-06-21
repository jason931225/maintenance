import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/auth";
import { SiteGeographyPanel } from "../features/equipment/SiteGeographyPanel";
import { ko } from "../i18n/ko";

/**
 * Admin-only (RequireAdminRoute) customer-site management (GitHub #13): register
 * each site's location (address + coordinates) and its representative contact.
 * Reuses SiteGeographyPanel, which lists the org's sites and PATCHes
 * /api/v1/sites/{id}.
 */
export function SitesPage() {
  const { api } = useAuth();
  return (
    <div className="grid gap-6">
      <PageHeader title={ko.sites.title} description={ko.sites.description} />
      <SiteGeographyPanel api={api} />
    </div>
  );
}
