import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
// THE BRAIN V4.1 — Refined Dashboard
// Softer contrast, modern UI patterns from Net is Working reference
// Pill buttons with borders, arrow action icons, hover feedback
// Spacious cards, no harsh colors, clear UX hierarchy
// ═══════════════════════════════════════════════════════════════════════

const FONTS = "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap";

const C = {
  bg: "#141218", card: "#1d1b25", cardHov: "#222030",
  lime: "#daff7b", limeSoft: "#d4f57a", limeDim: "rgba(218,255,123,0.08)", limeGlow: "rgba(218,255,123,0.16)",
  purple: "#9481ff", purpleDim: "rgba(148,129,255,0.08)", purpleGlow: "rgba(148,129,255,0.16)",
  ok: "#5eead4", okSoft: "#4fd1c5", okDim: "rgba(94,234,212,0.10)",
  err: "#f87171", errSoft: "#ef4444", errDim: "rgba(248,113,113,0.10)",
  warn: "#fbbf24", warnDim: "rgba(251,191,36,0.10)",
  orange: "#fb923c",
  t1: "#ededf2", t2: "#b8b8c6", t3: "#82828f", t4: "#55555f",
  tDark: "#111018",
  brd: "rgba(255,255,255,0.07)", brdH: "rgba(255,255,255,0.14)", brdCard: "rgba(255,255,255,0.09)",
  stratColors: ["#b088f9", "#5bb5f0", "#fb923c", "#5eead4", "#82828f", "#f472b6", "#6bffa8", "#f87171"],
};
const F = { d: "'Outfit',sans-serif", b: "'DM Sans',sans-serif", m: "'JetBrains Mono',monospace" };
const COIN_C = { BTC: "#f7931a", ETH: "#627eea", SOL: "#9945ff", NEAR: "#00c08b", ICP: "#29abe2", FET: "#7c3aed", GMX: "#3b82f6", LINK: "#2a5ada", INJ: "#00bcf5", XRP: "#00aae4" };

// ═══ PRIMITIVES ═══

function Num({ val, pre = "", suf = "", dec = 2, size = "2rem", color = C.t1 }) {
  const [d, setD] = useState(0);
  useEffect(() => { const dur = 1000, st = Date.now(); const t = () => { const p = Math.min((Date.now() - st) / dur, 1); setD(val * (1 - Math.pow(1 - p, 4))); if (p < 1) requestAnimationFrame(t); }; requestAnimationFrame(t); }, [val]);
  return <span style={{ fontSize: size, fontWeight: 800, color, letterSpacing: "-0.03em", fontFamily: F.d, lineHeight: 1.1 }}>{pre}{d.toFixed(dec)}{suf}</span>;
}

function Spark({ data, color = C.lime, w = 120, h = 28 }) {
  if (!data?.length) return null;
  const mn = Math.min(...data), mx = Math.max(...data), r = mx - mn || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 3 - ((v - mn) / r) * (h - 6)}`).join(" ");
  const lp = pts.split(" ").pop()?.split(",");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polygon fill={color} fillOpacity="0.08" points={`0,${h} ${pts} ${w},${h}`}/>
      <polyline fill="none" stroke={color} strokeWidth="2" points={pts} strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.7"/>
      {lp && <circle cx={lp[0]} cy={lp[1]} r="3" fill={color}><animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite"/></circle>}
    </svg>
  );
}

// ─── Pill with optional border (like Net is Working) ───
function Pill({ children, color = C.lime, bg, bordered, large }) {
  const style = bordered
    ? { border: `1.5px solid ${color}40`, background: "transparent", color }
    : { background: bg || (color + "18"), color: bg ? C.tDark : color, border: "1.5px solid transparent" };
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: large ? "6px 16px" : "4px 11px", borderRadius: 100, fontSize: large ? "13px" : "11px", fontWeight: 700, letterSpacing: "0.02em", fontFamily: F.b, ...style }}>{children}</span>;
}

// ─── Arrow Action Button (like Net is Working) ───
function ArrowBtn({ onClick, dark, size = 32 }) {
  const [h, setH] = useState(false);
  return (
    <div onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onClick={onClick} style={{
      width: size, height: size, borderRadius: size / 2, background: dark ? C.tDark : h ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.05)",
      border: `1.5px solid ${dark ? "transparent" : C.brdCard}`, display: "flex", alignItems: "center", justifyContent: "center",
      cursor: "pointer", transition: "all 0.2s",
    }}>
      <svg width={size * 0.4} height={size * 0.4} viewBox="0 0 24 24" fill="none" stroke={dark ? C.lime : C.t2} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>
    </div>
  );
}

// ─── Card with border & hover ───
function Card({ children, style = {}, lime, purple, span, noPad }) {
  const [h, setH] = useState(false);
  const bgc = lime ? C.lime : purple ? C.purple : h ? C.cardHov : C.card;
  return (
    <div onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{
      background: bgc, borderRadius: 20, padding: noPad ? 0 : 24, position: "relative", overflow: "hidden",
      border: lime || purple ? `1.5px solid ${lime ? C.lime : C.purple}` : `1.5px solid ${h ? C.brdH : C.brdCard}`,
      gridColumn: span ? `span ${span}` : "auto", transition: "all 0.25s ease",
      color: lime || purple ? C.tDark : C.t1, ...style,
    }}>{children}</div>
  );
}

function CoinBadge({ coin, size = 34 }) {
  const bg = COIN_C[coin] || C.purple;
  return <div style={{ width: size, height: size, borderRadius: size * 0.3, background: bg + "20", border: `1.5px solid ${bg}35`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.32, fontWeight: 800, color: bg, fontFamily: F.d, flexShrink: 0 }}>{coin?.slice(0, 2)}</div>;
}

// ─── Section Heading — Large, medium weight, clean ───
function Heading({ children, count, extra }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
      <h2 style={{ fontSize: "20px", fontWeight: 600, fontFamily: F.d, color: C.t1, margin: 0, letterSpacing: "-0.01em" }}>{children}</h2>
      {count && <Pill color={C.lime} bordered>{count}</Pill>}
      <div style={{ flex: 1, height: 1, background: C.brd }}/>
      {extra}
    </div>
  );
}

// ─── Button with hover effect ───
function Btn({ children, primary, danger, style: s = {}, onClick }) {
  const [h, setH] = useState(false);
  const base = danger
    ? { background: h ? C.errDim : "transparent", border: `1.5px solid ${C.err}40`, color: C.err }
    : primary
    ? { background: h ? C.limeSoft : C.lime, border: "1.5px solid transparent", color: C.tDark, boxShadow: h ? `0 6px 20px ${C.limeGlow}` : `0 2px 10px ${C.limeGlow}` }
    : { background: h ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)", border: `1.5px solid ${C.brdCard}`, color: C.t1 };
  return <button onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onClick={onClick} style={{ padding: "11px 24px", borderRadius: 14, fontSize: "14px", fontWeight: 700, cursor: "pointer", fontFamily: F.b, display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s", ...base, ...s }}>{children}</button>;
}

function Toggle({ on, onChange }) {
  const [h, setH] = useState(false);
  return (
    <div onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onClick={() => onChange?.(!on)} style={{ width: 44, height: 24, borderRadius: 12, padding: 2, background: on ? C.lime : h ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.07)", cursor: "pointer", transition: "background 0.3s", border: `1px solid ${on ? C.lime : C.brdCard}`, flexShrink: 0 }}>
      <div style={{ width: 20, height: 20, borderRadius: 10, background: on ? C.tDark : C.t4, transform: on ? "translateX(20px)" : "translateX(0)", transition: "all 0.3s cubic-bezier(0.34,1.56,0.64,1)" }}/>
    </div>
  );
}

// ─── Brain Logo SVG ───
function BrainLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80">
      <defs><filter id="gl"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <g filter="url(#gl)" stroke={C.lime} strokeWidth="1.8" fill="none" strokeOpacity="0.85">
        <ellipse cx="40" cy="36" rx="27" ry="23"/><path d="M40 59Q42 69 38 71"/>
        {[[25,28],[35,22],[48,24],[55,32],[30,38],[42,36],[52,42],[35,48],[48,48],[40,30]].map(([x,y],i) => <circle key={i} cx={x} cy={y} r="2.2" fill={C.lime} fillOpacity="0.7"/>)}
        {[[25,28,35,22],[35,22,48,24],[48,24,55,32],[30,38,42,36],[42,36,52,42],[35,48,48,48],[25,28,30,38],[55,32,52,42],[40,30,42,36],[30,38,35,48]].map(([a,b,c,d],i) => <line key={i} x1={a} y1={b} x2={c} y2={d} strokeWidth="0.8" strokeOpacity="0.35"/>)}
      </g>
    </svg>
  );
}

// ─── Modern Fear & Greed Meter (donut arc style) ───
function FearGreed({ value = 32 }) {
  const pct = value / 100;
  const c = value <= 20 ? C.err : value <= 40 ? C.orange : value <= 55 ? C.warn : value <= 75 ? C.ok : C.lime;
  const label = value <= 20 ? "Extreme Fear" : value <= 40 ? "Fear" : value <= 55 ? "Neutral" : value <= 75 ? "Greed" : "Extreme Greed";
  // Modern donut arc
  const r = 72, cx = 90, cy = 90, sw = 10;
  const circumference = Math.PI * r; // half circle
  const offset = circumference * (1 - pct);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width="180" height="110" viewBox="0 0 180 110">
        {/* Background arc */}
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw} strokeLinecap="round"/>
        {/* Colored arc */}
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset} style={{ transition: "stroke-dashoffset 1s ease, stroke 0.5s" }}/>
        {/* Gradient glow behind arc */}
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={c} strokeWidth={sw + 8} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset} opacity="0.12" style={{ transition: "all 1s ease" }}/>
        {/* Indicator dot */}
        {(() => {
          const angle = Math.PI + pct * Math.PI;
          const dx = cx + r * Math.cos(angle), dy = cy + r * Math.sin(angle);
          return <>
            <circle cx={dx} cy={dy} r="7" fill={c} opacity="0.25"><animate attributeName="r" values="7;10;7" dur="2s" repeatCount="indefinite"/></circle>
            <circle cx={dx} cy={dy} r="5" fill={c}/>
            <circle cx={dx} cy={dy} r="2.5" fill={C.card}/>
          </>;
        })()}
        {/* Labels */}
        <text x="22" y="102" fill={C.t4} fontSize="9" fontWeight="600" fontFamily={F.b}>0</text>
        <text x="80" y="14" fill={C.t4} fontSize="9" fontWeight="600" fontFamily={F.b} textAnchor="middle">50</text>
        <text x="152" y="102" fill={C.t4} fontSize="9" fontWeight="600" fontFamily={F.b}>100</text>
      </svg>
      <div style={{ textAlign: "center", marginTop: -6 }}>
        <div style={{ fontSize: "38px", fontWeight: 800, color: c, fontFamily: F.d }}>{value}</div>
        <div style={{ fontSize: "12px", fontWeight: 700, color: c, letterSpacing: "0.06em", opacity: 0.9 }}>{label}</div>
      </div>
    </div>
  );
}

// ─── Stop Icon (octagon X stroke) ───
function StopIcon({ s = 18, c = C.err }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>;
}

// ═══ DATA ═══
const EQUITY = [300, 298, 295, 302, 308, 305, 310, 307, 312, 315, 309, 318, 322, 316, 325, 320, 328, 324, 332, 326, 335, 330, 338, 325.84];
const TRADES = [
  { coin: "GMX", entry: 6.98, exit: null, pnl: null, strat: "Bollinger Bounce", status: "open", date: "Mar 5, 08:14" },
  { coin: "NEAR", entry: 5.12, exit: 4.94, pnl: -3.51, strat: "RSI Reversal", status: "loss", date: "Mar 4, 14:22" },
  { coin: "ICP", entry: 11.20, exit: 12.54, pnl: 11.96, strat: "Early Gainer", status: "win", date: "Mar 2, 16:08" },
  { coin: "FET", entry: 1.52, exit: 1.68, pnl: 10.52, strat: "Divergence", status: "win", date: "Mar 1, 11:30" },
  { coin: "SOL", entry: 135.20, exit: 142.50, pnl: 5.39, strat: "Smart Money", status: "win", date: "Feb 28, 07:55" },
  { coin: "ETH", entry: 1980, exit: 1935, pnl: -2.27, strat: "RSI Reversal", status: "loss", date: "Feb 27, 20:12" },
  { coin: "LINK", entry: 13.50, exit: 14.80, pnl: 9.63, strat: "Panic Reversal", status: "win", date: "Feb 26, 03:44" },
];
const STRATS = [
  { name: "RSI Reversal", desc: "Buys when RSI < 30 and hourly RSI bouncing up", w: 7, l: 5, t: 12, pnl: 4.8, on: true },
  { name: "Bollinger Bounce", desc: "Mean reversion at lower Bollinger Band", w: 4, l: 4, t: 8, pnl: 1.2, on: true },
  { name: "Dip Buyer", desc: "Catches 5%+ dips with volume confirmation", w: 3, l: 3, t: 6, pnl: -2.1, on: true },
  { name: "Early Gainer", desc: "3x volume spike + positive price action", w: 9, l: 6, t: 15, pnl: 8.5, on: true },
  { name: "DCA", desc: "Dollar cost average into dips at intervals", w: 0, l: 0, t: 0, pnl: 0, on: false },
  { name: "Divergence", desc: "RSI bullish divergence — highest conviction", w: 2, l: 1, t: 3, pnl: 3.4, on: true },
  { name: "Smart Money", desc: "OBV + CMF institutional accumulation", w: 5, l: 4, t: 9, pnl: 2.2, on: true },
  { name: "Panic Reversal", desc: "Capitulation volume + deep oversold", w: 2, l: 0, t: 2, pnl: 5.6, on: true },
];

// ═══ MAIN ═══
export default function BrainV41() {
  const [tab, setTab] = useState("overview");
  const [strats, setStrats] = useState(STRATS);
  const tabs = ["Overview", "Trades", "Analytics", "Heatmap", "Strategy", "Market", "Settings"];
  const tabId = tab;
  const tabIdx = tabs.findIndex(t => t.toLowerCase() === tab);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.t1, fontFamily: F.b }}>
      <style>{`
        @import url('${FONTS}');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.05);border-radius:2px}
        @keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .fu{animation:fu .45s cubic-bezier(.16,1,.3,1) forwards;opacity:0}
        .d1{animation-delay:.03s}.d2{animation-delay:.06s}.d3{animation-delay:.09s}.d4{animation-delay:.12s}
        @media(max-width:900px){.rg{grid-template-columns:1fr 1fr!important}.rg>*{grid-column:span 1!important}}
        @media(max-width:600px){.rg{grid-template-columns:1fr!important}.tb{overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}.tb::-webkit-scrollbar{display:none}.pg{padding:0 14px!important}}
      `}</style>

      {/* ═══ HEADER ═══ */}
      <header style={{ borderBottom: `1px solid ${C.brd}`, background: "rgba(20,18,24,0.92)", backdropFilter: "blur(24px)", position: "sticky", top: 0, zIndex: 100 }}>
        <div className="pg" style={{ maxWidth: 1380, margin: "0 auto", padding: "0 28px", display: "flex", justifyContent: "space-between", alignItems: "center", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <BrainLogo/>
            <span style={{ fontSize: "19px", fontWeight: 800, fontFamily: F.d }}>The Brain</span>
            <Pill color={C.ok} bordered large>● Live</Pill>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Btn primary><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.tDark} strokeWidth="2.5" strokeLinecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/></svg> Scan Now</Btn>
            <div style={{ padding: "6px 14px", borderRadius: 12, background: C.card, border: `1.5px solid ${C.brdCard}`, fontSize: "13px", fontFamily: F.m, fontWeight: 700 }}>BTC <span style={{ color: C.lime }}>$70,746</span></div>
          </div>
        </div>
      </header>

      {/* ═══ TABS — Pill style with borders like Net is Working ═══ */}
      <div className="pg" style={{ maxWidth: 1380, margin: "0 auto", padding: "14px 28px 0" }}>
        <div className="tb" style={{ display: "inline-flex", gap: 6, position: "relative" }}>
          {tabs.map((t, i) => {
            const active = i === tabIdx;
            return <button key={t} onClick={() => setTab(t.toLowerCase())} style={{
              padding: "8px 20px", borderRadius: 100, cursor: "pointer", fontSize: "13px", fontWeight: active ? 700 : 500, fontFamily: F.b, whiteSpace: "nowrap",
              color: active ? C.tDark : C.t3, background: active ? C.lime : "transparent",
              border: active ? "1.5px solid transparent" : `1.5px solid ${C.brdCard}`,
              boxShadow: active ? `0 2px 10px ${C.limeGlow}` : "none",
              transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
            }}>{t}</button>;
          })}
        </div>
      </div>

      {/* ═══ CONTENT ═══ */}
      <div className="pg" style={{ maxWidth: 1380, margin: "0 auto", padding: "18px 28px 80px" }}>

        {/* ══════════ OVERVIEW ══════════ */}
        {tab === "overview" && <>
          {/* Row 1 */}
          <div className="rg fu d1" style={{ display: "grid", gridTemplateColumns: "1.8fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
            {/* Welcome — CLEAR PURPOSE */}
            <Card span={1} style={{ padding: 32 }}>
              <div style={{ fontSize: "14px", color: C.t3, marginBottom: 6 }}>Welcome back,</div>
              <div style={{ fontSize: "40px", fontWeight: 800, fontFamily: F.d, letterSpacing: "-0.04em", lineHeight: 1.05 }}>The Brain</div>
              <div style={{ marginTop: 10 }}><Pill bg={C.lime} large>Premium Bot</Pill></div>
              <div style={{ marginTop: 24, fontSize: "13px", color: C.t3, marginBottom: 10 }}>Quick Actions</div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn primary>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.tDark} strokeWidth="2.5" strokeLinecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/></svg>
                  Run Scan
                </Btn>
                <Btn>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.t2} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 6-6"/></svg>
                  Strategy Lab
                </Btn>
              </div>
            </Card>

            {/* Portfolio — WHOLE CARD, SPACIOUS, arrow pinned to corner */}
            <Card lime glow style={{ padding: 28, display: "flex", flexDirection: "column", justifyContent: "space-between", position: "relative" }}>
              {/* Arrow pinned to top-right corner */}
              <div style={{ position: "absolute", top: 16, right: 16 }}><ArrowBtn dark size={34}/></div>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "rgba(0,0,0,0.4)", textTransform: "uppercase", letterSpacing: "0.12em" }}>Portfolio Value</div>
              <div style={{ marginTop: 14 }}>
                <Num val={325.84} pre="$" size="40px" color={C.tDark}/>
                <div style={{ fontSize: "15px", fontWeight: 600, color: "rgba(0,0,0,0.45)", marginTop: 8 }}>+$25.84 from start <b style={{ color: "rgba(0,0,0,0.65)" }}>+8.6%</b></div>
              </div>
              <div style={{ marginTop: 14 }}><Spark data={EQUITY} color="rgba(0,0,0,0.2)" w={170} h={30}/></div>
            </Card>

            {/* Fear & Greed — MODERN METER */}
            <Card style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: C.t4, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>Fear & Greed Index</div>
              <FearGreed value={32}/>
            </Card>
          </div>

          {/* Row 2 */}
          <div className="rg fu d2" style={{ display: "grid", gridTemplateColumns: "1.8fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
            {/* Bot Performance */}
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontSize: "16px", fontWeight: 700, fontFamily: F.d }}>Bot Performance</span>
                <Pill color={C.ok} bordered large>● Running</Pill>
              </div>
              <div className="rg" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                {[["P&L", "+$23.97", C.ok], ["Win Rate", "58%", C.lime], ["Trades", "55", C.t1], ["Open", "1/5", C.purple]].map(([l, v, c]) => (
                  <div key={l}><div style={{ fontSize: "11px", fontWeight: 600, color: C.t4, marginBottom: 3 }}>{l}</div><div style={{ fontSize: "24px", fontWeight: 800, color: c, fontFamily: F.d }}>{v}</div></div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}><Spark data={EQUITY.slice(-14)} color={C.ok} w={380} h={32}/></div>
            </Card>

            {/* Open Position */}
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: "14px", fontWeight: 700, fontFamily: F.d }}>Open Position</span>
                <ArrowBtn size={28}/>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <CoinBadge coin="GMX" size={38}/>
                <div style={{ flex: 1 }}><div style={{ fontSize: "16px", fontWeight: 800, fontFamily: F.d }}>GMX</div><div style={{ fontSize: "11px", color: C.t3 }}>Bollinger Bounce</div></div>
                <div style={{ fontSize: "20px", fontWeight: 800, color: C.ok, fontFamily: F.d }}>+7.4%</div>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.04)", overflow: "hidden", marginBottom: 4 }}>
                <div style={{ height: "100%", borderRadius: 3, width: "55%", background: `linear-gradient(90deg, ${C.err}90, ${C.lime})` }}/>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", fontWeight: 700, fontFamily: F.m }}>
                <span style={{ color: C.err }}>SL 7.00</span><span style={{ color: C.t3 }}>6.98 → 7.50</span><span style={{ color: C.ok }}>TP 7.82</span>
              </div>
            </Card>

            {/* Market — NO FILL, just matching purple text */}
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ fontSize: "11px", fontWeight: 700, color: C.t4, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8 }}>Market Status</div>
                <ArrowBtn size={28}/>
              </div>
              <div style={{ fontSize: "24px", fontWeight: 800, fontFamily: F.d, color: C.purple, marginBottom: 12 }}>Neutral</div>
              {[["BTC DOM", "58.7%"], ["MCAP", "$2.32T"], ["VOL 24H", "$66.1B"]].map(([l, v]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontSize: "12px", fontWeight: 500, color: C.t3 }}>{l}</span>
                  <span style={{ fontSize: "14px", fontWeight: 800, fontFamily: F.m, color: C.t1 }}>{v}</span>
                </div>
              ))}
            </Card>
          </div>

          {/* Chart */}
          <div className="fu d3" style={{ marginBottom: 14 }}>
            <Card noPad>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <CoinBadge coin="BTC" size={30}/>
                  <span style={{ fontSize: "17px", fontWeight: 700, fontFamily: F.d }}>BTC / USDT</span>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: C.t2, fontFamily: F.m }}>$70,746</span>
                  <Pill color={C.err} bordered>-0.7%</Pill>
                </div>
                <Btn style={{ padding: "6px 14px", fontSize: "12px" }}>Open TradingView</Btn>
              </div>
              <div style={{ height: 320, background: "#0c0a14" }}>
                <iframe src="https://s.tradingview.com/widgetembed/?frameElementId=tv41&symbol=BYBIT:BTCUSDT&interval=60&hidesidetoolbar=1&symboledit=0&saveimage=0&theme=dark&style=1&timezone=Asia/Colombo&withdateranges=1&showpopupbutton=0&overrides=%7B%22paneProperties.background%22:%22%230c0a14%22,%22paneProperties.backgroundType%22:%22solid%22,%22mainSeriesProperties.candleStyle.upColor%22:%22%23daff7b%22,%22mainSeriesProperties.candleStyle.downColor%22:%22%23f87171%22,%22mainSeriesProperties.candleStyle.wickUpColor%22:%22%23daff7b%22,%22mainSeriesProperties.candleStyle.wickDownColor%22:%22%23f87171%22,%22mainSeriesProperties.candleStyle.borderUpColor%22:%22%23daff7b%22,%22mainSeriesProperties.candleStyle.borderDownColor%22:%22%23f87171%22%7D&locale=en" style={{ width: "100%", height: "100%", border: "none" }} loading="lazy"/>
              </div>
            </Card>
          </div>

          {/* Signals */}
          <Heading count="Live">Top Signals</Heading>
          <div className="rg fu d4" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
            {[
              { s: "NEAR", p: "$4.82", ch: "+3.2%", sig: "STRONG BUY", str: 72, up: true },
              { s: "ICP", p: "$12.45", ch: "+5.3%", sig: "BUY", str: 65, up: true },
              { s: "FET", p: "$1.67", ch: "-0.5%", sig: "", str: 48, up: false },
              { s: "INJ", p: "$22.30", ch: "-1.2%", sig: "", str: 35, up: false },
            ].map((r, i) => (
              <Card key={i} style={{ padding: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <CoinBadge coin={r.s} size={38}/>
                  {r.sig === "STRONG BUY" ? <Pill bg={C.ok} large>{r.sig}</Pill> : r.sig ? <Pill color={C.lime} large>{r.sig}</Pill> : <Pill color={C.t4} bordered>WATCH</Pill>}
                </div>
                <div style={{ fontSize: "17px", fontWeight: 800, fontFamily: F.d }}>{r.s}</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={{ fontSize: "14px", color: C.t2, fontFamily: F.m }}>{r.p}</span>
                  <span style={{ fontSize: "14px", fontWeight: 800, color: r.up ? C.ok : C.err }}>{r.ch}</span>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.04)" }}>
                    <div style={{ height: "100%", borderRadius: 2, width: `${r.str}%`, background: r.str >= 60 ? C.ok : r.str >= 40 ? C.lime : C.err, transition: "width 0.6s" }}/>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span style={{ fontSize: "10px", color: C.t4 }}>Signal Strength</span>
                    <span style={{ fontSize: "12px", fontWeight: 800, color: r.str >= 60 ? C.ok : C.t3 }}>{r.str}%</span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>}

        {/* ══════════ TRADES ══════════ */}
        {tab === "trades" && <>
          <Heading count={`${TRADES.length}`} extra={<Btn primary style={{ padding: "7px 16px", fontSize: "12px" }}>Scan Now</Btn>}>Trade History</Heading>
          <div className="fu d1" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {TRADES.map((t, i) => (
              <Card key={i} style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 14 }}>
                <CoinBadge coin={t.coin} size={40}/>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: "16px", fontWeight: 800, fontFamily: F.d }}>{t.coin}</span>
                    {t.status === "open" ? <Pill color={C.lime} bordered large>OPEN</Pill> : t.status === "win" ? <Pill bg={C.ok} large>WIN</Pill> : <Pill color={C.err} bordered large>LOSS</Pill>}
                  </div>
                  <div style={{ fontSize: "12px", color: C.t3, marginTop: 2 }}>{t.strat} · {t.date}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "13px", fontFamily: F.m, color: C.t2 }}>${t.entry.toFixed(2)}{t.exit ? ` → $${t.exit.toFixed(2)}` : ""}</div>
                  <div style={{ fontSize: "18px", fontWeight: 800, fontFamily: F.d, color: t.pnl == null ? C.lime : t.pnl >= 0 ? C.ok : C.err }}>{t.pnl == null ? "Running..." : `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}%`}</div>
                </div>
              </Card>
            ))}
          </div>
        </>}

        {/* ══════════ ANALYTICS ══════════ */}
        {tab === "analytics" && <>
          <Heading>Equity Curve</Heading>
          <Card className="fu d1" style={{ padding: 28, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 18 }}>
              <div><div style={{ fontSize: "30px", fontWeight: 800, color: C.ok, fontFamily: F.d }}>$325.84</div><div style={{ fontSize: "13px", color: C.t2, marginTop: 2 }}>Started: $300 · Profit: +$25.84 (+8.6%)</div></div>
              <div style={{ display: "flex", gap: 4 }}>{["1W", "1M", "3M", "ALL"].map((p, i) => <button key={p} style={{ padding: "5px 12px", borderRadius: 100, border: i === 1 ? "none" : `1.5px solid ${C.brdCard}`, fontSize: "11px", fontWeight: 700, color: i === 1 ? C.tDark : C.t3, background: i === 1 ? C.lime : "transparent", cursor: "pointer", fontFamily: F.b }}>{p}</button>)}</div>
            </div>
            <Spark data={EQUITY} color={C.ok} w={1000} h={140}/>
          </Card>
          <Heading>Risk Dashboard</Heading>
          <div className="rg fu d2" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
            {[["Max Drawdown", "-$18.40", "6.1%", C.err], ["Exposure", "$24.00", "7.4%", C.lime], ["Daily P&L", "+$2.84", "+0.9%", C.ok], ["Weekly P&L", "+$12.50", "+4.0%", C.ok]].map(([l, v, p, c]) => (
              <Card key={l}><div style={{ fontSize: "11px", fontWeight: 700, color: C.t4, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>{l}</div><div style={{ fontSize: "24px", fontWeight: 800, fontFamily: F.d, color: c }}>{v}</div><div style={{ fontSize: "13px", color: C.t3, marginTop: 2 }}>{p}</div></Card>
            ))}
          </div>
          <Heading count={`${strats.filter(s => s.on).length} active`}>Strategy Performance</Heading>
          <div className="fu d3" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {STRATS.filter(s => s.t > 0).sort((a, b) => b.pnl - a.pnl).map((s, i) => {
              const wr = Math.round((s.w / s.t) * 100);
              const sc = C.stratColors[STRATS.indexOf(s)] || C.purple;
              return (
                <Card key={s.name} style={{ padding: "14px 20px", borderLeft: `4px solid ${sc}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 10, background: sc + "18", border: `1.5px solid ${sc}30`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: 800, color: sc, fontFamily: F.d }}>{s.name[0]}</div>
                    <div style={{ flex: 1 }}><div style={{ fontSize: "15px", fontWeight: 700, fontFamily: F.d }}>{s.name}</div><div style={{ fontSize: "11px", color: C.t3 }}>{s.t} trades · {s.w}W / {s.l}L</div></div>
                    <div style={{ display: "flex", gap: 24 }}>
                      <div style={{ textAlign: "center" }}><div style={{ fontSize: "10px", color: C.t4, marginBottom: 2 }}>Win Rate</div><div style={{ fontSize: "18px", fontWeight: 800, color: wr >= 55 ? C.ok : wr >= 45 ? C.warn : C.err, fontFamily: F.d }}>{wr}%</div></div>
                      <div style={{ textAlign: "right" }}><div style={{ fontSize: "10px", color: C.t4, marginBottom: 2 }}>Total P&L</div><div style={{ fontSize: "20px", fontWeight: 800, color: s.pnl >= 0 ? C.ok : C.err, fontFamily: F.d }}>{s.pnl >= 0 ? "+" : ""}{s.pnl.toFixed(1)}</div></div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </>}

        {/* ══════════ HEATMAP ══════════ */}
        {tab === "heatmap" && <>
          <Heading count="110 Coins">RSI Heatmap — Multi-Timeframe</Heading>
          <Card className="fu d1" noPad style={{ padding: "16px 20px" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 5 }}>
                <thead><tr>{["Coin", "Price", "24h", "15m", "1H", "4H", "12H", "1D", "Signal"].map(h => (
                  <th key={h} style={{ padding: "10px 10px", fontSize: "12px", fontWeight: 600, color: C.t3, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: h === "Coin" ? "left" : "center" }}>{h}</th>
                ))}</tr></thead>
                <tbody>{[
                  { s: "BTC", p: "$70,746", c: "-0.7%", r: [73, 60, 46, 52, 46], sig: "" },
                  { s: "NEAR", p: "$4.82", c: "+3.2%", r: [52, 48, 38, 42, 36], sig: "STRONG BUY" },
                  { s: "ICP", p: "$12.45", c: "+5.3%", r: [45, 42, 35, 38, 40], sig: "BUY" },
                  { s: "SOL", p: "$87.08", c: "+0.6%", r: [58, 52, 44, 48, 42], sig: "" },
                  { s: "ETH", p: "$1,984", c: "-2.2%", r: [48, 44, 38, 42, 38], sig: "REVERSAL" },
                  { s: "GMX", p: "$7.50", c: "+5.6%", r: [62, 55, 48, 50, 44], sig: "" },
                  { s: "LINK", p: "$14.80", c: "+1.1%", r: [44, 40, 36, 42, 38], sig: "BUY" },
                  { s: "FET", p: "$1.67", c: "-0.5%", r: [55, 51, 48, 52, 50], sig: "" },
                ].map((row, i) => (
                  <tr key={i}>
                    <td style={{ padding: "10px" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><CoinBadge coin={row.s} size={28}/><span style={{ fontSize: "14px", fontWeight: 700, fontFamily: F.d }}>{row.s}</span></div></td>
                    <td style={{ padding: "8px", fontSize: "13px", color: C.t2, textAlign: "center", fontFamily: F.m, fontWeight: 600 }}>{row.p}</td>
                    <td style={{ padding: "8px", fontSize: "13px", fontWeight: 700, textAlign: "center", color: row.c.startsWith("+") ? C.ok : C.err }}>{row.c}</td>
                    {row.r.map((v, j) => {
                      const int = v <= 30 ? 0.7 : v <= 45 ? 0.3 : v <= 55 ? 0.08 : v <= 70 ? 0.3 : 0.7;
                      const bc = v <= 45 ? C.ok : v <= 55 ? C.lime : C.err;
                      return <td key={j} style={{ padding: "7px 10px", fontSize: "13px", fontWeight: 700, textAlign: "center", borderRadius: 8, fontFamily: F.m, color: int > 0.25 ? (v <= 45 ? C.ok : C.err) : C.t2, background: `${bc}${Math.round(int * 28).toString(16).padStart(2, '0')}` }}>{v}</td>;
                    })}
                    {/* Signal — MORE SPACE */}
                    <td style={{ padding: "8px 16px", textAlign: "center", minWidth: 120 }}>
                      {row.sig === "STRONG BUY" ? <Pill bg={C.ok} large>STRONG BUY</Pill> : row.sig === "BUY" ? <Pill color={C.lime} large>BUY</Pill> : row.sig ? <Pill color={C.purple} bordered large>{row.sig}</Pill> : <span style={{ fontSize: "11px", color: C.t4 }}>—</span>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
        </>}

        {/* ══════════ STRATEGY ══════════ */}
        {tab === "strategy" && <>
          <Heading count={`${strats.filter(s => s.on).length}/${strats.length}`}>Trading Strategies</Heading>
          <div className="rg fu d1" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
            {strats.map((s, i) => {
              const sc = C.stratColors[i] || C.purple;
              const wr = s.t > 0 ? Math.round((s.w / s.t) * 100) : 0;
              return (
                <div key={s.name} style={{
                  background: C.card, borderRadius: 20, padding: 22, position: "relative", overflow: "hidden",
                  border: `1.5px solid ${s.on ? sc + "40" : C.brdCard}`, transition: "border-color 0.3s",
                }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: sc, opacity: s.on ? 1 : 0.3 }}/>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div style={{ fontSize: "15px", fontWeight: 700, fontFamily: F.d }}>{s.name}</div>
                    <Toggle on={s.on} onChange={(v) => { const n = [...strats]; n[i] = { ...n[i], on: v }; setStrats(n); }}/>
                  </div>
                  <div style={{ fontSize: "11px", color: C.t3, lineHeight: 1.4, marginBottom: 12, minHeight: 32 }}>{s.desc}</div>
                  {/* Active / Inactive — PROMINENT */}
                  <div style={{ marginBottom: 12 }}>
                    {s.on
                      ? <span style={{ padding: "5px 14px", borderRadius: 100, background: C.ok + "15", border: `1.5px solid ${C.ok}30`, color: C.ok, fontSize: "13px", fontWeight: 800, fontFamily: F.d }}>● Active</span>
                      : <span style={{ padding: "5px 14px", borderRadius: 100, background: "rgba(255,255,255,0.03)", border: `1.5px solid ${C.brdCard}`, color: C.t4, fontSize: "13px", fontWeight: 800, fontFamily: F.d }}>Inactive</span>
                    }
                  </div>
                  <div style={{ display: "flex", gap: 16 }}>
                    <div><div style={{ fontSize: "10px", color: C.t4, marginBottom: 2 }}>Win</div><div style={{ fontSize: "17px", fontWeight: 800, color: wr > 50 ? C.ok : C.t3, fontFamily: F.d }}>{wr}%</div></div>
                    <div><div style={{ fontSize: "10px", color: C.t4, marginBottom: 2 }}>P&L</div><div style={{ fontSize: "17px", fontWeight: 800, color: s.pnl >= 0 ? C.ok : C.err, fontFamily: F.d }}>{s.pnl >= 0 ? "+" : ""}{s.pnl.toFixed(1)}</div></div>
                    <div><div style={{ fontSize: "10px", color: C.t4, marginBottom: 2 }}>Trades</div><div style={{ fontSize: "17px", fontWeight: 800, color: C.t2, fontFamily: F.d }}>{s.t}</div></div>
                  </div>
                </div>
              );
            })}
          </div>
        </>}

        {/* ══════════ MARKET ══════════ */}
        {tab === "market" && <>
          <Heading>Market Overview</Heading>
          <div className="rg fu d1" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
            {[["BTC", "$70,746", "-0.7%", false], ["ETH", "$1,984", "-2.2%", false], ["SOL", "$87.08", "+0.6%", true], ["XRP", "$1.36", "-2.3%", false]].map(([coin, price, ch, up]) => (
              <Card key={coin}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}><CoinBadge coin={coin} size={34}/><span style={{ fontSize: "17px", fontWeight: 700, fontFamily: F.d }}>{coin}</span></div>
                <div style={{ fontSize: "22px", fontWeight: 800, fontFamily: F.m }}>{price}</div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: up ? C.ok : C.err, marginTop: 3 }}>{ch}</div>
              </Card>
            ))}
          </div>
          <Heading>Pine Script Signals — 4H</Heading>
          <Card className="fu d2" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 14 }}><Pill bg={C.lime} large>Bybit Spot Trend Follower Pro v5.0</Pill></div>
            {[
              { coin: "BTC", sig: "HOLD", conf: 55, note: "RSI 73.5 overbought — wait for pullback to $68-69K" },
              { coin: "SOL", sig: "BUY", conf: 72, note: "Gaussian Channel breakout, volume 2.1x" },
              { coin: "ETH", sig: "WATCH", conf: 45, note: "Near support at $1,950, MACD turning" },
            ].map(s => (
              <div key={s.coin} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderRadius: 14, border: `1.5px solid ${C.brdCard}`, marginBottom: 6 }}>
                <CoinBadge coin={s.coin} size={34}/>
                <span style={{ fontSize: "15px", fontWeight: 800, fontFamily: F.d, minWidth: 44 }}>{s.coin}</span>
                {s.sig === "BUY" ? <Pill bg={C.ok} large>BUY</Pill> : <Pill color={s.sig === "HOLD" ? C.warn : C.t3} bordered large>{s.sig}</Pill>}
                <div style={{ flex: 1, fontSize: "13px", color: C.t2 }}>{s.note}</div>
                <span style={{ fontSize: "15px", fontWeight: 800, color: s.conf >= 65 ? C.ok : C.t3, fontFamily: F.m }}>{s.conf}%</span>
              </div>
            ))}
          </Card>
          <Heading>Sentiment & On-Chain</Heading>
          <div className="rg fu d3" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
            <Card><div style={{ fontSize: "11px", fontWeight: 600, color: C.t4, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Fear & Greed</div><div style={{ fontSize: "32px", fontWeight: 800, color: C.orange, fontFamily: F.d }}>32</div><div style={{ fontSize: "13px", color: C.t3 }}>Fear · Yesterday: 39</div></Card>
            <Card><div style={{ fontSize: "11px", fontWeight: 600, color: C.t4, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Funding Rate</div><div style={{ fontSize: "32px", fontWeight: 800, color: C.err, fontFamily: F.d }}>-0.012%</div><div style={{ fontSize: "13px", color: C.t3 }}>Shorts paying longs</div></Card>
            <Card><div style={{ fontSize: "11px", fontWeight: 600, color: C.t4, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Exchange Inflow</div><div style={{ fontSize: "32px", fontWeight: 800, color: C.warn, fontFamily: F.d }}>+1,240 BTC</div><div style={{ fontSize: "13px", color: C.t3 }}>Potential sell pressure</div></Card>
          </div>
        </>}

        {/* ══════════ SETTINGS ══════════ */}
        {tab === "settings" && <div className="rg fu d1" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
          <Card>
            <div style={{ fontSize: "16px", fontWeight: 700, fontFamily: F.d, marginBottom: 16 }}>Trading Parameters</div>
            {[["Position Size", "$25"], ["Max Positions", "5"], ["Stop Loss", "ATR×2"], ["Take Profit", "12%"], ["Max Hold", "48h"], ["Daily Loss Limit", "-$40"]].map(([l, v], i) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: i < 5 ? `1px solid ${C.brd}` : "none" }}>
                <span style={{ fontSize: "14px", color: C.t2 }}>{l}</span>
                <span style={{ fontSize: "14px", fontWeight: 700, color: C.lime, fontFamily: F.m }}>{v}</span>
              </div>
            ))}
          </Card>
          <Card>
            <div style={{ fontSize: "16px", fontWeight: 700, fontFamily: F.d, marginBottom: 16 }}>Bot Controls</div>
            {[["Auto-Trading", true], ["AI Brain Filter", true], ["DCA Mode", false], ["Telegram Alerts", true], ["Pine Script Webhook", false]].map(([l, v], i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0" }}>
                <span style={{ fontSize: "14px", color: v ? C.t1 : C.t3 }}>{l}</span>
                <Toggle on={v}/>
              </div>
            ))}
            <Btn danger style={{ width: "100%", justifyContent: "center", marginTop: 16 }}><StopIcon s={16}/> Emergency Stop</Btn>
          </Card>
          <Card>
            <div style={{ fontSize: "16px", fontWeight: 700, fontFamily: F.d, marginBottom: 16 }}>DCA Configuration</div>
            {[["Order Size", "$30"], ["Max Orders", "3"], ["Drop Trigger", "5%"], ["Take Profit", "8%"], ["Stop Loss", "10%"], ["Coins", "BTC, ETH"]].map(([l, v], i) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: i < 5 ? `1px solid ${C.brd}` : "none" }}>
                <span style={{ fontSize: "14px", color: C.t2 }}>{l}</span>
                <span style={{ fontSize: "14px", fontWeight: 700, color: C.purple, fontFamily: F.m }}>{v}</span>
              </div>
            ))}
          </Card>
        </div>}
      </div>
    </div>
  );
}
