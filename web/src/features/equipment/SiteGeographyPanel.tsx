import { MapPin, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import type {
  CreateCustomerRequest,
  CreateSiteRequest,
  SiteLocationGroup,
  UpdateSiteRequest,
} from "../../api/types";
import type { ConsoleApiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { ko } from "../../i18n/ko";

const t = ko.dispatchMap.manage;
const f = ko.dispatchMap.fields;
const r = ko.sites.register;

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
    // The by-location read now carries address/postal_code, so they round-trip:
    // an unedited save preserves the stored values instead of nulling them.
    address: site.address ?? "",
    postalCode: site.postal_code ?? "",
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
  const [registerOpen, setRegisterOpen] = useState(false);

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

  async function handleRegistered(createdSiteId: string) {
    await loadSites();
    setRegisterOpen(false);
    selectSite(createdSiteId);
    setNotice(r.siteCreated);
  }

  return (
    <Card className="grid gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
          <p className="text-sm text-steel">{t.description}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setRegisterOpen(true);
          }}
        >
          <Plus aria-hidden="true" size={16} />
          {r.open}
        </Button>
      </div>

      {registerOpen ? (
        <RegisterDialog
          api={api}
          customers={existingCustomers(sites)}
          onClose={() => {
            setRegisterOpen(false);
          }}
          onRegistered={handleRegistered}
        />
      ) : null}

      {notice ? (
        <p role="status" className="text-sm font-medium text-brand-teal">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-2">
        <label className="text-sm font-medium text-steel" htmlFor="site-geo-select">
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
            <p className="text-sm font-semibold text-steel sm:col-span-2">
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
      <label className="text-sm font-medium text-steel" htmlFor={id}>
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

interface CustomerOption {
  id: string;
  name: string;
}

/** Distinct customers (by id) present in the loaded site list, sorted by name, so
 * the register dialog can offer "add a site to an existing customer". */
function existingCustomers(sites: SiteLocationGroup[]): CustomerOption[] {
  const byId = new Map<string, string>();
  for (const site of sites) {
    if (!byId.has(site.customer_id)) byId.set(site.customer_id, site.customer_name);
  }
  return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name, "ko"),
  );
}

type CustomerMode = "existing" | "new";
type DialogState = "idle" | "saving";

interface RegisterDialogProps {
  api: ConsoleApiClient;
  customers: CustomerOption[];
  onClose: () => void;
  onRegistered: (siteId: string) => Promise<void>;
}

function nullableTrimValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Accessible modal to register a new customer and/or a new site.
 * Admin-only (EquipmentManage), wired to POST /api/v1/customers and
 * POST /api/v1/sites. The customer can be an existing one (add a site to it) or a
 * brand-new one (created first, then the site under it). On success the new site
 * is returned and the parent refreshes the list and selects it.
 */
function RegisterDialog({
  api,
  customers,
  onClose,
  onRegistered,
}: RegisterDialogProps) {
  const titleId = useId();
  const [mode, setMode] = useState<CustomerMode>(
    customers.length > 0 ? "existing" : "new",
  );
  const [existingCustomerId, setExistingCustomerId] = useState<string>(
    customers[0]?.id ?? "",
  );
  const [newCustomerName, setNewCustomerName] = useState("");
  const [siteName, setSiteName] = useState("");
  const [address, setAddress] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [state, setState] = useState<DialogState>("idle");
  const [error, setError] = useState<string>();

  async function resolveCustomerId(): Promise<string | undefined> {
    if (mode === "existing") {
      if (!existingCustomerId) {
        setError(r.customerRequired);
        return undefined;
      }
      return existingCustomerId;
    }
    const name = newCustomerName.trim();
    if (name.length === 0) {
      setError(r.customerRequired);
      return undefined;
    }
    const body: CreateCustomerRequest = { name };
    const response = await api.POST("/api/v1/customers", { body });
    if (response.error || !response.data) {
      setError(
        response.response.status === 409 ? r.duplicateCustomer : r.failed,
      );
      return undefined;
    }
    return response.data.id;
  }

  async function handleSubmit() {
    setError(undefined);
    const trimmedSite = siteName.trim();
    if (trimmedSite.length === 0) {
      setError(r.nameRequired);
      return;
    }
    setState("saving");
    const customerId = await resolveCustomerId();
    if (customerId === undefined) {
      setState("idle");
      return;
    }

    const body: CreateSiteRequest = {
      customer_id: customerId,
      name: trimmedSite,
      address: nullableTrimValue(address),
      contact_name: nullableTrimValue(contactName),
      contact_phone: nullableTrimValue(contactPhone),
    };
    const response = await api.POST("/api/v1/sites", { body });
    if (response.error || !response.data) {
      const status = response.response.status;
      setError(
        status === 409
          ? r.duplicateSite
          : status === 404
            ? r.customerNotFound
            : r.failed,
      );
      setState("idle");
      return;
    }
    await onRegistered(response.data.id);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <Card className="grid w-full max-w-lg gap-4">
        <div>
          <h3 id={titleId} className="text-lg font-semibold text-ink">
            {r.title}
          </h3>
          <p className="text-sm text-steel">{r.description}</p>
        </div>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <fieldset className="grid gap-3">
            <legend className="text-sm font-semibold text-steel">
              {r.customerSection}
            </legend>
            {customers.length > 0 ? (
              <div
                className="flex flex-wrap gap-4"
                role="radiogroup"
                aria-label={r.customerMode}
              >
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="radio"
                    name="customer-mode"
                    value="existing"
                    checked={mode === "existing"}
                    onChange={() => {
                      setMode("existing");
                    }}
                  />
                  {r.customerModeExisting}
                </label>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="radio"
                    name="customer-mode"
                    value="new"
                    checked={mode === "new"}
                    onChange={() => {
                      setMode("new");
                    }}
                  />
                  {r.customerModeNew}
                </label>
              </div>
            ) : null}

            {mode === "existing" && customers.length > 0 ? (
              <div className="grid gap-2">
                <label
                  className="text-sm font-medium text-steel"
                  htmlFor="register-existing-customer"
                >
                  {r.existingCustomer}
                </label>
                <Select
                  id="register-existing-customer"
                  autoFocus
                  value={existingCustomerId}
                  onChange={(event) => {
                    setExistingCustomerId(event.currentTarget.value);
                  }}
                >
                  <option value="">{r.existingCustomerPlaceholder}</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <div className="grid gap-2">
                <label
                  className="text-sm font-medium text-steel"
                  htmlFor="register-new-customer"
                >
                  {r.customerName}
                </label>
                <Input
                  id="register-new-customer"
                  autoFocus={mode === "new"}
                  value={newCustomerName}
                  placeholder={r.customerNamePlaceholder}
                  maxLength={200}
                  onChange={(event) => {
                    setNewCustomerName(event.currentTarget.value);
                  }}
                />
              </div>
            )}
          </fieldset>

          <fieldset className="grid gap-3">
            <legend className="text-sm font-semibold text-steel">
              {r.siteSection}
            </legend>
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="register-site-name"
              >
                {r.siteName}
              </label>
              <Input
                id="register-site-name"
                value={siteName}
                placeholder={r.siteNamePlaceholder}
                maxLength={200}
                onChange={(event) => {
                  setSiteName(event.currentTarget.value);
                }}
              />
            </div>
            <Field
              id="register-site-address"
              label={f.address}
              value={address}
              onChange={setAddress}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="register-site-contact-name"
                label={f.contactName}
                value={contactName}
                onChange={setContactName}
              />
              <Field
                id="register-site-contact-phone"
                label={f.contactPhone}
                value={contactPhone}
                placeholder={t.contactPhonePlaceholder}
                onChange={setContactPhone}
              />
            </div>
          </fieldset>

          {error ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={state === "saving"}
            >
              {r.cancel}
            </Button>
            <Button type="submit" disabled={state === "saving"}>
              <Plus aria-hidden="true" size={16} />
              {state === "saving" ? r.submitting : r.submit}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
