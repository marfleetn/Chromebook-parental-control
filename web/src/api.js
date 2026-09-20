// CHPC console — API client. Same-origin; Vite dev proxies /api to the server.
// Every parent request carries the guardian PIN. The PIN lives in
// sessionStorage (cleared when the tab closes) or, if the parent opts in,
// localStorage on this device.
const BASE = "/api";
const PIN_KEY = "chpc.pin";

export class ApiError extends Error {
  constructor(message, { status, code, field } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

function safe(fn) { try { return fn(); } catch { return undefined; } }

export const pinStore = {
  get: () => safe(() => sessionStorage.getItem(PIN_KEY)) || safe(() => localStorage.getItem(PIN_KEY)) || "",
  set(pin, remember) {
    safe(() => sessionStorage.setItem(PIN_KEY, pin));
    if (remember) safe(() => localStorage.setItem(PIN_KEY, pin));
    else safe(() => localStorage.removeItem(PIN_KEY));
  },
  clear() {
    safe(() => sessionStorage.removeItem(PIN_KEY));
    safe(() => localStorage.removeItem(PIN_KEY));
  },
};

const listeners = new Set();
/** Subscribe to "the PIN was rejected" events (the App shows the gate). */
export function onUnauthorized(fn) { listeners.add(fn); return () => listeners.delete(fn); }

async function req(path, opts = {}) {
  const headers = { Accept: "application/json", ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const pin = opts.pin !== undefined ? opts.pin : pinStore.get();
  if (pin) headers["X-Guardian-PIN"] = pin;
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.field && data.error ? `${data.field}: ${data.error}` : (data.error || data.message || `HTTP ${res.status}`);
    const e = new ApiError(msg, { status: res.status, code: data.code, field: data.field });
    if (res.status === 401 && !opts.quiet) listeners.forEach((fn) => fn(e));
    throw e;
  }
  return data;
}

export const api = {
  health: () => req("/health"),
  /** Verify a PIN without storing it. */
  checkPin: (pin) => req("/auth/check", { pin, quiet: true }),
  getSettings: () => req("/settings"),
  setSettings: (timezone) => req("/settings", { method: "PUT", body: { timezone } }),

  listKids: () => req("/kids"),
  createKid: (name) => req("/kids", { method: "POST", body: { name } }),
  getKid: (id) => req(`/kids/${encodeURIComponent(id)}`),
  renameKid: (id, name) => req(`/kids/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }),
  deleteKid: (id) => req(`/kids/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getPolicy: (id) => req(`/kids/${encodeURIComponent(id)}/policy`),
  putPolicy: (id, policy) => req(`/kids/${encodeURIComponent(id)}/policy`, { method: "PUT", body: policy }),

  createPairing: (id, label) => req(`/kids/${encodeURIComponent(id)}/pairings`, { method: "POST", body: label ? { agentId: label } : {} }),
  deletePairing: (id, code) => req(`/kids/${encodeURIComponent(id)}/pairings/${encodeURIComponent(code)}`, { method: "DELETE" }),

  usageToday: (id) => req(`/kids/${encodeURIComponent(id)}/usage/today`),
  usageHistory: (id, days = 7) => req(`/kids/${encodeURIComponent(id)}/usage/history?days=${days}`),

  /** Score a host/URL against a paired device's effective policy (device route: no PIN needed). */
  testDecision: (code, host) => req(`/devices/${encodeURIComponent(code)}?host=${encodeURIComponent(host)}`, { pin: "" }),
};
