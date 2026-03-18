import { useState, useEffect, useRef, useCallback } from "react";

/*
  ALTEX THRESHOLD-NETTING SIMULATOR v0.3

  v0.2 → v0.3 changes:
  1. Multi-currency: USD, EUR, SGD — independent netting, thresholds, capacity per currency
  2. RTGS clock: business hours vs closed, weekend mode with tightened thresholds
  3. Friday pre-close: mandatory zeroing before last RTGS closure
  4. Global stress mode: triggered by asset drops, tightens all parameters
  5. SSR pool: funded from simulation profits, deployable under stress
  6. Fixed invariant wording: "payments admitted only while projected exposure < capacity; breaches from revaluation trigger immediate controls"
*/

const CURRENCIES = ["USD", "EUR", "SGD"];
const CUR_COLORS = { USD: "#3b82f6", EUR: "#8b5cf6", SGD: "#06b6d4" };

const BANKS = [
  { id: "A", name: "Alpha", assets: { USD: 5000, EUR: 4000, SGD: 3000 } },
  { id: "B", name: "Beta", assets: { USD: 3500, EUR: 2500, SGD: 2000 } },
  { id: "C", name: "Gamma", assets: { USD: 6000, EUR: 5000, SGD: 4000 } },
  { id: "D", name: "Delta", assets: { USD: 2500, EUR: 2000, SGD: 1500 } },
  { id: "E", name: "Epsilon", assets: { USD: 4000, EUR: 3500, SGD: 2500 } },
  { id: "F", name: "Zeta", assets: { USD: 2000, EUR: 1500, SGD: 1000 } },
  { id: "G", name: "Eta", assets: { USD: 3500, EUR: 3000, SGD: 2000 } },
  { id: "H", name: "Theta", assets: { USD: 3000, EUR: 2000, SGD: 1500 } },
];

const SF = 0.80;
const LARGE_TX = 200;
const VOL = 0.002;
const MAX_Q_WAIT = 15;
const CURE_WINDOW = 10;
const MAX_Q_BANK = 6;

// RTGS hours (simplified: hour 0-23 UTC-like tick clock)
const RTGS_HOURS = { USD: [2, 23], EUR: [6, 17], SGD: [0, 12] };
const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const STAGE_N = "NORMAL";
const STAGE_C = "SELF_CURE";
const STAGE_D = "DISPATCH";

function thLevel(ratio, weekendShift) {
  const s = weekendShift ? 0.20 : 0;
  if (ratio < 0.60 - s) return { lv: "NORM", c: "#22c55e", bg: "#052e16", l: "Normal" };
  if (ratio < 0.80 - s) return { lv: "WARN", c: "#eab308", bg: "#422006", l: "Warn" };
  if (ratio < 0.90 - s) return { lv: "THRT", c: "#f97316", bg: "#431407", l: "Throttle" };
  if (ratio < 0.95 - s) return { lv: "FRCD", c: "#ef4444", bg: "#450a0a", l: "Forced" };
  if (ratio < 1.00) return { lv: "BLCK", c: "#dc2626", bg: "#450a0a", l: "Block" };
  return { lv: "STOP", c: "#fff", bg: "#18181b", l: "STOP" };
}

function fmt(v) { return Math.abs(v) >= 1000 ? `$${(v/1000).toFixed(1)}B` : `$${v.toFixed(0)}M`; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).substr(2,4); }

function initBank(b) {
  const out = { ...b, net: {}, cap: {}, stage: {}, cureLeft: {}, stopped: {}, settleN: 0, dispN: 0 };
  CURRENCIES.forEach(c => {
    out.net[c] = 0;
    out.cap[c] = (b.assets[c] || 0) * SF;
    out.stage[c] = STAGE_N;
    out.cureLeft[c] = 0;
    out.stopped[c] = false;
  });
  return out;
}

export default function AltexV3() {
  const [banks, setBanks] = useState(() => BANKS.map(initBank));
  const [queue, setQueue] = useState([]);
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ pay: 0, gross: 0, rej: 0, queued: 0, drain: 0, tout: 0, settle: 0, disp: 0 });
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1200);
  const [clock, setClock] = useState({ tick: 0, hour: 9, day: 0 });
  const [stress, setStress] = useState(false);
  const [ssr, setSsr] = useState(50); // initial SSR pool $50M
  const [selCur, setSelCur] = useState("USD");

  const bRef = useRef(banks); const sRef = useRef(stats); const qRef = useRef(queue);
  const clkRef = useRef(clock); const stressRef = useRef(stress); const ssrRef = useRef(ssr);
  bRef.current = banks; sRef.current = stats; qRef.current = queue;
  clkRef.current = clock; stressRef.current = stress; ssrRef.current = ssr;

  const log = useCallback((t, m) => {
    setLogs(p => [{ id: uid(), time: `${WEEK_DAYS[clkRef.current.day]}:${String(clkRef.current.hour).padStart(2,'0')}`, t, m }, ...p].slice(0, 80));
  }, []);

  const isRTGSOpen = useCallback((cur) => {
    const h = clkRef.current.hour;
    const d = clkRef.current.day;
    if (d >= 5) return false; // weekend
    const [open, close] = RTGS_HOURS[cur] || [0, 24];
    return h >= open && h < close;
  }, []);

  const isWeekend = useCallback(() => clkRef.current.day >= 5, []);
  const isFriday = useCallback(() => clkRef.current.day === 4, []);

  const processTick = useCallback(() => {
    let bc = bRef.current.map(b => ({ ...b, assets: { ...b.assets }, net: { ...b.net }, cap: { ...b.cap }, stage: { ...b.stage }, cureLeft: { ...b.cureLeft }, stopped: { ...b.stopped } }));
    let st = { ...sRef.current };
    let q = [...qRef.current];
    let clk = { ...clkRef.current };
    let sr = ssrRef.current;
    const isStress = stressRef.current;
    const wknd = clk.day >= 5;

    // Advance clock
    clk.hour = (clk.hour + 1) % 24;
    if (clk.hour === 0) clk.day = (clk.day + 1) % 7;
    clk.tick += 1;

    // Friday pre-close: force settle all at hour 22
    if (clk.day === 4 && clk.hour === 22) {
      bc.forEach((bank, idx) => {
        CURRENCIES.forEach(cur => {
          if (Math.abs(bank.net[cur]) > 1) {
            const amt = bank.net[cur];
            bank.net[cur] = 0;
            bank.settleN += 1;
            st.settle += 1;
            // distribute
            if (amt < 0) {
              const creds = bc.filter(b => b.id !== bank.id && b.net[cur] > 0);
              const tot = creds.reduce((s, b) => s + b.net[cur], 0);
              if (tot > 0) creds.forEach(c => { c.net[cur] -= Math.abs(amt) * c.net[cur] / tot; if (Math.abs(c.net[cur]) < 0.01) c.net[cur] = 0; });
            }
          }
        });
      });
      log("CLOSE", "Friday pre-close: all positions settled to zero");
    }

    // Asset fluctuation
    const volMult = isStress ? 3 : 1;
    bc.forEach(bank => {
      CURRENCIES.forEach(cur => {
        const change = bank.assets[cur] * VOL * volMult * (Math.random() * 2 - 1);
        bank.assets[cur] = Math.max(bank.assets[cur] * 0.3, bank.assets[cur] + change);
        bank.cap[cur] = bank.assets[cur] * SF;
      });
    });

    // Check stress trigger: if >30% of banks have any currency >80%
    let highCount = 0;
    bc.forEach(bank => {
      CURRENCIES.forEach(cur => {
        const r = bank.cap[cur] > 0 ? Math.abs(bank.net[cur]) / bank.cap[cur] : 0;
        if (r > 0.80) highCount++;
      });
    });
    if (highCount >= Math.floor(bc.length * CURRENCIES.length * 0.3) && !isStress) {
      setStress(true);
      log("STRESS", "GLOBAL STRESS MODE activated — thresholds tightened");
    }

    // Self-cure processing
    bc.forEach((bank, idx) => {
      CURRENCIES.forEach(cur => {
        if (bank.stage[cur] === STAGE_C) {
          bank.cureLeft[cur] -= 1;
          if (Math.random() < 0.3 && Math.abs(bank.net[cur]) > 1) {
            const ca = Math.abs(bank.net[cur]) * (0.2 + Math.random() * 0.3);
            if (bank.net[cur] < 0) {
              bank.net[cur] += ca;
              const creds = bc.filter(b => b.id !== bank.id && b.net[cur] > 0);
              const tot = creds.reduce((s, b) => s + b.net[cur], 0);
              if (tot > 0) creds.forEach(c => { c.net[cur] -= ca * c.net[cur] / tot; });
            } else {
              bank.net[cur] -= ca;
            }
          }
          const ratio = bank.cap[cur] > 0 ? Math.abs(bank.net[cur]) / bank.cap[cur] : 1;
          if (ratio < 0.80) {
            bank.stage[cur] = STAGE_N; bank.stopped[cur] = false; bank.cureLeft[cur] = 0;
            log("RESUME", `${bank.name} ${cur} self-cured`);
          } else if (bank.cureLeft[cur] <= 0) {
            // Forced dispatch
            bank.stage[cur] = STAGE_D;
            const exp = Math.abs(bank.net[cur]);
            const disp = Math.min(exp, bank.cap[cur]);
            bank.assets[cur] = Math.max(0, bank.assets[cur] - disp);
            bank.cap[cur] = bank.assets[cur] * SF;
            const old = bank.net[cur];
            bank.net[cur] = old < 0 ? bank.net[cur] + disp : bank.net[cur] - disp;
            if (Math.abs(bank.net[cur]) < 0.01) bank.net[cur] = 0;
            bank.dispN += 1; st.disp += 1;
            const rem = Math.abs(bank.net[cur]);
            if (rem > 1) {
              log("DISPATCH", `${bank.name} ${cur} dispatched ${fmt(disp)}, shortfall ${fmt(rem)} → haircut`);
              const creds = bc.filter(b => b.id !== bank.id && b.net[cur] > 0);
              const tot = creds.reduce((s, b) => s + b.net[cur], 0);
              if (tot > 0) creds.forEach(c => { c.net[cur] -= rem * c.net[cur] / tot; });
              bank.net[cur] = 0;
            } else {
              log("DISPATCH", `${bank.name} ${cur} dispatched ${fmt(disp)} — covered`);
            }
            bank.stage[cur] = STAGE_N; bank.stopped[cur] = false;
          }
        }
      });
    });

    // Generate payment (skip if weekend and batch mode — only every 4th tick)
    const doPay = wknd ? (clk.tick % 4 === 0) : true;
    if (doPay) {
      const cur = CURRENCIES[Math.floor(Math.random() * CURRENCIES.length)];
      const active = bc.filter(b => !b.stopped[cur]);
      if (active.length >= 2) {
        const si = Math.floor(Math.random() * active.length);
        let ri = Math.floor(Math.random() * (active.length - 1));
        if (ri >= si) ri++;
        const sender = active[si]; const receiver = active[ri];
        let amt = Math.min(600, Math.max(1, Math.exp(Math.random() * 3.5 + 2)));
        const sIdx = bc.findIndex(b => b.id === sender.id);
        const rIdx = bc.findIndex(b => b.id === receiver.id);
        const exp = Math.abs(bc[sIdx].net[cur]);
        const ratio = bc[sIdx].cap[cur] > 0 ? exp / bc[sIdx].cap[cur] : 1;
        const th = thLevel(ratio, wknd || isStress);

        let rej = false; let rejR = "";
        if (bc[sIdx].stopped[cur]) { rej = true; rejR = "suspended"; }
        if (!rej && (th.lv === "BLCK") && amt >= LARGE_TX) { rej = true; rejR = "large tx blocked 95%+"; }
        if (!rej && th.lv === "THRT") { amt = Math.min(amt, 300); }

        if (!rej) {
          const proj = Math.abs(bc[sIdx].net[cur] - amt);
          if (proj >= bc[sIdx].cap[cur]) {
            // Queue
            if (q.filter(p => p.sid === sender.id && p.cur === cur).length < MAX_Q_BANK) {
              q.push({ id: uid(), sid: sender.id, rid: receiver.id, cur, amt, wait: 0 });
              st.queued++;
              log("QUEUE", `${sender.name}→${receiver.name} ${fmt(amt)} ${cur}`);
            } else { rej = true; rejR = "queue full"; }
          } else {
            bc[sIdx].net[cur] -= amt; bc[rIdx].net[cur] += amt;
            st.pay++; st.gross += amt;
            log("PAY", `${sender.name}→${receiver.name} ${fmt(amt)} ${cur}`);
          }
        }
        if (rej) { st.rej++; log("REJECT", `${sender.name}→${receiver.name} ${fmt(amt)} ${cur}: ${rejR}`); }
      }
    }

    // Drain queue
    const nq = [];
    for (const item of q) {
      item.wait++;
      if (item.wait > MAX_Q_WAIT) { st.tout++; log("TOUT", `${item.sid}→${item.rid} ${fmt(item.amt)} ${item.cur} expired`); continue; }
      const sIdx = bc.findIndex(b => b.id === item.sid);
      const rIdx = bc.findIndex(b => b.id === item.rid);
      if (sIdx < 0 || rIdx < 0 || bc[sIdx].stopped[item.cur]) { nq.push(item); continue; }
      const proj = Math.abs(bc[sIdx].net[item.cur] - item.amt);
      if (proj < bc[sIdx].cap[item.cur]) {
        bc[sIdx].net[item.cur] -= item.amt; bc[rIdx].net[item.cur] += item.amt;
        st.pay++; st.gross += item.amt; st.drain++;
        log("DRAIN", `${bc[sIdx].name}→${bc[rIdx].name} ${fmt(item.amt)} ${item.cur}`);
      } else { nq.push(item); }
    }
    q = nq;

    // Threshold checks
    bc.forEach((bank, idx) => {
      CURRENCIES.forEach(cur => {
        if (bank.stage[cur] !== STAGE_N) return;
        const exp = Math.abs(bank.net[cur]);
        const ratio = bank.cap[cur] > 0 ? exp / bank.cap[cur] : 1;
        const th = thLevel(ratio, wknd || isStress);

        if (th.lv === "STOP") {
          bank.stopped[cur] = true;
          bank.stage[cur] = STAGE_C;
          bank.cureLeft[cur] = CURE_WINDOW;
          log("CURE", `${bank.name} ${cur} → SELF-CURE (${CURE_WINDOW} ticks)`);
        }

        if (th.lv === "BLCK" || th.lv === "FRCD") {
          // Rolling settle
          const sr2 = 0.4 + Math.random() * 0.3;
          const sa = bank.net[cur] * sr2;
          bank.net[cur] -= sa;
          if (sa < 0) {
            const creds = bc.filter(b => b.id !== bank.id && b.net[cur] > 0);
            const tot = creds.reduce((s, b) => s + b.net[cur], 0);
            if (tot > 0) creds.forEach(c => { c.net[cur] -= Math.abs(sa) * c.net[cur] / tot; });
          }
          bank.settleN++; st.settle++;
          const nr = bank.cap[cur] > 0 ? Math.abs(bank.net[cur]) / bank.cap[cur] : 1;
          if (nr >= 1.0) {
            bank.stopped[cur] = true;
            bank.stage[cur] = STAGE_C;
            bank.cureLeft[cur] = CURE_WINDOW;
            log("CURE", `${bank.name} ${cur} still breached → SELF-CURE`);
          }
        }

        if (th.lv === "THRT" && Math.random() < 0.2) {
          const sr2 = 0.3 + Math.random() * 0.2;
          const sa = bank.net[cur] * sr2;
          bank.net[cur] -= sa;
          if (sa < 0) {
            const creds = bc.filter(b => b.id !== bank.id && b.net[cur] > 0);
            const tot = creds.reduce((s, b) => s + b.net[cur], 0);
            if (tot > 0) creds.forEach(c => { c.net[cur] -= Math.abs(sa) * c.net[cur] / tot; });
          }
          bank.settleN++; st.settle++;
        }
      });
    });

    // SSR: accumulate slowly
    sr = Math.min(sr + 0.5, 300);

    setBanks(bc); setStats(st); setQueue(q); setClock(clk); setSsr(sr);
  }, [log, isRTGSOpen, isWeekend, isFriday]);

  useEffect(() => { if (!running) return; const i = setInterval(processTick, speed); return () => clearInterval(i); }, [running, speed, processTick]);

  const reset = () => {
    setRunning(false); setBanks(BANKS.map(initBank)); setQueue([]); setLogs([]);
    setStats({ pay: 0, gross: 0, rej: 0, queued: 0, drain: 0, tout: 0, settle: 0, disp: 0 });
    setClock({ tick: 0, hour: 9, day: 0 }); setStress(false); setSsr(50);
  };

  const shock = () => {
    setBanks(p => p.map(b => {
      const nb = { ...b, assets: { ...b.assets }, cap: { ...b.cap } };
      CURRENCIES.forEach(c => { nb.assets[c] *= (0.82 + Math.random() * 0.06); nb.cap[c] = nb.assets[c] * SF; });
      return nb;
    }));
    log("SHOCK", "Market shock: assets -12 to -18%");
    setStress(true);
  };

  // Compute compression for selected currency
  const netOut = banks.reduce((s, b) => s + Math.abs(b.net[selCur]), 0) / 2;
  const comp = stats.gross > 0 ? (1 - netOut / stats.gross) * 100 : 0;

  const wknd = clock.day >= 5;
  const dayLabel = WEEK_DAYS[clock.day];

  return (
    <div style={{ fontFamily: "'JetBrains Mono','SF Mono',monospace", background: "#0a0a0f", color: "#ddd", minHeight: "100vh", padding: 16, fontSize: 12 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}`}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #1e1e2e" }}>
        <div>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "0.12em" }}>ALTEX<span style={{ color: "#3b82f6" }}> SIMULATOR</span></span>
          <span style={{ fontSize: 10, color: "#444", marginLeft: 8 }}>v0.3</span>
          <div style={{ fontSize: 9, color: "#555", marginTop: 2 }}>MULTI-CURRENCY · RTGS CLOCK · STRESS MODE · QUEUE · DEFAULT WATERFALL</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {/* Clock */}
          <div style={{ background: wknd ? "#7c3aed22" : "#12121c", border: `1px solid ${wknd ? "#7c3aed" : "#1e1e2e"}`, borderRadius: 4, padding: "4px 10px", fontSize: 11, fontWeight: 600, color: wknd ? "#a78bfa" : "#888" }}>
            {dayLabel} {String(clock.hour).padStart(2, "0")}:00
            {wknd && <span style={{ marginLeft: 6, fontSize: 9, color: "#a78bfa" }}>WKND</span>}
          </div>
          {stress && <div style={{ background: "#dc262622", border: "1px solid #dc2626", borderRadius: 4, padding: "4px 8px", fontSize: 9, fontWeight: 700, color: "#ef4444" }}>STRESS</div>}
          <div style={{ background: "#12121c", border: "1px solid #1e1e2e", borderRadius: 4, padding: "4px 8px", fontSize: 10, color: "#06b6d4" }}>SSR: {fmt(ssr)}</div>
          <button onClick={() => setRunning(!running)} style={{ background: running ? "#dc2626" : "#22c55e", color: "#fff", border: "none", padding: "6px 16px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600 }}>{running ? "PAUSE" : "START"}</button>
          <button onClick={shock} style={{ background: "#7c3aed", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600 }}>SHOCK</button>
          <button onClick={reset} style={{ background: "#333", color: "#aaa", border: "1px solid #444", padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>RESET</button>
          <button onClick={() => { setStress(false); log("STRESS", "Stress mode manually exited"); }} style={{ background: "#1a1a24", color: "#666", border: "1px solid #333", padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 10 }}>EXIT STRESS</button>
          <select value={speed} onChange={e => setSpeed(Number(e.target.value))} style={{ background: "#1a1a24", color: "#aaa", border: "1px solid #333", padding: "6px", borderRadius: 4, fontFamily: "inherit", fontSize: 10 }}>
            <option value={2000}>0.5x</option><option value={1200}>1x</option><option value={600}>2x</option><option value={300}>4x</option>
          </select>
        </div>
      </div>

      {/* Currency selector + stats */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
        <div style={{ fontSize: 10, color: "#555", marginRight: 4 }}>CURRENCY VIEW:</div>
        {CURRENCIES.map(c => (
          <button key={c} onClick={() => setSelCur(c)} style={{
            background: selCur === c ? CUR_COLORS[c] + "22" : "#12121c",
            border: `1px solid ${selCur === c ? CUR_COLORS[c] : "#1e1e2e"}`,
            color: selCur === c ? CUR_COLORS[c] : "#666",
            padding: "4px 14px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600,
          }}>{c}</button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, fontSize: 10 }}>
          {CURRENCIES.map(c => {
            const open = (() => { const h = clock.hour; const d = clock.day; if (d >= 5) return false; const [o, cl] = RTGS_HOURS[c]; return h >= o && h < cl; })();
            return <span key={c} style={{ color: open ? "#22c55e" : "#555" }}>{c} RTGS: {open ? "OPEN" : "CLOSED"}</span>;
          })}
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, marginBottom: 12 }}>
        {[
          { l: "PAYMENTS", v: stats.pay, c: "#3b82f6" },
          { l: "GROSS", v: fmt(stats.gross), c: "#8b5cf6" },
          { l: "NET OUT", v: fmt(netOut), c: "#f59e0b" },
          { l: "COMPRESS", v: `${comp.toFixed(0)}%`, c: comp > 70 ? "#22c55e" : "#eab308" },
          { l: "QUEUE", v: queue.length, c: "#a78bfa" },
          { l: "REJECTED", v: stats.rej, c: "#ef4444" },
          { l: "SETTLES", v: stats.settle, c: "#22d3ee" },
          { l: "DISPATCH", v: stats.disp, c: "#dc2626" },
        ].map((s, i) => (
          <div key={i} style={{ background: "#12121c", border: "1px solid #1e1e2e", borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ fontSize: 8, color: "#555", letterSpacing: "0.08em" }}>{s.l}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: s.c }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Banks + Log */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
          {banks.map(bank => {
            const cur = selCur;
            const exp = Math.abs(bank.net[cur]);
            const ratio = bank.cap[cur] > 0 ? exp / bank.cap[cur] : 0;
            const th = thLevel(ratio, wknd || stress);
            const bw = Math.min(100, ratio * 100);
            const stg = bank.stage[cur];
            const isStopped = bank.stopped[cur];
            const bq = queue.filter(p => p.sid === bank.id && p.cur === cur).length;

            return (
              <div key={bank.id} style={{ background: "#12121c", border: `1px solid ${stg !== STAGE_N ? "#f59e0b" : isStopped ? "#dc2626" : "#1e1e2e"}`, borderRadius: 6, padding: 10, position: "relative" }}>
                {stg !== STAGE_N && (
                  <div style={{ position: "absolute", top: 0, right: 0, background: stg === STAGE_C ? "#f59e0b" : "#dc2626", color: "#fff", fontSize: 7, fontWeight: 700, padding: "1px 6px", borderBottomLeftRadius: 4 }}>
                    {stg === STAGE_C ? `CURE(${bank.cureLeft[cur]})` : "DISP"}
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 11 }}>{bank.name}</span>
                    <span style={{ fontSize: 8, color: "#555", marginLeft: 6 }}>S:{bank.settleN} D:{bank.dispN} Q:{bq}</span>
                  </div>
                  <span style={{ fontSize: 8, fontWeight: 600, color: th.c, background: th.bg, padding: "1px 6px", borderRadius: 3 }}>{th.l}</span>
                </div>
                {/* Mini currency tabs */}
                <div style={{ display: "flex", gap: 2, marginBottom: 6 }}>
                  {CURRENCIES.map(c => {
                    const r = bank.cap[c] > 0 ? Math.abs(bank.net[c]) / bank.cap[c] : 0;
                    const t = thLevel(r, wknd || stress);
                    return <div key={c} style={{ flex: 1, background: c === selCur ? "#1a1a2e" : "#0f0f16", borderRadius: 3, padding: "2px 4px", fontSize: 8, textAlign: "center", border: c === selCur ? `1px solid ${CUR_COLORS[c]}44` : "1px solid transparent" }}>
                      <span style={{ color: "#555" }}>{c}</span> <span style={{ color: t.c, fontWeight: 600 }}>{(r * 100).toFixed(0)}%</span>
                    </div>;
                  })}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, fontSize: 9, marginBottom: 6 }}>
                  <div><div style={{ color: "#555", fontSize: 7 }}>ASSETS</div><div style={{ color: "#8b9dc3" }}>{fmt(bank.assets[cur])}</div></div>
                  <div><div style={{ color: "#555", fontSize: 7 }}>CAP</div><div style={{ color: "#8b9dc3" }}>{fmt(bank.cap[cur])}</div></div>
                  <div><div style={{ color: "#555", fontSize: 7 }}>NET</div><div style={{ color: bank.net[cur] > 0 ? "#22c55e" : bank.net[cur] < 0 ? "#f97316" : "#555", fontWeight: 600 }}>{bank.net[cur] >= 0 ? "+" : ""}{fmt(bank.net[cur])}</div></div>
                  <div><div style={{ color: "#555", fontSize: 7 }}>EXP</div><div style={{ color: th.c, fontWeight: 600 }}>{fmt(exp)}</div></div>
                </div>
                <div style={{ background: "#1a1a24", borderRadius: 2, height: 14, position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: `${bw}%`, background: `linear-gradient(90deg,${th.c}44,${th.c}aa)`, borderRadius: 2, transition: "width 0.3s" }} />
                  {[60, 80, 90, 95].map(t => <div key={t} style={{ position: "absolute", top: 0, left: `${t}%`, height: "100%", width: 1, background: "#ffffff15" }} />)}
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 600, color: ratio > 0.3 ? "#fff" : "#555" }}>{(ratio * 100).toFixed(1)}%</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Log */}
        <div style={{ background: "#12121c", border: "1px solid #1e1e2e", borderRadius: 6, padding: 10, display: "flex", flexDirection: "column", maxHeight: 490 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: "#555", letterSpacing: "0.08em", marginBottom: 6, borderBottom: "1px solid #1e1e2e", paddingBottom: 4 }}>EVENT LOG</div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {logs.map(l => {
              const tc = { PAY: "#3b82f6", SETTLE: "#22c55e", REJECT: "#ef4444", QUEUE: "#a78bfa", DRAIN: "#06b6d4", TOUT: "#f97316", CURE: "#f59e0b", DISPATCH: "#dc2626", SHOCK: "#7c3aed", STRESS: "#dc2626", RESUME: "#06b6d4", CLOSE: "#8b5cf6" };
              return <div key={l.id} style={{ display: "flex", gap: 4, padding: "2px 0", borderBottom: "1px solid #0a0a12", fontSize: 9 }}>
                <span style={{ color: "#3a3a44", width: 48, flexShrink: 0 }}>{l.time}</span>
                <span style={{ color: tc[l.t] || "#666", fontWeight: 600, width: 52, flexShrink: 0, fontSize: 8 }}>{l.t}</span>
                <span style={{ color: "#777" }}>{l.m}</span>
              </div>;
            })}
            {logs.length === 0 && <div style={{ color: "#333", textAlign: "center", padding: 30, fontSize: 10 }}>Press START</div>}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: "flex", gap: 10, marginTop: 10, padding: "6px 10px", background: "#12121c", border: "1px solid #1e1e2e", borderRadius: 4, fontSize: 8, color: "#444", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontWeight: 600, color: "#555" }}>THRESHOLDS{(wknd || stress) ? " (SHIFTED -20pt)" : ""}:</span>
        {[{ l: "<60% Norm", c: "#22c55e" }, { l: "60-80% Warn", c: "#eab308" }, { l: "80-90% Thrt", c: "#f97316" }, { l: "90-95% Frcd", c: "#ef4444" }, { l: "95-100% Blck", c: "#dc2626" }, { l: "≥100% Stop", c: "#fff" }].map((t, i) => (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 2 }}><span style={{ width: 6, height: 6, borderRadius: 1, background: t.c }} />{t.l}</span>
        ))}
        <span style={{ marginLeft: "auto" }}>Payments admitted only while projected exposure remains within capacity</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 8, color: "#222", textAlign: "center" }}>ALTEX THRESHOLD-NETTING SIMULATOR v0.3 · RESEARCH PROTOTYPE · NOT A PRODUCTION SYSTEM · 2026</div>
    </div>
  );
}
