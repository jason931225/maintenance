import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "./ui/button";
import { ko } from "../i18n/ko";

interface RouteErrorBoundaryProps {
  children: ReactNode;
  /**
   * Reset key. When this changes the boundary clears its error state, so
   * navigating to a different route re-renders the new page instead of keeping
   * the previous page's crash fallback on screen.
   */
  resetKey?: unknown;
}

interface RouteErrorBoundaryState {
  hasError: boolean;
}

/**
 * Per-route error boundary. Contains a single page's render/lifecycle crash to
 * the routed content area so the shell (sidebar, topbar, nav) stays usable —
 * unlike the top-level {@link ErrorBoundary}, which blanks the whole app.
 *
 * React only catches render errors in a class component, hence the class. The
 * fallback offers an in-place "retry" (clears the error so the page re-mounts)
 * and a full reload as a last resort. The top-level boundary remains mounted
 * above this one to catch anything that escapes (e.g. a crash in the shell).
 */
export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prev: RouteErrorBoundaryProps): void {
    // Reset on navigation: a new route key means the crashed page is no longer
    // shown, so clear the error and let the next page render.
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Page render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className="rounded-lg border border-red-200 bg-red-50 p-6"
      >
        <p className="text-base font-semibold text-red-700">
          {ko.app.pageCrashTitle}
        </p>
        <p className="mt-2 text-sm text-red-600">{ko.app.pageCrashMessage}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              this.setState({ hasError: false });
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {ko.app.retry}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              window.location.reload();
            }}
          >
            {ko.app.reload}
          </Button>
        </div>
      </div>
    );
  }
}
