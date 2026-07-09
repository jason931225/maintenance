import { ws } from "msw";

export function createConsoleMessengerWsHandlers() {
  const messengerWs = ws.link("ws://localhost/api/v1/ws*");
  const devMessengerWs = ws.link("ws://localhost:3000/api/v1/ws*");

  return [
    messengerWs.addEventListener("connection", () => {}),
    devMessengerWs.addEventListener("connection", () => {}),
  ] as const;
}
