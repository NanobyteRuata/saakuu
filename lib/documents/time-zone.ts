/**
 * The viewer's time zone, for "uploaded on" (Phase 18). The client sends it with every list request;
 * the server page reads it from this cookie so the first paint filters by the same day.
 */
export const TIME_ZONE_COOKIE = "saakuu.tz";

/** Undoes the encoding below, whether or not the framework already did; garbage becomes undefined. */
export function readTimeZoneCookie(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Writes the cookie; returns true when it changed, so a page that filtered by the old zone can refresh. */
export function syncTimeZoneCookie(current: string): boolean {
  const tz = browserTimeZone();
  if (tz === current) return false;
  document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
  return true;
}
