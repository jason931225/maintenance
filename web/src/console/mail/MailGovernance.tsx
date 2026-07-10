import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import {
  MAIL_ACTIONS,
  egressNextActionLabel,
  egressReasonLabel,
  governanceChips,
  senderAuthChips,
} from "./mailScreenConfig";
import { chipRowStyle, dangerButtonStyle, stackStyle } from "./styles";
import type { MailEgressBlock, MailGovernance, MailSenderAuth } from "./types";

const panelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
  background: "var(--muted)",
};

const egressStyle: CSSProperties = {
  ...panelStyle,
  border: "1px solid var(--danger-bd)",
  background: "var(--danger-bg)",
  color: "var(--danger-tx)",
};

export function GovernanceChipRow({ governance }: { governance?: MailGovernance }) {
  const chips = governanceChips(governance);
  if (chips.length === 0) return null;
  return (
    <PolicyGated action={MAIL_ACTIONS.governanceView} resource={{ kind: "mail_governance" }}>
      <div style={chipRowStyle}>
        {chips.map((chip) => (
          <StatusChip key={chip.key} tone={chip.tone} role={chip.role}>
            {chip.label}
          </StatusChip>
        ))}
      </div>
    </PolicyGated>
  );
}

export function SenderAuthPanel({ auth }: { auth?: MailSenderAuth }) {
  const chips = senderAuthChips(auth);
  if (chips.length === 0) return null;
  return (
    <PolicyGated action={MAIL_ACTIONS.governanceView} resource={{ kind: "mail_sender_auth" }}>
      <div style={panelStyle}>
        <div style={chipRowStyle}>
          {chips.map((chip) => (
            <StatusChip key={chip.key} tone={chip.tone} role={chip.role}>
              {chip.label}
            </StatusChip>
          ))}
        </div>
      </div>
    </PolicyGated>
  );
}

export function EgressGatePanel({ block }: { block?: MailEgressBlock }) {
  if (!block) return null;
  return (
    <PolicyGated action={MAIL_ACTIONS.egressExternal} resource={{ kind: "mail_egress" }}>
      <div role="alert" aria-label={ko.console.mail.egress.blocked} style={egressStyle}>
        <div style={stackStyle}>
          <strong>{ko.console.mail.egress.blocked}</strong>
          <div style={chipRowStyle}>
            {block.reasons.map((reason) => (
              <StatusChip key={reason} tone="danger" role="alert">
                {egressReasonLabel(reason)}
              </StatusChip>
            ))}
          </div>
          <button type="button" style={dangerButtonStyle}>
            {egressNextActionLabel(block.nextAction)}
          </button>
        </div>
      </div>
    </PolicyGated>
  );
}
