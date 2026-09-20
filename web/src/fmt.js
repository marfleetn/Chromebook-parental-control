// Shared formatting helpers.
export function fmtMin(min) {
  if (min == null) return "\u2014";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60); const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
export function fmtLastSeen(iso) {
  if (!iso) return "never seen";
  const d = Date.parse(iso); if (Number.isNaN(d)) return "never seen";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function statusPill(status) {
  if (!status) return { text: "no data", cls: "mut" };
  if (!status.internetAllowed) return { text: "internet off", cls: "off" };
  if (status.dailyLimitMin != null) {
    if (status.remainingDailyMin != null && status.remainingDailyMin <= 0) return { text: "budget used", cls: "warn" };
    return { text: `budget ${fmtMin(status.dailyLimitMin)}`, cls: "ok" };
  }
  return { text: "online", cls: "ok" };
}
export function usagePercent(usedMin, limitMin) {
  if (limitMin == null || limitMin <= 0) return 0;
  return Math.min(100, Math.round((usedMin / limitMin) * 100));
}
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
