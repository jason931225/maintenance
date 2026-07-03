import { Link, useSearchParams } from "react-router-dom";
import { CalendarDays, FileText, Receipt, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeader } from "../components/shell/PageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { ko } from "../i18n/ko";

type TemplateKey =
  | "annual-leave"
  | "outing-business-trip"
  | "draft"
  | "report"
  | "minutes"
  | "expense";

const copy = ko.approvalCompose;
const templates = copy.templates;

const templateOptions = Object.entries(templates) as Array<
  [TemplateKey, (typeof templates)[TemplateKey]]
>;

export function ApprovalDocumentComposePage() {
  const [params, setParams] = useSearchParams();
  const initialTemplate = normalizeTemplate(params.get("template"));
  const [templateKey, setTemplateKey] = useState<TemplateKey>(initialTemplate);
  const [title, setTitle] = useState<string>(templates[initialTemplate].title);
  const [targetDate, setTargetDate] = useState("");
  const [amount, setAmount] = useState("");
  const [relatedPeople, setRelatedPeople] = useState("");
  const [approvalLine, setApprovalLine] = useState<string>(
    templates[initialTemplate].approvalLine,
  );
  const [body, setBody] = useState("");

  const template = templates[templateKey];
  const trackingItems = useMemo(
    () => [
      { label: copy.tracking.targetDate, value: targetDate || "-" },
      { label: copy.tracking.amount, value: amount || "-" },
      { label: copy.tracking.relatedPeople, value: relatedPeople || "-" },
      { label: copy.tracking.linkedObject, value: template.linkedObject },
    ],
    [amount, relatedPeople, targetDate, template.linkedObject],
  );

  function selectTemplate(next: TemplateKey) {
    setTemplateKey(next);
    setTitle(templates[next].title);
    setApprovalLine(templates[next].approvalLine);
    setParams({ template: next });
  }

  return (
    <>
      <PageHeader
        title={copy.title}
        description={copy.description}
        actions={
          <Button asChild type="button" variant="secondary" size="sm">
            <Link to="/approvals">{copy.backToList}</Link>
          </Button>
        }
      />

      <div className="grid max-w-6xl gap-5 xl:grid-cols-[280px_1fr]">
        <Card className="grid content-start gap-3 p-4">
          {templateOptions.map(([key, option]) => (
            <button
              key={key}
              type="button"
              className={[
                "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm",
                key === templateKey
                  ? "border-brand-teal bg-brand-teal/5 text-ink"
                  : "border-line bg-white text-steel",
              ].join(" ")}
              onClick={() => {
                selectTemplate(key);
              }}
            >
              <TemplateIcon template={key} />
              <span className="font-semibold">{option.title}</span>
            </button>
          ))}
        </Card>

        <div className="grid gap-5">
          <Card className="grid gap-4 p-5">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium text-steel">
                {copy.fields.title}
                <Input
                  value={title}
                  onChange={(event) => {
                    setTitle(event.currentTarget.value);
                  }}
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-steel">
                {copy.fields.type}
                <Select
                  value={templateKey}
                  onChange={(event) => {
                    selectTemplate(event.currentTarget.value as TemplateKey);
                  }}
                >
                  {templateOptions.map(([key, option]) => (
                    <option key={key} value={key}>
                      {option.title}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="grid gap-2 text-sm font-medium text-steel">
                {template.targetLabel}
                <Input
                  type="date"
                  value={targetDate}
                  onChange={(event) => {
                    setTargetDate(event.currentTarget.value);
                  }}
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-steel">
                {template.amountLabel}
                <Input
                  value={amount}
                  placeholder={copy.placeholders.amount}
                  onChange={(event) => {
                    setAmount(event.currentTarget.value);
                  }}
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-steel">
                {copy.fields.relatedPeople}
                <Input
                  value={relatedPeople}
                  placeholder={copy.placeholders.relatedPeople}
                  onChange={(event) => {
                    setRelatedPeople(event.currentTarget.value);
                  }}
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-steel">
                {copy.fields.approvalLine}
                <Input
                  value={approvalLine}
                  onChange={(event) => {
                    setApprovalLine(event.currentTarget.value);
                  }}
                />
              </label>
            </div>
            <label className="grid gap-2 text-sm font-medium text-steel">
              {copy.fields.body}
              <Textarea
                value={body}
                rows={8}
                onChange={(event) => {
                  setBody(event.currentTarget.value);
                }}
              />
            </label>
          </Card>

          <Card className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-ink">
                {copy.fields.tracking}
              </h2>
              <Badge>{template.linkedObject}</Badge>
            </div>
            <dl className="grid gap-3 md:grid-cols-4">
              {trackingItems.map((item) => (
                <div
                  key={item.label}
                  className="rounded-md border border-line bg-muted-panel/50 p-3"
                >
                  <dt className="text-xs font-semibold text-steel">
                    {item.label}
                  </dt>
                  <dd className="mt-1 text-sm font-semibold text-ink">
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary">
                {copy.actions.saveDraft}
              </Button>
              <Button type="button">{copy.actions.prepareSubmit}</Button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function normalizeTemplate(value: string | null): TemplateKey {
  return value && value in templates ? (value as TemplateKey) : "draft";
}

function TemplateIcon({ template }: { template: TemplateKey }) {
  if (template === "annual-leave" || template === "outing-business-trip") {
    return <CalendarDays size={16} aria-hidden="true" />;
  }
  if (template === "expense") {
    return <Receipt size={16} aria-hidden="true" />;
  }
  if (template === "minutes") {
    return <Users size={16} aria-hidden="true" />;
  }
  return <FileText size={16} aria-hidden="true" />;
}
