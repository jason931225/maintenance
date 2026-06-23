import "leaflet/dist/leaflet.css";

import { MapPinned } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import { Link } from "react-router-dom";

import type {
  EquipmentSummary,
  SiteLocationGroup,
} from "../api/types";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useAuth } from "../context/auth";
import { ensureLeafletIcon } from "../features/dispatch/leafletIcon";
import { SubstitutionPanel } from "../features/equipment/SubstitutionPanel";
import { ko } from "../i18n/ko";

const t = ko.dispatchMap;

/** EquipmentManage holders (backend matrix: ADMIN/EXECUTIVE/SUPER_ADMIN). */
const EQUIPMENT_MANAGE_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

/**
 * Center the initial view on the geographic mean of the geocoded sites so the
 * first paint frames the real data, not an arbitrary world view. Falls back to
 * the Korean peninsula center when (defensively) called with no points.
 */
function centerOf(sites: SiteLocationGroup[]): [number, number] {
  const points = sites.filter(
    (s): s is SiteLocationGroup & { latitude: number; longitude: number } =>
      s.latitude !== null && s.longitude !== null,
  );
  if (points.length === 0) return [36.5, 127.8];
  const lat = points.reduce((sum, s) => sum + s.latitude, 0) / points.length;
  const lon = points.reduce((sum, s) => sum + s.longitude, 0) / points.length;
  return [lat, lon];
}

type LoadState = "loading" | "ready" | "error";

export function DispatchMapPage() {
  const { api, session } = useAuth();
  const canManage = hasAnyRole(session?.roles, EQUIPMENT_MANAGE_ROLES);
  const [sites, setSites] = useState<SiteLocationGroup[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [selectedSiteId, setSelectedSiteId] = useState<string>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoadState("loading");
      const response = await api.GET("/api/v1/equipment-by-location", { signal });
      if (response.data) {
        setSites(response.data.items);
        setLoadState("ready");
      } else if (!signal?.aborted) {
        setLoadState("error");
      }
    },
    [api],
  );

  useEffect(() => {
    ensureLeafletIcon();
    // Abort the initial load if the page unmounts before it resolves, so the
    // request can't setState (or escape to the network) after teardown. The load
    // is deferred to a microtask, so re-check the signal before issuing it in
    // case unmount already happened.
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [load]);

  const geocoded = useMemo(
    () => sites.filter((s) => s.latitude !== null && s.longitude !== null),
    [sites],
  );
  const ungeocoded = useMemo(
    () => sites.filter((s) => s.latitude === null || s.longitude === null),
    [sites],
  );
  const selectedSite = useMemo(
    () => sites.find((s) => s.site_id === selectedSiteId),
    [sites, selectedSiteId],
  );
  const center = useMemo(() => centerOf(geocoded), [geocoded]);

  return (
    <>
      <PageHeader title={t.title} description={t.description} />

      {loadState === "loading" ? (
        <SkeletonCards count={2} lines={3} />
      ) : null}

      {loadState === "error" ? (
        <PageError
          message={t.loadFailed}
          onRetry={() => {
            void load();
          }}
        />
      ) : null}

      {loadState === "ready" && geocoded.length === 0 ? (
        <EmptyState />
      ) : null}

      {loadState === "ready" && geocoded.length > 0 ? (
        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <Card className="overflow-hidden p-0">
            <MapContainer
              center={center}
              zoom={geocoded.length === 1 ? 13 : 7}
              scrollWheelZoom
              className="h-[28rem] w-full"
              // The map needs an explicit pixel height; the surrounding card
              // clips its rounded corners over the Leaflet tiles.
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {geocoded.map((site) => (
                <Marker
                  key={site.site_id}
                  position={[site.latitude as number, site.longitude as number]}
                  eventHandlers={{
                    click: () => {
                      setSelectedSiteId(site.site_id);
                    },
                  }}
                >
                  <Popup>
                    <span className="font-semibold">{site.site_name}</span>
                    <br />
                    {site.customer_name}
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </Card>

          <div className="grid gap-5">
            {selectedSite ? (
              <SiteAssetPanel api={api} site={selectedSite} canManage={canManage} />
            ) : (
              <Card>
                <p className="text-sm text-steel">{t.sitePanelTitle}</p>
                <p className="mt-2 text-sm text-steel">
                  {/* Prompt the operator to pick a pin before the asset panel
                      and substitution action appear. */}
                  {ko.dispatch.empty}
                </p>
              </Card>
            )}
          </div>
        </div>
      ) : null}

      {loadState === "ready" && ungeocoded.length > 0 ? (
        <UngeocodedList sites={ungeocoded} />
      ) : null}
    </>
  );
}

function EmptyState() {
  return (
    <Card className="grid place-items-center gap-3 py-12 text-center">
      <MapPinned aria-hidden="true" className="text-steel" size={40} />
      <p className="max-w-md text-sm text-steel">{t.empty}</p>
      <Button asChild variant="secondary">
        <Link to="/equipment">{t.emptyLink}</Link>
      </Button>
    </Card>
  );
}

interface SiteAssetPanelProps {
  api: ReturnType<typeof useAuth>["api"];
  site: SiteLocationGroup;
  canManage: boolean;
}

/**
 * The clicked site's equipment counts plus a substitution action that reuses the
 * existing SubstitutionPanel. The panel's source pool comes from the equipment
 * autocomplete (the same `/api/v1/equipment` search EquipmentPage feeds it),
 * scoped by the operator's typed query, so we reuse the substitution engine
 * end-to-end rather than rebuilding it.
 */
function SiteAssetPanel({ api, site, canManage }: SiteAssetPanelProps) {
  const [showSubstitution, setShowSubstitution] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EquipmentSummary[]>([]);

  // Re-fetch the source pool whenever the operator types (debounced), mirroring
  // EquipmentPage's autocomplete feed into the substitution source dropdown.
  useEffect(() => {
    const trimmed = query.trim();
    let ignore = false;
    // An empty query clears the pool; a non-empty one searches after a debounce.
    // Both paths set state asynchronously (timeout / promise) so nothing mutates
    // state synchronously inside the effect body.
    const timer = window.setTimeout(() => {
      if (!trimmed) {
        if (!ignore) setResults([]);
        return;
      }
      void api
        .GET("/api/v1/equipment", { params: { query: { q: trimmed, limit: 10 } } })
        .then((response) => {
          if (!ignore) setResults(response.data?.items ?? []);
        })
        .catch(() => {
          if (!ignore) setResults([]);
        });
    }, 300);
    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [api, query]);

  return (
    <div className="grid gap-5">
      <Card className="grid gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">{site.site_name}</h2>
          <p className="text-sm text-steel">
            {site.customer_name}
            {site.province ? ` · ${site.province}` : ""}
            {site.city ? ` ${site.city}` : ""}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Count label={t.counts.equipment} value={site.equipment_count} />
          <Count label={t.counts.rented} value={site.rented_count} />
          <Count label={t.counts.spare} value={site.spare_count} />
          <Count
            label={t.counts.substitutionActive}
            value={site.substitution_active_count}
          />
        </dl>
        {!showSubstitution ? (
          <Button
            type="button"
            onClick={() => {
              setShowSubstitution(true);
            }}
          >
            {t.substitutionTitle}
          </Button>
        ) : null}
      </Card>

      {showSubstitution ? (
        <Card className="grid gap-3">
          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="dispatch-map-source-search"
            >
              {ko.intake.managementNo}
            </label>
            <Input
              id="dispatch-map-source-search"
              value={query}
              placeholder={ko.intake.managementNoPlaceholder}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
            />
          </div>
          <SubstitutionPanel api={api} results={results} canManage={canManage} />
        </Card>
      ) : null}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line bg-muted-panel p-3 text-center">
      <dt className="text-xs font-medium text-steel">{label}</dt>
      <dd className="text-xl font-semibold text-ink">{value}</dd>
    </div>
  );
}

function UngeocodedList({ sites }: { sites: SiteLocationGroup[] }) {
  return (
    <Card className="mt-5 grid gap-3">
      <div>
        <h2 className="text-lg font-semibold text-ink">
          {t.ungeocodedTitle}
        </h2>
        <p className="text-sm text-steel">{t.ungeocodedHint}</p>
      </div>
      <ul className="grid gap-2">
        {sites.map((site) => (
          <li
            key={site.site_id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-line p-3"
          >
            <div className="grid gap-1">
              <span className="font-medium text-ink">{site.site_name}</span>
              <span className="text-sm text-steel">{site.customer_name}</span>
            </div>
            <span className="text-sm text-steel">
              {t.counts.equipment}: {site.equipment_count}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
