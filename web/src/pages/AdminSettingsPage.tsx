import { Copy, Ticket } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "../components/shell/PageHeader";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useActiveBranchId, useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { issueAdminOtp } from "../auth/webauthn";

interface IssuedOtp {
  otp: string;
  expiresAt: string;
}

export function AdminSettingsPage() {
  const { api } = useAuth();
  const activeBranchId = useActiveBranchId();
  const [userId, setUserId] = useState("");
  const [branchId, setBranchId] = useState(activeBranchId ?? "");
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<IssuedOtp | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  async function handleIssue() {
    setError(undefined);
    setIssued(undefined);
    setCopied(false);
    if (!userId.trim()) {
      setError(ko.admin.requiredUserId);
      return;
    }
    if (!branchId.trim()) {
      setError(ko.admin.requiredBranchId);
      return;
    }
    setPending(true);
    try {
      const result = await issueAdminOtp(api, {
        user_id: userId.trim(),
        branch_id: branchId.trim(),
      });
      setIssued({ otp: result.otp, expiresAt: result.expires_at });
    } catch {
      setError(ko.admin.issueFailed);
    } finally {
      setPending(false);
    }
  }

  async function handleCopy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <PageHeader title={ko.admin.title} />
      <div className="max-w-xl">
        <Card className="grid gap-4">
          <div className="grid gap-1">
            <h2 className="text-lg font-semibold text-ink">
              {ko.admin.issueOtpTitle}
            </h2>
            <p className="text-sm text-steel">
              {ko.admin.issueOtpDescription}
            </p>
          </div>

          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="admin-otp-user-id"
            >
              {ko.admin.userIdLabel}
            </label>
            <Input
              id="admin-otp-user-id"
              value={userId}
              placeholder={ko.admin.userIdPlaceholder}
              onChange={(event) => {
                setUserId(event.currentTarget.value);
              }}
            />
          </div>

          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="admin-otp-branch-id"
            >
              {ko.admin.branchIdLabel}
            </label>
            <Input
              id="admin-otp-branch-id"
              value={branchId}
              placeholder={ko.admin.branchIdPlaceholder}
              onChange={(event) => {
                setBranchId(event.currentTarget.value);
              }}
            />
          </div>

          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              void handleIssue();
            }}
          >
            <Ticket aria-hidden="true" size={18} />
            {pending ? ko.admin.issuing : ko.admin.issue}
          </Button>

          {issued ? (
            <div className="grid gap-2 rounded-md border border-brand-teal/30 bg-brand-teal/10 p-4">
              <span className="text-sm font-medium text-brand-teal">
                {ko.admin.issuedCode}
              </span>
              <div className="flex items-center gap-2">
                <code className="rounded bg-white px-3 py-2 text-lg font-semibold tracking-widest text-ink">
                  {issued.otp}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void handleCopy(issued.otp);
                  }}
                >
                  <Copy aria-hidden="true" size={16} />
                  {copied ? ko.admin.copied : ko.admin.copy}
                </Button>
              </div>
              <span role="status" aria-live="polite" className="sr-only">
                {copied ? ko.admin.copied : ""}
              </span>
              <span className="text-sm text-brand-teal">
                {ko.admin.expiresAt}:{" "}
                {new Date(issued.expiresAt).toLocaleString("ko-KR", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}
        </Card>
      </div>
    </>
  );
}
