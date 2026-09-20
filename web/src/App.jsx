import React, { useEffect, useState, useCallback } from "react";
import { api, pinStore, onUnauthorized } from "./api.js";
import KidList from "./components/KidList.jsx";
import KidDetail from "./components/KidDetail.jsx";
import SettingsDrawer from "./components/SettingsDrawer.jsx";
import PinGate from "./components/PinGate.jsx";
import SetupScreen from "./components/SetupScreen.jsx";

// Tiny hash router: #/ => dashboard, #/kid/:id => detail.
function useRoute() {
  const parse = () => {
    const h = window.location.hash.replace(/^#\/?/, "");
    const m = h.match(/^kid\/(\d+)$/);
    return m ? { name: "kid", id: m[1] } : { name: "home" };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const go = (hash) => { window.location.hash = hash; };
  return { route, go };
}

export default function App() {
  const { route, go } = useRoute();
  const [health, setHealth] = useState(null);
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [err, setErr] = useState(null);
  // null = unknown yet, true = PIN accepted (or not required), false = need PIN
  const [unlocked, setUnlocked] = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [gateMsg, setGateMsg] = useState(null);

  // Any 401 anywhere in the app drops us back to the gate.
  useEffect(() => onUnauthorized((e) => {
    setUnlocked(false);
    setGateMsg(e.code === "pin-wrong" ? "That PIN was rejected. Enter it again." : null);
  }), []);

  const refresh = useCallback(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.getSettings()
      .then((s) => { setSettings(s); setErr(null); setUnlocked(true); setNeedsSetup(false); })
      .catch((e) => {
        if (e.status === 401) return; // gate handles it
        if (e.status === 503 && e.code === "setup-required") { setNeedsSetup(true); setUnlocked(false); return; }
        if (e.status === 503) { setUnlocked(false); setGateMsg(e.message); return; }
        setErr(e.message);
      });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!unlocked) return undefined;
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh, unlocked]);

  const unlock = async (pin, remember) => {
    await api.checkPin(pin);          // throws on 401/429/503
    pinStore.set(pin, remember);
    setGateMsg(null);
    setUnlocked(true);
    refresh();
  };
  const lock = () => { pinStore.clear(); setUnlocked(false); setGateMsg(null); go("/"); };
  const finishSetup = async (pin) => {
    pinStore.set(pin, false);
    setNeedsSetup(false);
    setUnlocked(true);
    refresh();
  };
  const changePin = async (pin) => {
    await api.changePin(pin);
    let remembered = false;
    try { remembered = !!localStorage.getItem("chpc.pin"); } catch { /* storage blocked */ }
    pinStore.set(pin, remembered);
    refresh();
  };

  const saveTz = async (timezone) => {
    const s = await api.setSettings(timezone);
    setSettings(s);
  };

  if (needsSetup) {
    return <SetupScreen onDone={finishSetup} health={health} />;
  }
  if (unlocked === false) {
    return <PinGate onUnlock={unlock} message={gateMsg} health={health} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go("/")}>
          <span className="brand-mark">CH</span>
          <span className="brand-name">CHPC · Parent Console</span>
        </button>
        <div className="topbar-right">
          <span className={"health" + (health ? " ok" : " bad")} title={health ? "API reachable" : "server unreachable"}>
            {health ? "server online" : "server offline"}
          </span>
          {settings && <span className="tz" title="time zone the rules run in">{settings.timezone}</span>}
          <button className="btn ghost" onClick={() => setShowSettings(true)}>Settings</button>
          <button className="btn ghost" onClick={lock} title="Forget the PIN in this browser">Lock</button>
        </div>
      </header>

      {err && (
        <div className="banner error">
          Can&apos;t reach the server — {err}
          <button className="btn" onClick={refresh}>Retry</button>
        </div>
      )}

      <main className="content">
        {unlocked === null ? (
          <div className="empty">Connecting…</div>
        ) : route.name === "kid"
          ? <KidDetail id={route.id} onHome={() => go("/")} onChanged={refresh} />
          : <KidList go={go} />}
      </main>

      {showSettings && settings && (
        <SettingsDrawer
          timezone={settings.timezone}
          retentionDays={settings.retentionDays}
          pinSource={settings.pinSource}
          onChangePin={changePin}
          onSave={saveTz}
          onClose={() => setShowSettings(false)}
        />
      )}

      <footer className="foot">
        CHPC — self-hosted Chromebook parental control. Decisions are made by <code>@chpc/core</code>; this console edits policy and shows usage.
      </footer>
    </div>
  );
}
