import React, { useState } from "react";

/** Full-screen guardian PIN prompt. Shown until the server accepts a PIN. */
export default function PinGate({ onUnlock, message, health }) {
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e && e.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onUnlock(pin, remember);
    } catch (ex) {
      if (ex.status === 401) setErr("Wrong PIN.");
      else if (ex.status === 429) setErr("Too many attempts — wait 15 minutes and try again.");
      else if (ex.status === 503) setErr(ex.message);
      else setErr(ex.message || "Could not reach the server.");
    }
    setBusy(false);
  };

  return (
    <div className="app">
      <main className="content" style={{ maxWidth: 440, paddingTop: 60 }}>
        <div className="row" style={{ gap: 10, marginBottom: 18 }}>
          <span className="brand-mark">CH</span>
          <h1 style={{ margin: 0 }}>Parent Console</h1>
        </div>
        <form className="card" onSubmit={submit}>
          <h3>Guardian PIN</h3>
          <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", marginTop: 0 }}>
            The PIN was set when the server was started (<code>CHPC_GUARDIAN_PIN</code>). It protects every rule and every child&apos;s usage data.
          </p>
          {message && <div className="banner warn" style={{ margin: "0 0 10px", background: "#f8f1e2", border: "1px solid var(--warn)", color: "var(--warn)" }}>{message}</div>}
          <label htmlFor="pin">PIN</label>
          <input id="pin" type="password" autoComplete="current-password" autoFocus
                 value={pin} onChange={(e) => setPin(e.target.value)} />
          <label className="toggle" style={{ marginTop: 12, fontWeight: 500 }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember on this device (only tick this on your own device)
          </label>
          {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
          <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
            <span className={"health" + (health ? " ok" : " bad")}>{health ? "server online" : "server offline"}</span>
            <button className="btn" type="submit" disabled={busy || !pin}>{busy ? "Checking…" : "Unlock"}</button>
          </div>
        </form>
      </main>
    </div>
  );
}
