import { MapPin } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type { SiteLocationGroup, UpdateSiteRequest } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { ko } from "../../i18n/ko";

const t = ko.dispatchMap.manage;
const f = ko.dispatchMap.fields;

interface SiteGeographyPanelProps {
  api: ConsoleApiClient;
}

type WriteState = "idle" | "saving" | "error";

interface FormState {
  province: string;
  city: string;
  address: string;
  postalCode: string;
  latitude: string;
  longitude: string;
  geofenceRadius: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
}

function emptyForm(): FormState {
  return {
    province: "",
    city: "",
    address: "",
    postalCode: "",
    latitude: "",
    longitude: "",
    geofenceRadius: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
  };
}

function seedForm(site: SiteLocationGroup): FormState {
  return {
    province: site.province ?? "",
    city: site.city ?? "",
    // address/postal_code are write-only here (the by-location read doesn't carry
    // them), so they seed empty; contact + province/city/coords seed from the row.
    address: "",
    postalCode: "",
    latitude: site.latitude === null ? "" : String(site.latitude),
    longitude: site.longitude === null ? "" : String(site.longitude),
    geofenceRadius:
      site.geofence_radius_m === null ? "" : String(site.geofence_radius_m),
    contactName: site.contact_name ?? "",
    contactPhone: site.contact_phone ?? "",
    contactEmail: site.contact_email ?? "",
  };
}

/**
 * Admin-only (EquipmentManage) site coordinate entry. Lists the org's sites via
 * the dispatch-map aggregation (which carries each site_id and its current
 * coordinates) and PATCHes /api/v1/sites/{id} with admin-entered values. This is
 * the only place coordinates are created, so a site appears on the map only
 * after an admin saves a real lat/lon pair here.
 */
export function SiteGeographyPanel({ api }: SiteGeographyPanelProps) {
  const [sites, setSites] = useState<SiteLocationGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [notice, setNotice] = useState<string>();
  const [pairError, setPairError] = useState(false);

  const loadSites = useCallback(
    async (signal?: AbortSignal) => {
      const response = await api.GET("/api/v1/equipment-by-location", { signal });
      if (response.data) setSites(response.data.items);
    },
    [api],
  );

  useEffect(() => {
    // Abort the on-mount load if the panel unmounts before it resolves, so the
    // request can't setState (or escape to the network) after teardown. The
    // load is deferred to a microtask, so re-check the signal before issuing it
    // in case unmount already happened.
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) void loadSites(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [loadSites]);

  function selectSite(id: string) {
    setSelectedId(id);
    setNotice(undefined);
    setPairError(false);
    setWriteState("idle");
    const site = sites.find((s) => s.site_id === id);
    setForm(site ? seedForm(site) : emptyForm());
  }

  function setField(key: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function nullableTrim(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  async function handleSubmit() {
    if (!selectedId) return;
    const latRaw = form.latitude.trim();
    const lonRaw = form.longitude.trim();
    // A pin needs both coordinates or neither (mirrors the backend pairing
    // check); reject a one-sided entry before calling the API.
    if ((latRaw === "") !== (lonRaw === "")) {
      setPairError(true);
      return;
    }
    setPairError(false);
    setWriteState("saving");
    setNotice(undefined);

    const body: UpdateSiteRequest = {
      province: nullableTrim(form.province),
      city: nullableTrim(form.city),
      address: nullableTrim(form.address),
      postal_code: nullableTrim(form.postalCode),
      latitude: latRaw === "" ? null : Number(latRaw),
      longitude: lonRaw === "" ? null : Number(lonRaw),
      geofence_radius_m:
        form.geofenceRadius.trim() === ""
          ? null
          : Number(form.geofenceRadius.trim()),
      contact_name: nullableTrim(form.contactName),
      contact_phone: nullableTrim(form.contactPhone),
      contact_email: nullableTrim(form.contactEmail),
    };

    const response = await api.PATCH("/api/v1/sites/{id}", {
      params: { path: { id: selectedId } },
      body,
    });
    if (response.error) {
      setWriteState("error");
      setNotice(t.saveFailed);
      return;
    }
    setWriteState("idle");
    setNotice(t.saveSuccess);
    await loadSites();
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-950">{t.title}</h2>
        <p className="text-sm text-slate-600">{t.description}</p>
      </div>

      {notice ? (
        <p role="status" className="text-sm font-medium text-emerald-700">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="site-geo-select">
          {t.selectSite}
        </label>
        <Select
          id="site-geo-select"
          value={selectedId}
          onChange={(event) => {
            selectSite(event.currentTarget.value);
          }}
        >
          <option value="">{t.selectSitePlaceholder}</option>
          {sites.map((site) => (
            <option key={site.site_id} value={site.site_id}>
              {site.site_name} · {site.customer_name}
              {site.latitude !== null ? " 📍" : ""}
            </option>
          ))}
        </Select>
      </div>

      {selectedId ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="site-geo-province"
              label={f.province}
              value={form.province}
              onChange={(v) => {
                setField("province", v);
              }}
            />
            <Field
              id="site-geo-city"
              label={f.city}
              value={form.city}
              onChange={(v) => {
                setField("city", v);
              }}
            />
            <Field
              id="site-geo-address"
              label={f.address}
              value={form.address}
              onChange={(v) => {
                setField("address", v);
              }}
            />
            <Field
              id="site-geo-postal"
              label={f.postalCode}
              value={form.postalCode}
              onChange={(v) => {
                setField("postalCode", v);
              }}
            />
            <Field
              id="site-geo-latitude"
              label={f.latitude}
              value={form.latitude}
              placeholder={t.latitudePlaceholder}
              inputMode="decimal"
              onChange={(v) => {
                setField("latitude", v);
              }}
            />
            <Field
              id="site-geo-longitude"
              label={f.longitude}
              value={form.longitude}
              placeholder={t.longitudePlaceholder}
              inputMode="decimal"
              onChange={(v) => {
                setField("longitude", v);
              }}
            />
            <Field
              id="site-geo-radius"
              label={f.geofenceRadius}
              value={form.geofenceRadius}
              placeholder={t.geofenceRadiusPlaceholder}
              inputMode="decimal"
              onChange={(v) => {
                setField("geofenceRadius", v);
              }}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <p className="text-sm font-semibold text-slate-700 sm:col-span-2">
              {t.contactSection}
            </p>
            <Field
              id="site-contact-name"
              label={f.contactName}
              value={form.contactName}
              onChange={(v) => {
                setField("contactName", v);
              }}
            />
            <Field
              id="site-contact-phone"
              label={f.contactPhone}
              value={form.contactPhone}
              placeholder={t.contactPhonePlaceholder}
              onChange={(v) => {
                setField("contactPhone", v);
              }}
            />
            <Field
              id="site-contact-email"
              label={f.contactEmail}
              value={form.contactEmail}
              onChange={(v) => {
                setField("contactEmail", v);
              }}
            />
          </div>
          {pairError ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {t.pairRequired}
            </p>
          ) : null}
          {writeState === "error" ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {t.saveFailed}
            </p>
          ) : null}
          <div className="flex items-center justify-end">
            <Button type="submit" disabled={writeState === "saving"}>
              <MapPin aria-hidden="true" size={16} />
              {writeState === "saving" ? t.saving : t.save}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "decimal";
}

function Field({ id, label, value, onChange, placeholder, inputMode }: FieldProps) {
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium text-slate-700" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}
