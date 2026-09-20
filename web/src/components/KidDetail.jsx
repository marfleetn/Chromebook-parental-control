import React, { useEffect, useState, useCallback } from "react";
import { api } from "../api.js";
import { statusPill, fmtMin, fmtLastSeen, usagePercent, WEEKDAYS } from "../fmt.js";

const MODES = [
  { id: "unrestricted", label: "Everything allowed (except blocked sites)" },
  { id: "denylist", label: "Everything allowed (except blocked sites)" },
  { id: "allowlist", label: "Approved sites only" },
];
const HOST_HINT = "e.g. youtube.com — covers www., m. and every other sub-site";

function cleanPattern(v) {
  return v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// ---------- Policy tab ----------
function PolicyTab({ kidId, onChanged }) {
  const [pol, setPol] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [denyInput, setDenyInput] = useState("");
  const [allowInput, setAllowInput] = useState("");
  const [sbPattern, setSbPattern] = useState("");
  const [sbMinutes, setSbMinutes] = useState("30");
  const [offDate, setOffDate] = useState("");

  const load = useCallback(() => {
    api.getPolicy(kidId).then((d) => { setPol(d.policy || {}); setErr(null); setDirty(false); })
      .catch((e) => { if (e.status !== 401) setErr(e.message); });
  }, [kidId]);
  useEffect(() => { load(); }, [load]);

  if (err && !pol) return <div className="banner error">{err} <button className="btn" onClick={load}>Retry</button></div>;
  if (!pol) return <div className="empty">Loading policy…</div>;

  const set = (patch) => { setPol((p) => ({ ...p, ...patch })); setSaved(false); setDirty(true); };
  const deny = pol.deny || [];
  const allow = pol.allow || [];
  const budgets = pol.siteBudgets || [];
  const offDays = pol.offDays || [];
  const mode = pol.mode === "allowlist" ? "allowlist" : "unrestricted";

  const addTo = (key, raw, clear) => {
    const v = cleanPattern(raw);
    if (!v) return;
    const list = pol[key] || [];
    if (!list.includes(v)) set({ [key]: [...list, v] });
    clear("");
  };
  const removeFrom = (key, v) => set({ [key]: (pol[key] || []).filter((x) => x !== v) });

  const addBudget = () => {
    const pattern = cleanPattern(sbPattern);
    const minutes = parseInt(sbMinutes, 10);
    if (!pattern) return;
    if (!Number.isInteger(minutes) || minutes < 1) { setErr("Enter a whole number of minutes (at least 1) for the site limit."); return; }
    setErr(null);
    set({ siteBudgets: [...budgets.filter((s) => s.pattern !== pattern), { pattern, minutes }] });
    setSbPattern("");
  };
  const rmBudget = (pattern) => set({ siteBudgets: budgets.filter((s) => s.pattern !== pattern) });

  const offDayToggle = (d, on) => set({ offDays: on ? [...offDays, d] : offDays.filter((x) => x !== d) });
  const addOffDate = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(offDate)) return;
    if (!offDays.includes(offDate)) set({ offDays: [...offDays, offDate] });
    setOffDate("");
  };
  const offDates = offDays.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

  // One window is editable from the UI (the API supports several).
  const win = pol.windows?.[0] || null;
  const wDays = win?.days || (win ? [...WEEKDAYS] : []);
  const wStart = win?.start || "08:00";
  const wEnd = win?.end || "20:00";
  const setWindow = (patch) => {
    const next = { start: wStart, end: wEnd, days: wDays, ...patch };
    if (!next.days.length) { set({ windows: [] }); return; }
    const w = { start: next.start, end: next.end };
    if (next.days.length < 7) w.days = WEEKDAYS.filter((d) => next.days.includes(d));
    set({ windows: [w] });
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { policy } = await api.putPolicy(kidId, pol);
      setPol(policy);
      setSaved(true);
      setDirty(false);
      onChanged && onChanged();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const listInput = (value, setValue, onAdd, placeholder) => (
    <div className="row">
      <input placeholder={placeholder} style={{ flex: 1 }} value={value}
             onChange={(e) => setValue(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAdd(); } }} />
      <button className="btn ghost" type="button" onClick={onAdd} disabled={!value.trim()}>Add</button>
    </div>
  );

  return (
    <div>
      {err && <div className="banner error" style={{ margin: "0 0 12px" }}>{err}</div>}
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Policy</h3>
        <div className="row">
          {saved && !dirty && <span className="pill ok">saved</span>}
          {dirty && <span className="pill warn">unsaved changes</span>}
          <button className="btn" onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : "Save policy"}</button>
        </div>
      </div>

      <div className="card">
        <label className="toggle" style={{ margin: 0 }}>
          <input type="checkbox" checked={pol.internetAllowed !== false} onChange={(e) => set({ internetAllowed: e.target.checked })} />
          Internet is allowed
        </label>
        <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: 6 }}>
          Switch this off to block every website for this child, regardless of the rules below. Takes effect on their Chromebook within a minute.
        </p>
      </div>

      <div className="card">
        <h3>Mode</h3>
        <select value={mode} onChange={(e) => set({ mode: e.target.value })} style={{ maxWidth: 420 }}>
          {MODES.filter((m) => m.id !== "denylist").map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {mode === "allowlist" && (
          <>
            <p style={{ fontSize: ".84rem", color: "var(--ink-soft)" }}>
              Only the sites below can be opened. Blocked sites still win if a site appears in both lists.
            </p>
            <ul className="site-list">
              {allow.map((d) => (
                <li key={d}><span className="mono">{d}</span>
                  <button className="xbtn" onClick={() => removeFrom("allow", d)} title="remove" aria-label={`remove ${d}`}>&times;</button></li>
              ))}
              {allow.length === 0 && <li style={{ color: "var(--bad)" }}>No approved sites yet — every website will be blocked.</li>}
            </ul>
            {listInput(allowInput, setAllowInput, () => addTo("allow", allowInput, setAllowInput), HOST_HINT)}
          </>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Daily screen-time budget</h3>
          <label>Daily minutes limit <span className="mono">(blank or 0 = no limit)</span></label>
          <input
            type="number" min="0" max="1440" step="5"
            value={pol.dailyMinutes ?? ""}
            onChange={(e) => set({ dailyMinutes: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="e.g. 90"
          />
          <p style={{ fontSize: ".8rem", color: "var(--ink-soft)", marginBottom: 0 }}>
            Counts minutes the child actively has a website open, across every site.
          </p>
        </div>

        <div className="card">
          <h3>Off days</h3>
          <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: 0 }}>No internet at all on these days.</p>
          <div className="row">
            {WEEKDAYS.map((d) => (
              <label key={d} className="toggle" style={{ margin: 0 }}>
                <input type="checkbox" checked={offDays.includes(d)} onChange={(e) => offDayToggle(d, e.target.checked)} />
                {d}
              </label>
            ))}
          </div>
          <label>One-off dates (exams, holidays)</label>
          <div className="row">
            <input type="date" value={offDate} onChange={(e) => setOffDate(e.target.value)} style={{ width: "auto" }} />
            <button className="btn ghost" type="button" onClick={addOffDate} disabled={!offDate}>Add date</button>
          </div>
          {offDates.length > 0 && (
            <ul className="site-list">
              {offDates.map((d) => (
                <li key={d}><span className="mono">{d}</span>
                  <button className="xbtn" onClick={() => offDayToggle(d, false)} title="remove" aria-label={`remove ${d}`}>&times;</button></li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Allowed hours <span className="pill mut" style={{ verticalAlign: "middle", marginLeft: 6 }}>
          {win ? (wDays.length === 7 ? "every day" : wDays.join(", ")) : "off"}
        </span></h3>
        <label className="toggle" style={{ margin: "0 0 10px" }}>
          <input
            type="checkbox"
            checked={!!win}
            onChange={(e) => set({ windows: e.target.checked ? [{ start: "08:00", end: "20:00" }] : [] })}
          />
          Restrict internet to these hours
        </label>
        <div className="row">
          <label style={{ flex: 1, margin: 0 }}>From <input type="time" value={wStart} onChange={(e) => setWindow({ start: e.target.value })} disabled={!win} /></label>
          <label style={{ flex: 1, margin: 0 }}>To <input type="time" value={wEnd} onChange={(e) => setWindow({ end: e.target.value })} disabled={!win} /></label>
        </div>
        <p style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>A window that ends before it starts (e.g. 20:00 → 02:00) runs across midnight.</p>
        <div className="row" style={{ marginTop: 6 }}>
          {WEEKDAYS.map((d) => (
            <label key={d} className="toggle">
              <input type="checkbox" checked={!!win && wDays.includes(d)} disabled={!win}
                     onChange={(e) => setWindow({ days: e.target.checked ? [...wDays, d] : wDays.filter((x) => x !== d) })} />
              {d}
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Blocked sites</h3>
        <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: 0 }}>Never allowed, in any mode, at any time.</p>
        <ul className="site-list">
          {deny.map((d) => (
            <li key={d}><span className="mono">{d}</span>
              <button className="xbtn" onClick={() => removeFrom("deny", d)} title="remove" aria-label={`remove ${d}`}>&times;</button></li>
          ))}
          {deny.length === 0 && <li style={{ color: "var(--ink-soft)" }}>Nothing blocked yet.</li>}
        </ul>
        {listInput(denyInput, setDenyInput, () => addTo("deny", denyInput, setDenyInput), HOST_HINT)}
      </div>

      <div className="card">
        <h3>Per-site time limits</h3>
        <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: 0 }}>
          A daily cap for one site — e.g. 30 minutes of YouTube — while everything else follows the normal rules.
        </p>
        <ul className="site-list">
          {budgets.map((s) => (
            <li key={s.pattern}>
              <span className="mono">{s.pattern}</span>
              <span className="chip">{s.minutes} min/day</span>
              <button className="xbtn" onClick={() => rmBudget(s.pattern)} title="remove" aria-label={`remove ${s.pattern}`}>&times;</button>
            </li>
          ))}
          {budgets.length === 0 && <li style={{ color: "var(--ink-soft)" }}>No site limits yet.</li>}
        </ul>
        <div className="row">
          <input placeholder={HOST_HINT} style={{ flex: 1 }} value={sbPattern} onChange={(e) => setSbPattern(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addBudget(); } }} />
          <input type="number" min="1" max="1440" placeholder="min" style={{ width: 90 }} value={sbMinutes}
                 onChange={(e) => setSbMinutes(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addBudget(); } }} />
          <button className="btn ghost" type="button" onClick={addBudget} disabled={!sbPattern.trim()}>Add limit</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Devices tab ----------
function DevicesTab({ kidId, onChanged }) {
  const [devices, setDevices] = useState(null);
  const [err, setErr] = useState(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState(null);
  const [testHost, setTestHost] = useState("");
  const [testCode, setTestCode] = useState("");
  const [testOut, setTestOut] = useState(null);

  const load = useCallback(() => {
    api.getKid(kidId).then((d) => { setDevices(d.devices || []); setErr(null); })
      .catch((e) => { if (e.status !== 401) setErr(e.message); });
  }, [kidId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (!devices && !err) return <div className="empty">Loading devices…</div>;

  const mint = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createPairing(kidId, label.trim() || undefined);
      setMinted(r);
      setLabel("");
      load();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const revoke = async (d) => {
    if (!window.confirm(`Unpair "${d.agentId}" (${d.codeDisplay})? That Chromebook stops being managed within a minute.`)) return;
    try { await api.deletePairing(kidId, d.code); if (minted?.code === d.code) setMinted(null); load(); onChanged?.(); }
    catch (e) { setErr(e.message); }
  };
  const runTest = async () => {
    const code = testCode || devices?.[0]?.code;
    const raw = testHost.trim();
    if (!code || !raw) return;
    setTestOut("checking…");
    try {
      const r = await api.testDecision(code, raw);
      const d = r.decision;
      setTestOut(d ? `${d.allowed ? "ALLOWED" : "BLOCKED"} — ${d.reason} (${d.code}, host ${d.host})` : "No decision (is that a valid host?)");
    } catch (e) { setTestOut(e.message); }
  };

  const list = devices || [];
  return (
    <div>
      {err && <div className="banner error" style={{ margin: "0 0 12px" }}>{err}</div>}
      <div className="card">
        <h3>Paired Chromebooks</h3>
        {list.length === 0 ? (
          <p style={{ color: "var(--ink-soft)" }}>No Chromebooks paired yet. Generate a pairing code below, then type it into the CHPC extension on the child&apos;s Chromebook.</p>
        ) : (
          <ul className="site-list">
            {list.map((d) => (
              <li key={d.code}>
                <div>
                  <div><strong>{d.agentId}</strong> <span className="mono" style={{ marginLeft: 8 }}>{d.codeDisplay}</span></div>
                  <div style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginTop: 2 }}>
                    paired {fmtLastSeen(d.pairedAt)} · {d.lastSeen ? `last seen ${fmtLastSeen(d.lastSeen)}` : "never connected yet"}
                  </div>
                </div>
                <button className="btn danger small" onClick={() => revoke(d)}>Unpair</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h3>Pair a new Chromebook</h3>
        <ol style={{ fontSize: ".9rem", color: "var(--ink-soft)", paddingLeft: 20, marginTop: 0 }}>
          <li>Give the device a name and click <strong>Generate code</strong>.</li>
          <li>On the Chromebook, open the CHPC extension, enter this console&apos;s address and the code.</li>
          <li>The code is that device&apos;s key — anyone who has it can read this child&apos;s rules. Unpair to revoke it.</li>
        </ol>
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="Device name (e.g. Maya's Chromebook)" style={{ flex: 1 }} value={label} maxLength={100}
                 onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && mint()} />
          <button className="btn" onClick={mint} disabled={busy}>{busy ? "…" : "Generate code"}</button>
        </div>
        {minted && (
          <div className="code-box" aria-live="polite">
            Pairing code: <strong>{minted.codeDisplay}</strong>
            <div style={{ fontSize: ".78rem", color: "var(--ink-soft)", letterSpacing: 0, marginTop: 4 }}>
              Console address to enter on the Chromebook: <span className="mono">{window.location.origin}</span>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Test a decision</h3>
        <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginTop: 0 }}>
          Enter a site to see what this child&apos;s Chromebook would do right now — the same engine the extension runs.
        </p>
        <div className="row">
          {list.length > 1 && (
            <select value={testCode || list[0].code} onChange={(e) => setTestCode(e.target.value)} style={{ width: "auto" }}>
              {list.map((d) => <option key={d.code} value={d.code}>{d.agentId}</option>)}
            </select>
          )}
          <input placeholder="e.g. www.youtube.com" style={{ flex: 1 }} value={testHost} disabled={list.length === 0}
                 onChange={(e) => setTestHost(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runTest()} />
          <button className="btn ghost" disabled={list.length === 0 || !testHost.trim()} onClick={runTest}>Check</button>
        </div>
        {list.length === 0 && <p style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>Pair a device first.</p>}
        {testOut && <pre style={{ whiteSpace: "pre-wrap", fontSize: ".85rem", marginTop: 10 }}>{testOut}</pre>}
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
    Promise.all([api.usageToday(kidId), api.usageHistory(kidId, 7)])
      .then(([t, h]) => { setToday(t); setHist(h); setErr(null); })
      .catch((e) => { if (e.status !== 401) setErr(e.message); });
  }, [kidId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return <div className="banner error">{err} <button className="btn" onClick={load}>Retry</button></div>;
  if (!today) return <div className="empty">Loading usage…</div>;

  const st = today.status || {};
  const topSites = (today.sites || []).slice(0, 15);
  const days = hist?.perDay || [];
  const maxMin = Math.max(1, ...days.map((d) => d.minutes));
  const todayIso = days.length ? days[days.length - 1].isoDay : null;

  return (
    <div>
      <div className="grid-2">
        <div className="card">
          <h3>Today</h3>
          <div className="row">
            <span className={`pill ${st.internetAllowed !== false ? "ok" : "off"}`}>{st.internetAllowed !== false ? "internet on" : "internet off"}</span>
            <span className="chip">{fmtMin(st.usedTodayMin)} used</span>
            {st.dailyLimitMin != null && (
              <>
                <span className="chip">of {fmtMin(st.dailyLimitMin)}</span>
                <span className="chip">{fmtMin(Math.max(0, st.remainingDailyMin ?? 0))} left</span>
              </>
            )}
          </div>
          {st.dailyLimitMin != null && (
            <div className="meter" style={{ marginTop: 12, width: "100%" }}>
              <span
                className={st.remainingDailyMin <= 0 ? "over" : (usagePercent(st.usedTodayMin, st.dailyLimitMin) >= 75 ? "warnc" : "")}
                style={{ width: `${usagePercent(st.usedTodayMin, st.dailyLimitMin)}%` }}
              />
            </div>
          )}
          <p style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginBottom: 0 }}>Day starts at midnight, {today.tz}. Minutes count only while a site is open in the focused window and the child is active.</p>
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
                  <span className="chip">{s.minutes} min{s.budgetMinutes != null ? ` / ${s.budgetMinutes} limit` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Last 7 days</h3>
        {days.length === 0 ? (
          <p style={{ color: "var(--ink-soft)", marginTop: 0 }}>No history yet.</p>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120 }}>
            {days.map((d) => {
              const h = Math.max(3, Math.round((d.minutes / maxMin) * 100));
              const isToday = d.isoDay === todayIso;
              return (
                <div key={d.isoDay} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                  <div
                    style={{ width: "100%", height: `${h}%`, background: isToday ? "var(--brass)" : "var(--brass-soft)", borderRadius: "2px 2px 0 0" }}
                    title={`${d.isoDay} — ${fmtMin(d.minutes)}`}
                  />
                  <div style={{ fontSize: ".68rem", color: "var(--ink-soft)", marginTop: 4 }}>{d.isoDay.slice(5)}</div>
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
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("policy");
  const [notFound, setNotFound] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  const load = useCallback(() => {
    api.getKid(id).then((d) => { setData(d); setName(d.kid.name); }).catch((e) => {
      if (e.status === 404) setNotFound(true);
    });
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const changed = useCallback(() => { load(); onChanged?.(); }, [load, onChanged]);

  if (notFound) return (
    <div>
      <button className="back" onClick={onHome}>← Back to the kids</button>
      <div className="card empty">That child doesn&apos;t exist (or was deleted). <br /><button className="btn" style={{ marginTop: 12 }} onClick={onHome}>Go back</button></div>
    </div>
  );
  if (!data) return <div className="empty">Loading…</div>;

  const kid = data.kid;
  const sp = statusPill(data.status);
  const rename = async () => {
    if (!name.trim() || name.trim() === kid.name) { setRenaming(false); return; }
    try { await api.renameKid(id, name.trim()); setRenaming(false); changed(); } catch (e) { window.alert(e.message); }
  };

  return (
    <div>
      <button className="back" onClick={onHome}>← Back to the kids</button>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        {renaming ? (
          <div className="row">
            <input value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") rename(); if (e.key === "Escape") setRenaming(false); }} style={{ width: 260 }} />
            <button className="btn small" onClick={rename}>Save</button>
            <button className="btn ghost small" onClick={() => { setRenaming(false); setName(kid.name); }}>Cancel</button>
          </div>
        ) : (
          <h1 style={{ margin: 0, cursor: "text" }} title="Click to rename" onClick={() => setRenaming(true)}>{kid.name}</h1>
        )}
        <span className={`pill ${sp.cls}`}>{sp.text}</span>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === "policy" && <PolicyTab kidId={id} onChanged={changed} />}
      {tab === "devices" && <DevicesTab kidId={id} onChanged={changed} />}
      {tab === "usage" && <UsageTab kidId={id} />}
    </div>
  );
}
