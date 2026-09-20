import React, { useMemo, useState } from "react";

// A shortlist of zones most families in this stack will want, plus free text.
const COMMON = [
  "Europe/London", "Europe/Dublin", "Europe/Berlin", "Europe/Paris", "Europe/Amsterdam",
  "Europe/Madrid", "Europe/Stockholm", "Europe/Zurich",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo",
  "Australia/Sydney", "Asia/Tokyo", "Asia/Singapore", "Asia/Dubai",
];

export default function SettingsDrawer({ timezone, retentionDays, onSave, onClose }) {
  const [value, setValue] = useState(timezone || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  const preview = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: value, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date());
    } catch {
      return null;
    }
  }, [value]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await onSave(value.trim());
      setSaved(true);
    } catch (e) {
      setErr(e.message || String(e));
    }
    setBusy(false);
  };

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Settings</h2>
          <button className="xbtn" onClick={onClose} title="close" aria-label="close">{"×"}</button>
        </div>

        <div className="card">
          <h3>Time zone</h3>
          <p style={{ fontSize: ".86rem", color: "var(--ink-soft)", marginTop: 0 }}>
            Off days, allowed hours and the daily reset are evaluated in this zone. It should be the family home zone.
            Changing it mid-day moves the &ldquo;today&rdquo; boundary, so usage totals may jump.
          </p>
          <label htmlFor="tz">Zone <span className="mono">(IANA name)</span></label>
          <input id="tz" list="tz-common" value={value} placeholder="Europe/London"
                 onChange={(e) => { setValue(e.target.value); setSaved(false); }} />
          <datalist id="tz-common">
            {COMMON.map((z) => <option key={z} value={z}>{z}</option>)}
          </datalist>
          <div className="row" style={{ marginTop: 12 }}>
            <span style={{ fontSize: ".84rem", color: "var(--ink-soft)" }}>
              Local time there: <strong style={{ color: preview ? "var(--ink)" : "var(--bad)" }}>{preview || "invalid zone"}</strong>
            </span>
          </div>
          {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
          {saved && !err && <div className="banner ok" style={{ marginTop: 12 }}>Saved.</div>}
          <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
            <button className="btn ghost" onClick={onClose}>Close</button>
            <button className="btn" onClick={save} disabled={busy || !preview}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>

        <div className="card">
          <h3>Data &amp; privacy</h3>
          <ul style={{ fontSize: ".86rem", color: "var(--ink-soft)", paddingLeft: 18, margin: 0 }}>
            <li>Only the <strong>hostname</strong> of visited sites is stored — never full page addresses.</li>
            <li>Usage history is kept for <strong>{retentionDays ? `${retentionDays} days` : "ever"}</strong>
              {" "}(set <code>CHPC_RETENTION_DAYS</code> on the server to change this).</li>
            <li>Deleting a child removes their rules, devices and all usage rows immediately.</li>
            <li>Everything lives in one SQLite file on the machine running the server; nothing is sent to third parties.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
