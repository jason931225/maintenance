export function isLocalDevBuild(
  dev = import.meta.env.DEV,
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
): boolean {
  return (
    dev &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")
  );
}
