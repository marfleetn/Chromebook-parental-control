import React, { useEffect, useState, useCallback, useReducer } from "react";
import { api } from "../api.js";
import { statusPill, fmtMin, fmtLastSeen, usagePercent, WEEKDAYS } from "../fmt.js";

function todayLocal() {
  const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
}

// ---------- Policy tab ----------
function PolicyTab({ kidId, onChanged }) {
  const [pol, setPol] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    api.getPolicy(kidId).then((d) => setPol(d.policy)).catch((e) => setErr(e.message));
  }, [kidId]);
  useEffect(() => { load(); }, [load]);

  if (!pol) return <div className="empty">Loading policy…</div>;
  if (err) return <div className="banner error">{err} <button className="btn" onClick={load}>Retry</button></div>;

  const set = (patch) => { setPol((p) => ({ ...p, ...patch })); setSaved(false); };

  const toggleInternet = (e) => set({ internetAllowed: e.target.checked });
  const addDeny = (e) => { if (e.key !== "Enter") return; const v = e.target.value.trim(); if (!v) return; e.target.value=""; set({ deny: [...(pol.deny||[]), v] }); };
  const rmDeny = (v) => set({ deny: (pol.deny||[]).filter((x) => x !== v) });
  const addSite = (e) => {
    if (e.key !== "Enter") return;
    const pat = e.target.value.trim(); const m = Number(e.currentTarget.parentElement?.dataset.m);
    if (!pat) return;
    const minutes = /^\d+$/.test(String(e.currentTarget.parentElement.dataset.m)) ? Number(e.currentTarget.parentElement.dataset.m) : 30;
    e.currentTarget.parentElement.dataset.m = "";
    e.target.value = "";
    set({ siteBudgets: [...(pol.siteBudgets||[]), { pattern: pat, minutes }] });
  };
  const rmSite = (pat) => set({ siteBudgets: (pol.siteBudgets||[]).filter((s) => s.pattern !== pat) });
  const offDayToggle = (d, on) =>
    set({ offDays: on ? [...(pol.offDays||[]), d] : (pol.offDays||[]).filter((x) => x !== d) });
  const hasWindow = !!(pol.windows?.length);
  const wDays = hasWindow ? (pol.windows[0]?.days || []) : [];
  const wStart = hasWindow ? (pol.windows[0]?.start || "08:00") : "08:00";
  const wEnd = hasWindow ? (pol.windows[0]?.end || "20:00") : "20:00";
  const dayWinToggle = (d, on) => {
    const days = on ? [...new Set([...wDays, d])].sort((a,b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)) : wDays.filter((x) => x !== d);
    set({ windows: days.length ? [{ days, start: wStart, end: wEnd }] : [] });
  };
  const winChange = (patch) => set({ windows: [{ days: wDays, start: wStart, end: wEnd, ...patch }] });

  const save = async () => {
    setBusy(true);
    try {
      await api.putPolicy(kidId, pol);
      setSaved(true);
      load();
      onChanged && onChanged();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div>
      {err && <div className="banner error">{err}</div>}
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h3>Policy</h3>
        <div className="row">
          {saved && <span className="pill ok">saved</span>}
          <button className="btn" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save policy"}</button>
        </div>
      </div>

      <div className="card">
        <label className="toggle" style={{ margin: 0 }}>
          <input type="checkbox" checked={pol.internetAllowed !== false} onChange={toggleInternet} />
          Internet is allowed
        </label>
        <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: 6 }}>
          Switch this off to block every site for this child, regardless of the rules below.
        </p>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3 style={{ font: "600 .8rem Archivo, sans-serif", letterSpacing: ".06em", textTransform: "uppercase" }}>Daily screen-time budget</h3>
          <label>Daily minutes limit <span className="mono">(leave blank for none)</span></label>
          <input
            type="number" min="0" step="5"
            value={pol.dailyMinutes ?? ""}
            onChange={(e) => set({ dailyMinutes: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="e.g. 90"
          />
        </div>

        <div className="card">
          <h3 style={{ font: "600 .8rem Archivo, sans-serif", letterSpacing: ".06em", textTransform: "uppercase" }}>Off days</h3>
          <div className="row">
            {WEEKDAYS.map((d) => {
              const on = (pol.offDays||[]).includes(d);
              return (
                <label key={d} className="toggle" style={{ margin: 0 }}>
                  <input type="checkbox" checked={on} onChange={(e) => offDayToggle(d, e.target.checked)} />
                  {d}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Per-site time budgets</h3>
        <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: 0 }}>
          A child can use each site for as many minutes as set. A pattern like <code>youtube.com</code> or <code>*.netflix.com</code> matches sub-hosts too.
        </p>
        <ul className="site-list">
          {(pol.siteBudgets||[]).map((s) => (
            <li key={s.pattern}>
              <span className="mono">{s.pattern}</span>
              <span className="chip">{s.minutes} min/day{ s.used != null ? ` (used ${s.used})` : "" }</span>
              <button className="xbtn" onClick={() => rmSite(s.pattern)} title="remove">&times;</button>
            </li>
          ))}
        </ul>
        <div className="row">
          <input placeholder="e.g. youtube.com" style={{ flex: 1 }}
                 onKeyDown={addSite} />
          <input type="number" min="1" placeholder="min" style={{ width: 90 }}
                 data-ref="sb-min" />
          <span style={{ fontSize: ".78rem", color: "var(--ink-soft)" }}>— Enter on the site field to add</span>
        </div>
      </div>

      <div className="card">
        <h3>Blocked sites</h3>
        <ul className="site-list">
          {(pol.deny||[]).map((d) => (
            <li key={d}>
              <span className="mono">{d}</span>
              <button className="xbtn" onClick={() => rmDeny(d)} title="remove">&times;</button>
            </li>
          ))}
          {(pol.deny||[]).length === 0 && <li style={{ color: "var(--ink-soft)" }}>Nothing blocked yet.</li>}
        </ul>
        <div className="row">
          <input placeholder="e.g. roblox.com" style={{ flex: 1 }} onKeyDown={addDeny} />
          <span style={{ fontSize: ".78rem", color: "var(--ink-soft)" }}>— Enter to add</span>
        </div>
      </div>

      <div className="card">
        <h3>Allowed hours <span className="pill mut" style={{ verticalAlign: "middle", marginLeft: 6 }}>
          {hasWindow ? "on" : "off"}{ (!hasWindow || wDays.length === 7) ? " (all days)" : " (" + wDays.join(", ") + ")" }
        </span></h3>
        <label className="toggle" style={{ margin: "0 0 10px" }}>
          <input
            type="checkbox"
            checked={hasWindow && wDays.length > 0}
            onChange={(e) => {
              if (e.target.checked && (!pol.windows?.length)) set({ windows: [{ days: [...WEEKDAYS], start: "08:00", end: "20:00" }] });
              else if (!e.target.checked) set({ windows: [] });
            }}
          />
          Restrict to these hours
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>From <input type="time" value={wStart} onChange={(e) => winChange({ start: e.target.value })} disabled={!hasWindow || wDays.length===0} /></label>
          <label style={{ flex: 1 }}>To <input type="time" value={wEnd} onChange={(e) => winChange({ end: e.target.value })} disabled={!hasWindow || wDays.length===0} /></label>
        </div>
        <div className="row" style={{ marginTop: 10 }} disabled={!hasWindow || wDays.length===0}>
          {WEEKDAYS.map((d) => {
            const on = wDays.includes(d);
            return (
              <label key={d} className="toggle">
                <input type="checkbox" checked={on} disabled={!hasWindow || wDays.length===0} onChange={(e) => dayWinToggle(d, e.target.checked)} />
                {d}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- Devices tab ----------
function DevicesTab({ kidId, onChanged, kid }) {
  const [kidFull, setKidFull] = useState(null);
  const [err, setErr] = useState(null);
  const [agentInput, setAgentInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getKid(kidId).then((d) => { setKidFull(d.kid); onChanged?.(); })
      .catch((e) => setErr(e.message));
  }, [kidId, onChanged]);
  useEffect(() => { load(); }, [load]);

  if (!kidFull) return <div className="empty">Loading devices…</div>;

  const add = async () => {
    setBusy(true);
    try {
      await api.createPairing(kidId, agentInput.trim() || undefined);
      setAgentInput("");
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const del = async (code) => {
    if (!window.confirm(`Unpair device ${code}? It loses access immediately.`)) return;
    try { await api.deletePairing(kidId, code); load(); } catch (e) { setErr(e.message); }
  };

  const devices = kidFull.devices || [];

  return (
    <div>
      {err && <div className="banner error">{err}</div>}
      <div className="card">
        <h3>Devices</h3>
        {devices.length === 0 ? (
          <p style={{ color: "var(--ink-soft)" }}>No Chromebooks are paired yet. Each Chromebook needs the CHPC Chrome extension installed — when it runs, it shows you a pairing code. Paste it below (or leave blank to let the extension pick you).</p>
        ) : (
          <ul className="site-list">
            {devices.map((d) => (
              <li key={d.pairingCode || d.id}>
                <div>
                  <div className="mono">{d.pairingCode}</div>
                  <div style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginTop: 2 }}>
                    {d.agentId ? `agent ${d.agentId}` : ""}
                    { d.lastSeen ? ` · last seen ${fmtLastSeen(d.lastSeen)}` : "" }
                  </div>
                </div>
                <button className="btn danger small" onClick={() => del(d.pairingCode)}>Unpair</button>
              </li>
            ))}
          </ul>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <input
            placeholder="Pairing code (e.g. ABC1-DEF2-XYZ3) or leave blank"
            style={{ flex: 1 }}
            value={agentInput}
            onChange={(e) => setAgentInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="btn" onClick={add} disabled={busy}>{busy ? "…" : "Pair device"}</button>
        </div>
      </div>
      <div className="card">
        <h3>Test a decision</h3>
        <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: 0 }}>
          Pick a paired device and enter a host or URL — we ask the server to score it against <em>this child's</em> effective policy, exactly like the Chromebook extension would.
        </p>
        <div className="row">
          <select id="test-code" style={{ flex: "0 0 auto" }} disabled={devices.length === 0}>
            {devices.length === 0 ? (
              <option value="">no devices paired</option>
            ) : (
              devices.map((d) => (
                <option key={d.pairingCode} value={d.pairingCode}>{d.pairingCode}</option>
              ))
            )}
          </select>
          <input id="test-url" placeholder="e.g. https://www.youtube.com/watch?v=…" style={{ flex: 1 }} />
          <button
            className="btn ghost"
            disabled={devices.length === 0}
            onClick={async () => {
              const code = document.getElementById("test-code").value;
              const raw = (document.getElementById("test-url").value || "").trim();
              if (!code || !raw) return;
              let host = raw;
              try { host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname; } catch { /* keep as host token */ }
              const el = document.getElementById("test-out");
              el.textContent = "assembling…";
              try {
                const r = await fetch(`/api/devices/${encodeURIComponent(code)}?host=${encodeURIComponent(host)}`, { headers: { Accept: "application/json" } }).then((x) => ({ status: x.status, body: x.json() }));
                el.textContent = r.status + "  " + JSON.stringify(r.body.decision || r.body, null, 2).slice(0, 600);
              } catch (e) { el.textContent = String(e && e.message || e); }
            }}
          >Check</button>
        </div>
        <pre id="test-out" style={{ whiteSpace: "pre-wrap", fontSize: ".82rem", marginTop: 10, minHeight: 20 }}>{"\u00A0"}</pre>
      </div>
    </div>
  );
}

// ---------- Usage tab ----------
function UsageTab({ kidId }) {
  const [today, setToday] = useState(null);
  const [hist, setHist] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    Promise.all([api.usageToday(kidId), api.usageHistory(kidId)])
      .then(([t, h]) => { setToday(t); setHist(h); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [kidId]);
  useEffect(() => { load(); }, [load]);

  if (err) return <div className="banner error">{err} <button className="btn" onClick={load}>Retry</button></div>;
  if (!today) return <div className="empty">Loading usage…</div>;

  const st = today.status || {};
  const topSites = (today.sites || []).slice(0, 15);
  const days = hist?.days || [];
  const maxMin = Math.max(1, ...days.map((d) => d.minutes));

  return (
    <div>
      <div className="grid-2">
        <div className="card">
          <h3>Today</h3>
          <div className="row">
            <span className={`pill ${st.internetAllowed !== false ? "ok" : "off"}`}>{st.internetAllowed !== false ? "online" : "offline"}</span>
            {st.dailyLimitMin != null && (
              <>
                <span className="chip">{fmtMin(st.usedTodayMin)} used</span>
                <span className="chip">of {fmtMin(st.dailyLimitMin)}</span>
                <span className="chip">{st.remainingDailyMin === null ? "no limit" : fmtMin(Math.max(0, st.remainingDailyMin)) + " left"}</span>
              </>
            )}
          </div>
          {st.dailyLimitMin != null && (
            <div className="meter" style={{ marginTop: 12 }}>
              <span
                className={st.remainingDailyMin <= 0 ? "over" : (usagePercent(st.usedTodayMin, st.dailyLimitMin) >= 75 ? "warnc" : "")}
                style={{ width: `${usagePercent(st.usedTodayMin, st.dailyLimitMin)}%` }}
              />
            </div>
          )}
        </div>
        <div className="card">
          <h3>Top sites today</h3>
          {topSites.length === 0 ? (
            <p style={{ color: "var(--ink-soft)", marginTop: 0 }}>Nothing recorded yet today.</p>
          ) : (
            <ul className="site-list">
              {topSites.map((s) => (
                <li key={s.site}>
                  <span className="mono">{s.site}</span>
                  <span className="chip">{s.minutes} min · {s.visits}{ s.budgetMinutes != null ? ` / ${s.budgetMinutes} budget` : "" }</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <h3>7-day history</h3>
        {days.length === 0 ? (
          <p style={{ color: "var(--ink-soft)", marginTop: 0 }}>No usage in the last 7 days.</p>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120 }}>
            {days.map((d) => {
              const h = Math.max(3, Math.round((d.minutes / maxMin) * 100));
              const isToday = d.date === todayLocal();
              return (
                <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div
                    style={{
                      width: "100%",
                      height: `${h}%`,
                      background: isToday ? "var(--brass)" : "var(--brass-soft)",
                      borderRadius: "2px 2px 0 0",
                    }}
                    title={`${d.date} — ${fmtMin(d.minutes)} over ${d.visits} visits`}
                  />
                  <div style={{ fontSize: ".68rem", color: "var(--ink-soft)", marginTop: 4 }}>{d.date.slice(5)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Detail page ----------
const TABS = [
  { id: "policy", label: "Policy" },
  { id: "devices", label: "Devices" },
  { id: "usage", label: "Usage" },
];

export default function KidDetail({ id, onHome, onChanged }) {
  const [kid, setKid] = useState(null);
  const [tab, setTab] = useState("policy");
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    api.getKid(id).then((d) => setKid(d.kid)).catch((e) => {
      if ((e.message || "").startsWith("404") || /not found/i.test(e.message)) setNotFound(true);
    });
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (notFound) return (
    <div>
      <button className="back" onClick={onHome}>← Back to the kids</button>
      <div className="card empty">That child doesn't exist (or was deleted). <br /><button className="btn" style={{ marginTop: 12 }} onClick={onHome}>Go back</button></div>
    </div>
  );

  if (!kid) return <div className="empty">Loading…</div>;

  const sp = statusPill(kid.status);
  return (
    <div>
      <button className="back" onClick={onHome}>← Back to the kids</button>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>{kid.name}</h1>
        <span className={`pill ${sp.cls}`}>{sp.text}</span>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === "policy" && <PolicyTab kidId={id} onChanged={onChanged} />}
      {tab === "devices" && <DevicesTab kidId={id} kid={kid} onChanged={onChanged} />}
      {tab === "usage" && <UsageTab kidId={id} />}
    </div>
  );
}
