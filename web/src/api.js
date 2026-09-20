// CHPC console — API client. Same-origin; Vite dev proxies /api to the server.
const BASE = "/api";

async function req(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || data.message || (data.field ? `${data.field}: ${data.error}` : `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return data;
}

export const api = {
  health: () => req("/health"),
  getSettings: () => req("/settings"),
  setSettings: (timezone) => req("/settings", { method: "PUT", body: { timezone } }),

  listKids: () => req("/kids"),
  createKid: (name) => req("/kids", { method: "POST", body: { name } }),
  getKid: (id) => req(`/kids/${id}`),
  deleteKid: (id) => req(`/kids/${id}`, { method: "DELETE" }),

  getPolicy: (id) => req(`/kids/${id}/policy`),
  putPolicy: (id, policy) => req(`/kids/${id}/policy`, { method: "PUT", body: policy }),

  createPairing: (id, agentId) => req(`/kids/${id}/pairings`, { method: "POST", body: agentId ? { agentId } : {} }),
  deletePairing: (id, code) => req(`/kids/${id}/pairings/${encodeURIComponent(code)}`, { method: "DELETE" }),

  usageToday: (id) => req(`/kids/${id}/usage/today`),
  usageHistory: (id) => req(`/kids/${id}/usage/history`),
};
