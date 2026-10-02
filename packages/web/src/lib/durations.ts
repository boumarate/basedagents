/**
 * Durations and times for the paid feed. Values come from the API in seconds;
 * these only format them — every number shown is the live one, to the unit
 * displayed.
 */

/**
 * 45 → "45 s", 167 → "2 min 47 s", 725 → "12 min", 12438 → "3 h 27 min",
 * 378000 → "4 d 9 h". Seconds are kept under 10 minutes (where they matter);
 * above that the smallest shown unit is rounded to nearest.
 */
export function humanizeSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  if (s < 60) return `${s} s`;
  if (s < 600) {
    const sec = s % 60;
    return sec ? `${Math.floor(s / 60)} min ${sec} s` : `${s / 60} min`;
  }
  if (s < 3570) return `${Math.round(s / 60)} min`;
  if (s < 86_370) {
    const tm = Math.round(s / 60);
    const h = Math.floor(tm / 60);
    const m = tm % 60;
    if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  }
  const th = Math.round(s / 3600);
  const d = Math.floor(th / 24);
  const h = th % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "just now", "5 min ago", "2 h ago", "3 d ago" relative to `now` (floored to one unit). */
export function relativeAgo(iso: string, now: number = Date.now()): string {
  const s = Math.floor((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** "2026-09-23 14:36 UTC" — the absolute time shown on hover. */
export function utcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
