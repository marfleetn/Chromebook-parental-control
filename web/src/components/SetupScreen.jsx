import React, { useState } from "react";
import { api } from "../api.js";

const CODE_RE = /^[A-Z]{8}$/;

/**
 * First-run screen: the server has no guardian PIN yet. The parent enters the
 * one-time setup code printed by the server (terminal, `docker compose logs`,
 * or the installer) and chooses a PIN.
 */
export default function SetupScreen({ onDone, health }) {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const normCode = code.toUpperCase().replace(/[^A-Z]/g, "");
  const canSubmit = CODE_RE.test(normCode) && pin.length >= 6 && pin === pin2 && !busy;

  const submit = async (e) => {
    e && e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await api.setup(normCode, pin);
      await onDone(pin);
    } catch (ex) {
      if (ex.code === "setup-code-wrong") setErr("That setup code is not right. Check the server log and try again.");
      else if (ex.code === "already-set-up") setErr("A PIN has already been set. Reload the page and unlock with it.");
      else if (ex.status === 429) setErr("Too many attempts — wait 15 minutes and try again.");
      else setErr(ex.message || "Could not reach the server.");
    }
    setBusy(false);
  };

  return (
    <div className="app">
      <main className="content" style={{ maxWidth: 480, paddingTop: 60 }}>
        <div className="row" style={{ gap: 10, marginBottom: 18 }}>
          <span className="brand-mark">CH</span>
          <h1 style={{ margin: 0 }}>Welcome — set up your PIN</h1>
        </div>
        <form className="card" onSubmit={submit}>
          <p style={{ fontSize: ".92rem", color: "var(--ink-soft)", marginTop: 0 }}>
            This console has no guardian PIN yet. To prove you are the person who installed it,
            enter the <strong>setup code</strong> the server printed when it started, then choose the PIN
            you will use from now on.
          </p>
          <details style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginBottom: 8 }}>
            <summary>Where do I find the setup code?</summary>
            <ul style={{ paddingLeft: 18, marginBottom: 0 }}>
              <li>Installer: printed at the end, or run <code>sudo chpc status</code>.</li>
              <li>Docker: <code>docker compose logs chpc</code>.</li>
              <li>Started by hand: in the terminal where the server is running.</li>
            </ul>
          </details>

          <label htmlFor="setup-code">Setup code</label>
          <input id="setup-code" autoFocus autoComplete="off" spellCheck={false} placeholder="e.g. KTRM-XPBD"
                 value={code} onChange={(e) => setCode(e.target.value)} style={{ fontFamily: "IBM Plex Mono, monospace", letterSpacing: ".08em" }} />

          <label htmlFor="new-pin">Choose a PIN <span className="mono">(6+ characters, not 123456)</span></label>
          <input id="new-pin" type="password" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
          <label htmlFor="new-pin2">Repeat the PIN</label>
          <input id="new-pin2" type="password" autoComplete="new-password" value={pin2} onChange={(e) => setPin2(e.target.value)} />
          {pin && pin2 && pin !== pin2 && <div style={{ fontSize: ".82rem", color: "var(--bad)", marginTop: 6 }}>The two PINs do not match.</div>}

          {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
          <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
            <span className={"health" + (health ? " ok" : " bad")}>{health ? "server online" : "server offline"}</span>
            <button className="btn" type="submit" disabled={!canSubmit}>{busy ? "Saving…" : "Set PIN and open console"}</button>
          </div>
        </form>
        <p style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>
          Anyone with the PIN can change every rule. Write it somewhere safe; you can change it later in Settings.
        </p>
      </main>
    </div>
  );
}
