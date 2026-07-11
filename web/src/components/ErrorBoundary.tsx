import { Component, type ErrorInfo, type ReactNode } from "react";

import { ko } from "../i18n/ko";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Rendered instead of the full-page reload card when a child crashes. Lets a
   * non-critical region (e.g. the console comms rail) degrade in place to a
   * quiet local fallback rather than blanking its surroundings.
   */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Top-level error boundary. React only catches render/lifecycle errors in a
 * class component, so this is deliberately a class. Without it, any uncaught
 * render error unmounts the entire tree to a blank white screen; here we show a
 * recoverable fallback and log the error for diagnostics.
 *
 * Mounted at the app root (see main.tsx) so it survives a crash anywhere below.
 * The fallback depends only on a static string import and a full-page reload —
 * nothing the crash could have taken down with it.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the crash for diagnostics; a telemetry sink can hook in here.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    return (
      <div
        role="alert"
        className="mx-auto mt-16 max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center"
      >
        <p className="text-base font-semibold text-red-700">
          {ko.app.crashTitle}
        </p>
        <p className="mt-2 text-sm text-red-600">{ko.app.crashMessage}</p>
        <button
          type="button"
          className="mt-4 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          onClick={() => {
            window.location.reload();
          }}
        >
          {ko.app.reload}
        </button>
      </div>
    );
  }
}
