/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Explicit FSM operator-console origin override; see lib/consoleUrl.ts. */
  readonly VITE_CONSOLE_URL?: string;
  /** Explicit release cycle label used by staged-rollout RUM/adoption telemetry. */
  readonly VITE_RELEASE_CYCLE?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_GIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
