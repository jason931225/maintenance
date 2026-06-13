const DEVICE_ID_KEY = "maintenance_console_device_id";

/**
 * Stable, random per-device identifier persisted in localStorage and sent as the
 * `X-Device-Id` header so the backend can apply its optional per-device auth rate
 * limit. The value is client-controlled and best-effort: if storage or
 * `crypto.randomUUID` is unavailable we simply omit the header (the backend falls
 * back to per-IP limiting), so this never blocks a request.
 */
export function getDeviceId(): string | undefined {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      return existing;
    }
    const generated = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return undefined;
  }
}
