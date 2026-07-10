import type {
  ConsoleMessengerMember,
  ConsoleMessengerMessage,
  ConsoleMessengerThread,
} from "./types";

export interface MessageRowModel {
  message: ConsoleMessengerMessage;
  headOn: boolean;
  dividerBefore: boolean;
}

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; name: string }
  | { kind: "object"; text: string; code: string };

export type ComposerCandidateKind = "mention" | "channel" | "object";

export interface ComposerCandidate {
  kind: ComposerCandidateKind;
  label: string;
  insertText: string;
  id?: string;
}

export interface ComposerCandidateSources {
  members: ConsoleMessengerMember[];
  channels: ConsoleMessengerThread[];
  objectCodes: string[];
}

const OBJECT_CODE_RE = /\b(?:AP|WO|AT|CS|JL|PS|IN|DX|Bid|MT|EV|OT|SR|PAY|EQ|VC|FL|HR|TK|C|R)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g;
const PART_RE = /(@[\p{L}\p{N}_-]+)|\b(?:AP|WO|AT|CS|JL|PS|IN|DX|Bid|MT|EV|OT|SR|PAY|EQ|VC|FL|HR|TK|C|R)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/gu;

export function buildMessageRows(
  messages: ConsoleMessengerMessage[],
  unreadCount: number,
): MessageRowModel[] {
  const dividerIndex = unreadCount > 0 ? Math.max(0, messages.length - unreadCount) : -1;
  return messages.map((message, index) => {
    const previousSenderId = index > 0 ? messages[index - 1].sender_id : undefined;
    return {
      message,
      headOn: previousSenderId === undefined || previousSenderId !== message.sender_id || index === dividerIndex,
      dividerBefore: index === dividerIndex,
    };
  });
}

export function renderMessageParts(
  body: string,
  options: {
    authorizedMentions?: ReadonlySet<string>;
    authorizedObjectCodes?: ReadonlySet<string>;
  } = {},
): MessagePart[] {
  const parts: MessagePart[] = [];
  let cursor = 0;
  for (const match of body.matchAll(PART_RE)) {
    const text = match[0];
    const index = match.index;
    if (index > cursor) {
      pushText(parts, body.slice(cursor, index));
    }
    if (text.startsWith("@")) {
      const name = text.slice(1);
      if (!options.authorizedMentions || options.authorizedMentions.has(name)) {
        parts.push({ kind: "mention", text, name });
      } else {
        pushText(parts, text);
      }
    } else if (!options.authorizedObjectCodes || options.authorizedObjectCodes.has(text)) {
      parts.push({ kind: "object", text, code: text });
    } else {
      pushText(parts, text);
    }
    cursor = index + text.length;
  }
  if (cursor < body.length) {
    pushText(parts, body.slice(cursor));
  }
  return parts.length > 0 ? parts : [{ kind: "text", text: body }];
}

export function extractObjectCodes(messages: ConsoleMessengerMessage[]): string[] {
  const codes = new Set<string>();
  for (const message of messages) {
    for (const match of message.body.matchAll(OBJECT_CODE_RE)) {
      codes.add(match[0]);
    }
    if (message.quoted_body) {
      for (const match of message.quoted_body.matchAll(OBJECT_CODE_RE)) {
        codes.add(match[0]);
      }
    }
  }
  return [...codes].sort();
}

export function unreadBadgeTotal(threads: ConsoleMessengerThread[]): number {
  return threads.reduce(
    (sum, thread) => sum + (thread.muted ? 0 : Math.max(0, thread.unread_count)),
    0,
  );
}

export function partitionThreads(threads: ConsoleMessengerThread[]): {
  channels: ConsoleMessengerThread[];
  directs: ConsoleMessengerThread[];
} {
  return {
    channels: threads.filter((thread) => thread.visibility === "channel"),
    directs: threads.filter((thread) => thread.visibility === "direct"),
  };
}

export function threadTitle(thread: ConsoleMessengerThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  if (thread.visibility === "channel") return "channel";
  return thread.kind;
}

export function buildComposerCandidates(
  value: string,
  caret: number,
  sources: ComposerCandidateSources,
): ComposerCandidate[] {
  const token = tokenBeforeCaret(value, caret);
  if (!token || token.startsWith("!")) return [];
  if (token.startsWith("@")) {
    const query = token.slice(1).toLocaleLowerCase("ko-KR");
    return sources.members
      .filter((member) => member.display_name.toLocaleLowerCase("ko-KR").includes(query))
      .slice(0, 8)
      .map((member) => ({
        kind: "mention",
        id: member.id,
        label: member.display_name,
        insertText: `@${member.display_name}`,
      }));
  }
  if (token.startsWith("#")) {
    const query = token.slice(1).toLocaleLowerCase("ko-KR");
    return sources.channels
      .filter((thread) => threadTitle(thread).toLocaleLowerCase("ko-KR").includes(query))
      .slice(0, 8)
      .map((thread) => ({
        kind: "channel",
        id: thread.id,
        label: threadTitle(thread),
        insertText: `#${threadTitle(thread)}`,
      }));
  }
  if (/^(?:AP|WO|AT|CS|JL|PS|IN|DX|Bid|MT|EV|OT|SR|PAY|EQ|VC|FL|HR|TK|C|R)-[A-Za-z0-9-]*$/.test(token)) {
    const query = token.toLocaleLowerCase("ko-KR");
    return sources.objectCodes
      .filter((code) => code.toLocaleLowerCase("ko-KR").startsWith(query))
      .slice(0, 8)
      .map((code) => ({ kind: "object", label: code, insertText: code }));
  }
  return [];
}

export function applyComposerCandidate(value: string, caret: number, candidate: ComposerCandidate): string {
  const token = tokenBeforeCaret(value, caret);
  if (!token) return value;
  const start = caret - token.length;
  const suffix = value.slice(caret).startsWith(" ") ? "" : " ";
  return `${value.slice(0, start)}${candidate.insertText}${suffix}${value.slice(caret)}`;
}

function tokenBeforeCaret(value: string, caret: number): string {
  const before = value.slice(0, caret);
  return before.split(/\s/).at(-1) ?? "";
}

function pushText(parts: MessagePart[], text: string) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.kind === "text") {
    previous.text += text;
  } else {
    parts.push({ kind: "text", text });
  }
}
