const mentionPattern = /(^|[\s([{])(@[\p{L}\p{N}._-]{1,48})/gu;

export type TextPart =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string };

export function splitMentionText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(mentionPattern)) {
    const full = match[0];
    const mention = match[2];
    const mentionStart = match.index + full.length - mention.length;
    if (mentionStart > cursor) {
      parts.push({ kind: "text", value: text.slice(cursor, mentionStart) });
    }
    parts.push({ kind: "mention", value: mention });
    cursor = mentionStart + mention.length;
  }

  if (cursor < text.length) {
    parts.push({ kind: "text", value: text.slice(cursor) });
  }

  return parts.length > 0 ? parts : [{ kind: "text", value: text }];
}
