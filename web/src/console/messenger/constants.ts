export const MESSENGER_ACTIONS = {
  read: "messenger.thread.read",
  search: "messenger.search",
  send: "messenger.message.send",
  ack: "messenger.message.ack",
  quote: "messenger.message.quote",
  todo: "todo.create",
  mute: "messenger.thread.mute",
  memberRead: "messenger.member.read",
  objectOpen: "object.open",
  join: "messenger.channel.join",
} as const;
