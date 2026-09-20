import React, { useEffect, useState, useCallback } from "react";
import { api } from "./api.js";
import KidList from "./components/KidList.jsx";
import KidDetail from "./components/KidDetail.jsx";
import SettingsDrawer from "./components/SettingsDrawer.jsx";

// Tiny hash router: #/ => dashboard, #/kid/:id => detail.
function useRoute() {
  const parse = () => {
    const h = window.location.hash.replace(/^#\/?/, "");
    const m = h.match(/^kid\/([^/]+)$/);
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

  const refresh = useCallback(() => {
    Promise.all([api.health(), api.getSettings()])
      .then(([h, s]) => { setHealth(h); setSettings(s); setErr(null); })
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const saveTz = async (timezone) => {
    const s = await api.setSettings(timezone);
    setSettings(s);
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go("/")}>
          <span className="brand-mark">CH</span>
          <span className="brand-name">CHPC · Parent Console</span>
        </button>
        <div className="topbar-right">
          <span className={"health" + (health ? " ok" : " bad")} title={health ? health.service : "server unreachable"}>
            {health ? "server online" : "server offline"}
          </span>
          {settings && <span className="tz" title="time zone">{settings.timezone}</span>}
          <button className="btn ghost" onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </header>

      {err && (
        <div className="banner error">
          Can&apos;t reach the server — {err}
          <button className="btn" onClick={refresh}>Retry</button>
        </div>
      )}

      <main className="content">
        {route.name === "kid"
          ? <KidDetail id={route.id} onHome={() => go("/")} onChanged={refresh} />
          : <KidList go={go} />}
      </main>

      {showSettings && settings && (
        <SettingsDrawer
          timezone={settings.timezone}
          onSave={saveTz}
          onClose={() => setShowSettings(false)}
        />
      )}

      <footer className="foot">
        CHPC — self-hosted Chromebook parental control. Decisions are made by <code>@chpc/core</code>; this UI just edits policy and shows usage.
      </footer>
    </div>
  );
}
