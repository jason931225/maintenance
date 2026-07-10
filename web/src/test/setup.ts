import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

import { realtimeHub } from "../features/comms/realtimeHub";
import { useCommsStore } from "../features/comms/store";

configure({ asyncUtilTimeout: 20_000 });

function makeMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function ensureStorage(name: "localStorage" | "sessionStorage") {
  if (typeof globalThis[name] !== "undefined") return;
  const fromWindow =
    typeof window !== "undefined" && typeof window[name] !== "undefined"
      ? window[name]
      : makeMemoryStorage();
  Object.defineProperty(globalThis, name, {
    value: fromWindow,
    configurable: true,
  });
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");

afterEach(() => {
  cleanup();
  // The comms store + realtime hub are module singletons; reset them so no test
  // leaks rail/badge state (or a live reconnect timer) into the next file.
  useCommsStore.getState().reset();
  realtimeHub.reset();
});
