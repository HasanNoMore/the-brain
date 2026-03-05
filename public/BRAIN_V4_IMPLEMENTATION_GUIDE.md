# THE BRAIN — Dashboard V4.1 Implementation Guide
## For Claude Code (VS Code) — Apply to public/index.html

---

## OVERVIEW

This document provides EXACT specifications for redesigning the Brain dashboard.
The current `public/index.html` is ~3900 lines. We are changing ONLY the visual layer:
- CSS design tokens
- Font imports
- Card styles, spacing, colors
- Component sizes and typography
- Fear & Greed gauge
- Strategy cards
- Signal cards
- Button styles

**DO NOT CHANGE**: JavaScript functionality, API calls, data fetching, event handlers, WebSocket connections, Telegram alerts, scanner logic, TradingView widget initialization, localStorage handling.

---

## STEP 1: Replace Font Import

**Current (line 11):**
```html
<link href="https://fonts.googleapis.com/css2?family=Zalando+Sans+Expanded:ital,wght@0,200..900;1,200..900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

**Replace with:**
```html
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
```

---

## STEP 2: Replace CSS Design Tokens

**Replace the :root dark theme variables with:**
```css
:root, [data-theme="dark"] {
    /* Backgrounds — Kepler-11e dark with purple undertone */
    --bg: #141218;
    --bg2: #1d1b25;
    /* Cards — visible borders, soft hover */
    --card: #1d1b25;
    --card-h: #222030;
    /* Primary — lime */
    --pri: #daff7b;
    --pri-l: #d4f57a;
    --pri-d: rgba(218,255,123,0.08);
    --pri-g: rgba(218,255,123,0.16);
    /* Secondary — purple */
    --acc: #9481ff;
    --acc-d: rgba(148,129,255,0.08);
    --acc-g: rgba(148,129,255,0.16);
    --acc-b: rgba(148,129,255,0.06);
    /* Blues */
    --blue: #2d4aca;
    --blue-d: #2441c1;
    --blue-l: rgba(45,74,202,0.18);
    /* Status — softer, less harsh */
    --ok: #5eead4;
    --ok-d: rgba(94,234,212,0.10);
    --err: #f87171;
    --err-d: rgba(248,113,113,0.10);
    --warn: #fbbf24;
    --warn-d: rgba(251,191,36,0.10);
    /* Text — ALL BRIGHTER for readability */
    --t1: #f2f2f6;
    --t2: #c5c5d0;
    --t3: #8a8a98;
    --t4: #5a5a68;
    /* Borders — visible but soft */
    --brd: rgba(255,255,255,0.07);
    --brd-h: rgba(255,255,255,0.14);
    --brd-a: rgba(218,255,123,0.25);
    --brd-s: rgba(148,129,255,0.25);
    /* Other */
    --ov: rgba(0,0,0,0.84);
    --inp: rgba(255,255,255,0.05);
    --inp-f: rgba(255,255,255,0.09);
    --hov: rgba(255,255,255,0.05);
    --hov-s: rgba(255,255,255,0.03);
    --hov-i: rgba(255,255,255,0.06);
    --sb: rgba(255,255,255,0.1);
    --sb-h: rgba(255,255,255,0.18);
    --sh: rgba(0,0,0,0.7);
    --fab: rgba(148,129,255,0.32);
    /* Emboss — softer shadows */
    --emboss: 0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.04);
    --emboss-sm: 0 1px 4px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.03);
    --inset: inset 1px 1px 3px rgba(0,0,0,0.3), inset -1px -1px 2px rgba(255,255,255,0.02);
}
```

---

## STEP 3: Replace Font Family Variables

```css
:root {
    --font-heading: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --font-body: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

---

## STEP 4: Typography Scale — ALL BIGGER

Apply these font size increases throughout:

| Element | Old Size | New Size | Weight |
|---------|----------|----------|--------|
| Portfolio value | 32-36px | 40px | 800 |
| Section headings | 12-14px | 18-20px | 600 |
| Card headings | 12px | 15-16px | 700 |
| Stat numbers | 16-20px | 24-26px | 800 |
| Stat labels | 9-10px | 11px | 700 |
| Body text | 11-12px | 13-14px | 500 |
| Button text | 11-12px | 13-14px | 700 |
| Signal badges (BUY/STRONG BUY) | 10px | 13px | 800 |
| Tab labels | 12px | 13px | 600 |
| Table headers | 9px | 12px | 600 |
| Table cells | 11px | 13px | 600 |
| Pill badges | 9-10px | 11-12px | 700 |

---

## STEP 5: Card Border Style

**Replace card styles with bordered approach (from Net is Working reference):**

```css
.card {
    background: var(--card);
    border: 1.5px solid rgba(255,255,255,0.09);
    border-radius: 20px;
    transition: transform 0.25s ease, border-color 0.25s ease, background-color 0.25s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}
.card:hover {
    border-color: rgba(255,255,255,0.14);
    background: var(--card-h);
    transform: translateY(-1px);
}
```

Remove the heavy emboss shadows from cards. Use subtle borders instead.

---

## STEP 6: Tab Navigation — Pill Buttons with Borders

Replace the current tab pill container style. Each inactive tab should have a visible border (like Net is Working). Active tab gets lime fill.

```css
.nav-tab {
    padding: 8px 20px;
    border-radius: 100px;
    font-size: 13px;
    font-weight: 500;
    font-family: var(--font-body);
    color: var(--t3);
    background: transparent;
    border: 1.5px solid rgba(255,255,255,0.09);
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    white-space: nowrap;
}
.nav-tab:hover {
    border-color: rgba(255,255,255,0.14);
    color: var(--t2);
}
.nav-tab.active {
    background: var(--pri);
    color: #111018;
    border-color: transparent;
    font-weight: 700;
    box-shadow: 0 2px 10px rgba(218,255,123,0.16);
}
```

---

## STEP 7: Button Styles — Hover Effects on ALL Buttons

```css
.btn-primary {
    background: var(--pri);
    color: #111018;
    font-weight: 700;
    font-size: 14px;
    padding: 11px 24px;
    border-radius: 14px;
    border: 1.5px solid transparent;
    cursor: pointer;
    font-family: var(--font-body);
    box-shadow: 0 2px 10px rgba(218,255,123,0.16);
    transition: all 0.2s ease;
}
.btn-primary:hover {
    background: #d4f57a;
    box-shadow: 0 6px 20px rgba(218,255,123,0.22);
    transform: translateY(-1px);
}

.btn-ghost {
    background: rgba(255,255,255,0.04);
    color: var(--t1);
    font-weight: 600;
    font-size: 13px;
    padding: 9px 18px;
    border-radius: 14px;
    border: 1.5px solid rgba(255,255,255,0.09);
    cursor: pointer;
    font-family: var(--font-body);
    transition: all 0.2s ease;
}
.btn-ghost:hover {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.14);
}

/* Emergency Stop — stroke icon, NOT emoji */
.btn-danger {
    background: transparent;
    color: var(--err);
    font-weight: 700;
    font-size: 14px;
    padding: 12px 24px;
    border-radius: 14px;
    border: 1.5px solid rgba(248,113,113,0.3);
    cursor: pointer;
    font-family: var(--font-body);
    transition: all 0.2s ease;
}
.btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.5);
}
```

---

## STEP 8: Fear & Greed Gauge — Modern Donut Arc

Replace the canvas-based gauge with an SVG donut arc meter.
The Fear & Greed section in the HTML should use an SVG-based approach:

```javascript
function renderFearGreedGauge(value) {
    const r = 72, cx = 90, cy = 90, sw = 10;
    const circumference = Math.PI * r;
    const pct = value / 100;
    const offset = circumference * (1 - pct);
    const c = value <= 20 ? '#f87171' : value <= 40 ? '#fb923c' : value <= 55 ? '#fbbf24' : value <= 75 ? '#5eead4' : '#daff7b';
    const label = value <= 20 ? 'Extreme Fear' : value <= 40 ? 'Fear' : value <= 55 ? 'Neutral' : value <= 75 ? 'Greed' : 'Extreme Greed';

    return `
    <svg width="180" height="110" viewBox="0 0 180 110">
        <path d="M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${sw}" stroke-linecap="round"/>
        <path d="M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" style="transition:all 1s ease"/>
        <path d="M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}" fill="none" stroke="${c}" stroke-width="${sw+8}" stroke-linecap="round"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" opacity="0.12"/>
        <text x="22" y="102" fill="var(--t4)" font-size="9" font-weight="600">0</text>
        <text x="80" y="14" fill="var(--t4)" font-size="9" font-weight="600" text-anchor="middle">50</text>
        <text x="152" y="102" fill="var(--t4)" font-size="9" font-weight="600">100</text>
    </svg>
    <div style="text-align:center;margin-top:-6px">
        <div style="font-size:38px;font-weight:800;color:${c};font-family:var(--font-heading)">${value}</div>
        <div style="font-size:12px;font-weight:700;color:${c};letter-spacing:0.06em">${label}</div>
    </div>`;
}
```

---

## STEP 9: Strategy Cards — Colored with Active/Inactive Badges

Each strategy card should have:
- A unique color (matching the current live dashboard colors)
- A 3px colored top bar
- Colored left border on hover
- Large ACTIVE/INACTIVE badge
- Toggle switch
- Description text
- Win rate, P&L, trades stats

Strategy colors:
```javascript
const STRAT_COLORS = {
    'scanner_signal': '#ff6b6b',      // Red
    'rsi_reversal': '#b088f9',         // Purple
    'bollinger_bounce': '#5bb5f0',     // Blue
    'dip_buyer': '#f0a35b',            // Orange
    'early_gainer': '#5bf0c8',         // Teal
    'dca_accumulator': '#8e8ea0',      // Gray
    'divergence_play': '#f05bb5',      // Pink
    'smart_money': '#6bffa8',          // Green
    'panic_reversal': '#ff6b6b',       // Red
};
```

---

## STEP 10: Signal Cards — BUY/STRONG BUY Bold

- STRONG BUY: solid green background (#5eead4), dark text, 13px font-weight 800
- BUY: lime border pill, 13px font-weight 800
- WATCH: gray bordered pill
- All signal cards should show coin badge (colored 2-letter abbreviation)

---

## STEP 11: Heatmap — More Space in Signal Column

- Add `min-width: 120px` to the Signal column
- Increase cell padding from current to `padding: 7px 10px`
- Increase font sizes in table to 13px for values, 12px for headers
- Add coin badges next to coin names in the first column
- RSI values: use border-radius: 8px on colored cells

---

## STEP 12: Market Status Card — No Fill Color

The Market Status card should NOT have a purple background fill.
Use a regular dark card with purple-colored "Neutral" text instead.

---

## STEP 13: Portfolio Card — Bigger Numbers, Arrow Aligned

- Portfolio value number: 40px, font-weight 800
- Arrow action button: position absolute, top: 16px, right: 16px
- Lime background card with dark text
- Change percentage: 15px

---

## STEP 14: Section Headings — Bigger, Medium Weight

All section labels like "TRADING STRATEGIES", "TOP SIGNALS", etc:
- Font size: 20px
- Font weight: 600 (medium, not heavy)
- Font family: var(--font-heading) (Outfit)
- Color: var(--t1)
- Letter spacing: -0.01em

---

## STEP 15: Emergency Stop — Stroke Icon

Replace any emoji (⛔) with an SVG stroke octagon:
```html
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
</svg>
```

---

## STEP 16: Brain Logo — SVG Neural Network

Replace the current bot icon in the header with this SVG brain:
```html
<svg width="34" height="34" viewBox="0 0 80 80">
    <defs><filter id="gl"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <g filter="url(#gl)" stroke="#daff7b" stroke-width="1.8" fill="none" stroke-opacity="0.85">
        <ellipse cx="40" cy="36" rx="27" ry="23"/>
        <path d="M40 59Q42 69 38 71"/>
        <circle cx="25" cy="28" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="35" cy="22" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="48" cy="24" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="55" cy="32" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="30" cy="38" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="42" cy="36" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="52" cy="42" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="35" cy="48" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="48" cy="48" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <circle cx="40" cy="30" r="2.2" fill="#daff7b" fill-opacity="0.7"/>
        <line x1="25" y1="28" x2="35" y2="22" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="35" y1="22" x2="48" y2="24" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="48" y1="24" x2="55" y2="32" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="30" y1="38" x2="42" y2="36" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="42" y1="36" x2="52" y2="42" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="35" y1="48" x2="48" y2="48" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="25" y1="28" x2="30" y2="38" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="55" y1="32" x2="52" y2="42" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="40" y1="30" x2="42" y2="36" stroke-width="0.8" stroke-opacity="0.35"/>
        <line x1="30" y1="38" x2="35" y2="48" stroke-width="0.8" stroke-opacity="0.35"/>
    </g>
</svg>
```

---

## STEP 17: Sparkline Blinking Dot

All sparklines/equity curves should have a blinking dot at the last data point:
```html
<circle cx="[last_x]" cy="[last_y]" r="3" fill="[color]">
    <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite"/>
</circle>
```

---

## STEP 18: Mobile Responsive Improvements

```css
@media (max-width: 600px) {
    .nav-pill-container {
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
    }
    .nav-pill-container::-webkit-scrollbar { display: none; }
    .nav-tab { flex-shrink: 0; }
}
```

---

## REFERENCE FILES

The React prototype is at: `brain-v4-1.jsx`
Use it as the visual reference for all design decisions.
The prototype shows the exact colors, spacing, typography, and component styles.

---

## WHAT NOT TO CHANGE

1. ALL JavaScript functions — loadPortfolio, loadHeatmap, loadRSIHeatmap, loadSmartScanner, etc.
2. API endpoints — /api/smart-scanner, /api/heatmap, /api/rsi-heatmap, /api/chat
3. WebSocket connections
4. localStorage handling
5. Telegram alert functions
6. TradingView widget initialization
7. Modal functionality (settings, calculator, chat, signal generator)
8. Account switching
9. Price alerts
10. Portfolio coin tracking

---

## IMPLEMENTATION ORDER

1. Replace fonts (Step 1-3)
2. Replace CSS variables (Step 2)
3. Update card styles (Step 5)
4. Update tab navigation (Step 6)
5. Update button styles (Step 7)
6. Update typography sizes (Step 4)
7. Replace Fear & Greed gauge (Step 8)
8. Update strategy cards (Step 9)
9. Update signal cards (Step 10)
10. Update heatmap (Step 11)
11. Fix market status card (Step 12)
12. Fix portfolio card (Step 13)
13. Update headings (Step 14)
14. Replace emergency stop icon (Step 15)
15. Replace header logo (Step 16)
16. Add sparkline dots (Step 17)
17. Mobile fixes (Step 18)

Show each change and ask for confirmation before applying.
Do NOT change any JavaScript logic.
