import { Link } from "react-router";

import { PageHeader } from "../components/shell/PageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { isNavItemVisible } from "../components/shell/nav";

const domainLinks = {
  rentalPricing: {
    primary: { href: "/financial?tab=quote", navKey: "financial" },
    evidence: {
      href: "/reporting?source=intelligence&domain=rental-pricing",
      navKey: "reporting",
    },
    workflow: {
      href: "/approvals?source=intelligence&domain=rental-pricing",
      navKey: "approvals",
    },
  },
  assetLifecycle: {
    primary: { href: "/financial?tab=assetCost", navKey: "financial" },
    evidence: { href: "/equipment?source=intelligence", navKey: "equipment" },
    workflow: {
      href: "/settings/workflows?domain=asset-lifecycle",
      navKey: "workflows",
    },
  },
  reservePlanning: {
    primary: {
      href: "/ops?source=intelligence&domain=reserve-planning",
      navKey: "ops",
    },
    evidence: {
      href: "/equipment?source=intelligence&view=availability",
      navKey: "equipment",
    },
    workflow: {
      href: "/catalog?source=intelligence&domain=inventory-policy",
      navKey: "catalog",
    },
  },
  workforceSlo: {
    primary: {
      href: "/kpi?source=intelligence&domain=workforce-slo",
      navKey: "kpi",
    },
    evidence: {
      href: "/settings/employees?source=intelligence",
      navKey: "employees",
    },
    workflow: {
      href: "/settings/workflows?domain=capacity-plan",
      navKey: "workflows",
    },
  },
  procurement: {
    primary: { href: "/financial?tab=purchase", navKey: "financial" },
    evidence: {
      href: "/reporting?source=intelligence&domain=procurement",
      navKey: "reporting",
    },
    workflow: {
      href: "/approvals?source=procurement-scenario",
      navKey: "approvals",
    },
  },
  maintenanceCycles: {
    primary: { href: "/inspection?source=intelligence", navKey: "inspection" },
    evidence: { href: "/daily-plan?source=intelligence", navKey: "daily-plan" },
    workflow: { href: "/dispatch?source=intelligence", navKey: "dispatch" },
  },
  dataQuality: {
    primary: { href: "/integrity?source=intelligence", navKey: "integrity" },
    evidence: {
      href: "/reporting?source=intelligence&domain=data-quality",
      navKey: "reporting",
    },
    workflow: {
      href: "/settings/policy?source=intelligence",
      navKey: "policy",
    },
  },
  mesReadiness: {
    primary: { href: "/settings/org?source=mes-readiness", navKey: "org" },
    evidence: { href: "/catalog?source=mes-readiness", navKey: "catalog" },
    workflow: {
      href: "/settings/workflows?domain=mes-readiness",
      navKey: "workflows",
    },
  },
} as const;

const readinessTone = {
  governed: "border-emerald-200 bg-emerald-50 text-emerald-900",
  needsLineage: "border-amber-200 bg-amber-50 text-amber-950",
  future: "border-slate-200 bg-slate-50 text-slate-800",
} as const;

const commandActionNavKeys = {
  "/kpi?source=intelligence": "kpi",
  "/financial?source=intelligence": "financial",
  "/integrity?source=intelligence": "integrity",
  "/reporting?source=intelligence": "reporting",
} as const;

export function OperationsIntelligencePage() {
  const t = ko.intelligence;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <div className="grid gap-5">
        <OperationsIntelligenceCommandCenter />
        <ScenarioReadinessMatrix />
        <DecisionDomainCards />
        <GovernanceGateRail />
      </div>
    </>
  );
}

function OperationsIntelligenceCommandCenter() {
  const t = ko.intelligence.command;
  const { session } = useAuth();
  const actions = t.actions.filter((action) => {
    const navKey = commandActionNavKeys[action.href];
    return isNavItemVisible(
      navKey,
      session?.roles,
      session?.group_roles,
      session?.feature_grants,
    );
  });

  return (
    <Card className="grid gap-4 border-ink/10 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{t.badge}</Badge>
            <span className="text-sm font-semibold text-steel">
              {t.scope}
            </span>
          </div>
          <h2 className="text-xl font-semibold text-ink">{t.title}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button key={action.href} asChild variant="secondary" size="sm">
              <Link to={action.href}>{action.label}</Link>
            </Button>
          ))}
        </div>
      </div>

      <dl className="grid gap-3 text-sm md:grid-cols-4">
        {t.metrics.map((metric) => (
          <div
            key={metric.label}
            className="rounded-lg border border-line bg-muted-panel p-3"
          >
            <dt className="text-xs font-semibold uppercase tracking-wide text-steel">
              {metric.label}
            </dt>
            <dd className="mt-1 text-lg font-semibold text-ink">
              {metric.value}
            </dd>
            <dd className="mt-1 text-xs text-steel">{metric.hint}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function ScenarioReadinessMatrix() {
  const t = ko.intelligence.readiness;
  return (
    <Card className="grid gap-4" aria-labelledby="intelligence-readiness-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-steel">
            {t.eyebrow}
          </p>
          <h2 id="intelligence-readiness-title" className="text-lg font-semibold text-ink">
            {t.title}
          </h2>
        </div>
        <Badge>{t.badge}</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {t.items.map((item) => (
          <div
            key={item.label}
            className={`rounded-lg border p-3 ${readinessTone[item.tone]}`}
          >
            <p className="text-sm font-semibold">{item.label}</p>
            <p className="mt-1 text-sm">{item.status}</p>
            <p className="mt-2 text-xs opacity-80">{item.next}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function DecisionDomainCards() {
  const t = ko.intelligence.domains;
  const { session } = useAuth();
  return (
    <section aria-labelledby="intelligence-domains-title" className="grid gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-steel">
          {t.eyebrow}
        </p>
        <h2 id="intelligence-domains-title" className="text-lg font-semibold text-ink">
          {t.title}
        </h2>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {t.items.map((domain) => {
          const links = domainLinks[domain.key];
          const actions = [
            { ...links.primary, label: domain.links.primary },
            { ...links.evidence, label: domain.links.evidence },
            { ...links.workflow, label: domain.links.workflow },
          ].filter((action) =>
            isNavItemVisible(
              action.navKey,
              session?.roles,
              session?.group_roles,
              session?.feature_grants,
            ),
          );
          return (
            <Card key={domain.key} className="grid gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-ink">{domain.title}</h3>
                  <p className="mt-1 text-sm text-steel">{domain.outcome}</p>
                </div>
                <Badge>{domain.object}</Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {domain.signals.map((signal) => (
                  <div
                    key={signal.label}
                    className="rounded-md border border-line bg-muted-panel p-2"
                  >
                    <p className="text-xs font-semibold text-steel">
                      {signal.label}
                    </p>
                    <p className="mt-1 text-sm font-medium text-ink">
                      {signal.value}
                    </p>
                  </div>
                ))}
              </div>
              {actions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {actions.map((action, index) => (
                    <Button
                      key={action.href}
                      asChild
                      variant={index === 0 ? "secondary" : "ghost"}
                      size="sm"
                    >
                      <Link to={action.href}>{action.label}</Link>
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="rounded-md border border-line bg-muted-panel px-3 py-2 text-sm text-steel">
                  {t.restricted}
                </p>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function GovernanceGateRail() {
  const t = ko.intelligence.governance;
  return (
    <Card className="grid gap-4" aria-labelledby="intelligence-governance-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-steel">
          {t.eyebrow}
        </p>
        <h2 id="intelligence-governance-title" className="text-lg font-semibold text-ink">
          {t.title}
        </h2>
      </div>
      <div className="grid gap-3 lg:grid-cols-4">
        {t.items.map((item) => (
          <div key={item.title} className="rounded-lg border border-line p-3">
            <p className="text-sm font-semibold text-ink">{item.title}</p>
            <p className="mt-1 text-sm text-steel">{item.body}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
