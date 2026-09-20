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
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

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
    if (!window.confirm(`Delete ${name}? Their devices and usage history are removed.`)) return;
    try { await api.deleteKid(id); load(); } catch (e) { setErr(e.message); }
  };

  const lastSeenMax = (kids || []).reduce((mx, k) => {
    const ls = k.devices?.find((d) => d.lastSeen)?.lastSeen;
    if (!ls) return mx;
    return !mx || ls > mx ? ls : mx;
  }, null);
  void lastSeenMax;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <h1>The kids</h1>
        <div className="row">
          <input
            placeholder="New child name…"
            value={newName}
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
        kids.map((k) => (
          <button key={k.id} className="kid-row" onClick={() => go("/kid/" + k.id)}>
            <div>
              <div className="kid-name">{k.name}</div>
              <div className="kid-meta">
                {k.devices?.length || 0} device{ (k.devices?.length === 1) ? "" : "s" }
                { (k.devices?.[0]?.lastSeen) ? ` \u00b7 last seen ${fmtLastSeen(k.devices[0].lastSeen)}` : "" }
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
                  <span className={`pill ${statusPill(k.status).cls}`}>{statusPill(k.status).text}</span>
                </>
              )}
              <span
                role="button" className="xbtn"
                title={`Delete ${k.name}`}
                onClick={(e) => { e.stopPropagation(); del(k.id, k.name); }}
              >&times;</span>
            </div>
          </button>
        ))
      )}
    </div>
  );
}
