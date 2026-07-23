/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Explicit FSM operator-console origin override; see lib/consoleUrl.ts. */
  readonly VITE_CONSOLE_URL?: string;
  /** Explicit operator-console host — matched against location.host, so include
   *  the port for a non-default one (e.g. `ops.staging.example.com:8443`). When
   *  the SPA runs on it, `/` lands on the console instead of the storefront.
   *  See lib/consoleUrl.ts isConsoleHost. */
  readonly VITE_CONSOLE_HOST?: string;
  /** Explicit release cycle label used by staged-rollout RUM/adoption telemetry. */
  readonly VITE_RELEASE_CYCLE?: string;
  /**
   * Local development-only opt-in for rendering mounted console inventory at
   * `/console/*`. Production builds ignore this even when set because the
   * router also requires `import.meta.env.DEV`.
   */
  readonly VITE_CONSOLE_DEV_PREVIEW?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_GIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
