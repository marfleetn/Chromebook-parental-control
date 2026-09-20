import React, { useMemo, useState } from "react";

// A shortlist of zones most families in this stack will want, plus free text.
const COMMON = [
  "Europe/London",
  "Europe/Dublin",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Stockholm",
  "Europe/Zurich",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Dubai",
];

export default function SettingsDrawer({ timezone, onSave, onClose }) {
  const [value, setValue] = useState(timezone || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  const preview = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: value,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date());
    } catch (e) {
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
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Settings</h2>
          <button className="xbtn" onClick={onClose} title="close">{"\u00d7"}</button>
        </div>

        <div className="card">
          <h3>Time zone</h3>
          <p style={{ fontSize: ".86rem", color: "var(--ink-soft)", marginTop: 0 }}>
            Screens-off days and allowed hours are evaluated in this time zone — it should be
            the family home zone, or off-days drift around the clock.
          </p>

          <label>
            Zone <span className="mono">(IANA)</span>
          </label>
          <input
            list="tz-common"
            value={value}
            onChange={(e) => { setValue(e.target.value); setSaved(false); }}
            placeholder="Europe/London"
          />
          <datalist id="tz-common">
            {COMMON.map((z) => <option key={z} value={z}>{z}</option>)}
          </datalist>

          <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
            <span style={{ fontSize: ".84rem", color: "var(--ink-soft)" }}>
              Local time there:{" "}
              <strong style={{ color: "var(--ink)" }}>{preview || "invalid zone"}</strong>
            </span>
          </div>

          {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
          {saved && !err && <div className="banner ok" style={{ marginTop: 12 }}>Saved.</div>}

          <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" style={{ marginLeft: 8 }} onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
