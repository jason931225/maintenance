import { cn } from "../../lib/utils";
import { splitMentionText } from "./mention-text-parts";

interface MentionTextProps {
  text: string;
  className?: string;
}

export function MentionText({ text, className }: MentionTextProps) {
  return (
    <span className={cn("whitespace-pre-wrap", className)}>
      {splitMentionText(text).map((part, index) =>
        part.kind === "mention" ? (
          <span
            key={`${part.value}-${String(index)}`}
            className="font-semibold text-brand-teal"
            data-mention={part.value.slice(1)}
          >
            {part.value}
          </span>
        ) : (
          <span key={`text-${String(index)}`}>{part.value}</span>
        ),
      )}
    </span>
  );
}
