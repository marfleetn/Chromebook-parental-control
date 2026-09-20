import React, { useEffect, useState, useCallback } from "react";
import { api } from "../api.js";
import { statusPill, fmtMin, fmtLastSeen, usagePercent } from "../fmt.js";

export default function KidList({ go }) {
  const [kids, setKids] = useState(null);
  const [err, setErr] = useState(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.listKids().then((d) => { setKids(d.kids || []); setErr(null); })
      .catch((e) => { if (e.status !== 401) setErr(e.message); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const create = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      const { kid } = await api.createKid(newName.trim());
      setNewName("");
      load();
      if (kid && kid.id) go("/kid/" + kid.id);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const del = async (id, name) => {
    if (!window.confirm(`Delete ${name}? Their devices and usage history are removed and their Chromebooks stop being managed.`)) return;
    try { await api.deleteKid(id); load(); } catch (e) { setErr(e.message); }
  };

  const latestSeen = (devices) => (devices || []).reduce((mx, d) => (d.lastSeen && (!mx || d.lastSeen > mx) ? d.lastSeen : mx), null);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <h1>The kids</h1>
        <div className="row">
          <input
            placeholder="New child name…"
            value={newName}
            maxLength={60}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            style={{ width: 200 }}
          />
          <button className="btn" onClick={create} disabled={busy || !newName.trim()}>Add child</button>
        </div>
      </div>

      {err && <div className="banner error">{err} <button className="btn" onClick={load}>Retry</button></div>}

      {!kids ? (
        <div className="empty">Loading the kids…</div>
      ) : kids.length === 0 ? (
        <div className="card empty">
          <p>No children yet. Add one to start a policy.</p>
        </div>
      ) : (
        kids.map((k) => {
          const n = k.devices?.length || 0;
          const seen = latestSeen(k.devices);
          const pill = statusPill(k.status);
          return (
            <div key={k.id} className="kid-row" role="link" tabIndex={0}
                 onClick={() => go("/kid/" + k.id)}
                 onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && go("/kid/" + k.id)}>
              <div>
                <div className="kid-name">{k.name}</div>
                <div className="kid-meta">
                  {n} device{n === 1 ? "" : "s"}
                  {seen ? ` · last seen ${fmtLastSeen(seen)}` : (n ? " · never seen" : "")}
                </div>
              </div>
              <div className="row" style={{ alignItems: "center" }}>
                {k.status && (
                  <>
                    <div className="meter" title={`Used ${fmtMin(k.status.usedTodayMin)} of ${k.status.dailyLimitMin != null ? fmtMin(k.status.dailyLimitMin) : "no limit"} today`}>
                      <span
                        className={k.status.dailyLimitMin != null && k.status.remainingDailyMin <= 0 ? "over"
                          : (k.status.dailyLimitMin != null && usagePercent(k.status.usedTodayMin, k.status.dailyLimitMin) >= 75) ? "warnc" : ""}
                        style={{ width: `${usagePercent(k.status.usedTodayMin, k.status.dailyLimitMin)}%` }}
                      />
                    </div>
                    <span className={`pill ${pill.cls}`}>{pill.text}</span>
                  </>
                )}
                <button
                  className="xbtn"
                  title={`Delete ${k.name}`}
                  aria-label={`Delete ${k.name}`}
                  onClick={(e) => { e.stopPropagation(); del(k.id, k.name); }}
                >&times;</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
