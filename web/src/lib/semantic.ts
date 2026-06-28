/** Operational semantic tones for the authenticated console. */
export type Tone =
  | "danger"
  | "warning"
  | "success"
  | "info"
  | "accent"
  | "neutral";

/** Stable Tailwind class fragments emitted from CSS variables in styles.css. */
const TONE_BADGE_CLASSES: Record<Tone, string> = {
  danger: "border-tone-danger-border bg-tone-danger-bg text-tone-danger-text",
  warning: "border-tone-warning-border bg-tone-warning-bg text-tone-warning-text",
  success: "border-tone-success-border bg-tone-success-bg text-tone-success-text",
  info: "border-tone-info-border bg-tone-info-bg text-tone-info-text",
  accent: "border-tone-accent-border bg-tone-accent-bg text-tone-accent-text",
  neutral: "border-tone-neutral-border bg-tone-neutral-bg text-tone-neutral-text",
};

const TONE_TEXT_CLASSES: Record<Tone, string> = {
  danger: "text-tone-danger-text",
  warning: "text-tone-warning-text",
  success: "text-tone-success-text",
  info: "text-tone-info-text",
  accent: "text-tone-accent-text",
  neutral: "text-tone-neutral-text",
};

export function toneBadgeClass(tone: Tone): string {
  return TONE_BADGE_CLASSES[tone];
}

export function toneTextClass(tone: Tone): string {
  return TONE_TEXT_CLASSES[tone];
}
