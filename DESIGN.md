# E-Kalavya — Complete UI/UX Design System & Component Specification

> **Version:** 2.0 — Multi-Agent Suite  
> **Design Philosophy:** Premium dark glassmorphism • AI-native dashboard aesthetic • 2025 design language  
> **Target:** Web-first desktop dashboard (min-width: 1280px)

---

## 1. Design Vision & Principles

### 1.1 Brand Identity

| Attribute | Value |
|-----------|-------|
| **Brand Name** | E-Kalavya |
| **Tagline** | *Autonomous Multi-Agent Admissions & Academic Management System* |
| **Persona** | Intelligent, trustworthy, cutting-edge — "The AI that runs your education centre" |
| **Aesthetic** | Deep space glassmorphism — NASA mission control crossed with premium SaaS |

### 1.2 Core Design Principles

1. **AI-First Hierarchy** — AI agent status and live activity are always visible. The system should feel *alive*.
2. **Depth through Layers** — Multiple depth layers (background → surface → card → glass → floating) with blur/border-opacity.
3. **Signal, Not Noise** — Color is reserved for *status* only. Never decorate without purpose.
4. **Micro-Interactions as Feedback** — Every hover, click, and state change provides immediate feedback.
5. **Data Density with Legibility** — Maximum information without sacrificing readability.

---

## 2. Design Tokens

### 2.1 Color Palette

```css
:root {
  /* Backgrounds */
  --bg-main:       #080b12;
  --bg-surface:    #0f1523;
  --bg-card:       rgba(18, 26, 43, 0.75);
  --bg-card-hover: rgba(26, 37, 61, 0.85);
  --bg-glass:      rgba(15, 22, 38, 0.60);
  --bg-modal:      rgba(8, 11, 18, 0.92);
  --bg-input:      rgba(255, 255, 255, 0.04);

  /* Borders */
  --border-subtle:  rgba(255, 255, 255, 0.08);
  --border-medium:  rgba(255, 255, 255, 0.12);
  --border-focus:   rgba(99, 102, 241, 0.40);
  --border-active:  rgba(99, 102, 241, 0.60);
  --border-success: rgba(16, 185, 129, 0.30);
  --border-warning: rgba(245, 158, 11, 0.30);
  --border-danger:  rgba(239, 68, 68, 0.30);

  /* Accent Colors */
  --primary:        #6366f1;   /* Indigo — Primary actions, active nav */
  --primary-glow:   rgba(99, 102, 241, 0.25);
  --primary-light:  #818cf8;
  --primary-dim:    rgba(99, 102, 241, 0.15);
  --secondary:      #06b6d4;   /* Cyan — Dev console */
  --secondary-glow: rgba(6, 182, 212, 0.25);
  --success:        #10b981;   /* Emerald — Student health, enrolled */
  --success-glow:   rgba(16, 185, 129, 0.25);
  --success-dim:    rgba(16, 185, 129, 0.12);
  --warning:        #f59e0b;   /* Amber — At-risk, follow-up */
  --warning-glow:   rgba(245, 158, 11, 0.25);
  --warning-dim:    rgba(245, 158, 11, 0.12);
  --danger:         #ef4444;   /* Red — Critical alerts */
  --danger-glow:    rgba(239, 68, 68, 0.25);
  --danger-dim:     rgba(239, 68, 68, 0.12);
  --purple:         #a855f7;   /* Purple — AI activity, oversight */
  --purple-glow:    rgba(168, 85, 247, 0.25);
  --purple-dim:     rgba(168, 85, 247, 0.12);
  --violet:         #8b5cf6;   /* Violet — Teacher portal */

  /* Text */
  --text-main:   #f8fafc;
  --text-sub:    #e2e8f0;
  --text-muted:  #94a3b8;
  --text-dim:    #64748b;
  --text-accent: #a5b4fc;

  /* AI Special */
  --ai-pulse: #22d3ee;
  --gold:     #f59e0b;
}
```

### 2.2 Background Gradients

```css
/* Page Body */
body {
  background-color: var(--bg-main);
  background-image:
    radial-gradient(circle at 15% 15%, rgba(99,102,241,0.08) 0%, transparent 40%),
    radial-gradient(circle at 85% 85%, rgba(6,182,212,0.06) 0%, transparent 40%),
    radial-gradient(circle at 50% 50%, rgba(168,85,247,0.04) 0%, transparent 60%);
  background-attachment: fixed;
}

/* Card gradients */
.grad-primary { background: linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #06b6d4 100%); }
.grad-success { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
.grad-warning { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }
.grad-danger  { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
.grad-purple  { background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); }
.grad-cyan    { background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); }
```

### 2.3 Typography

```css
:root {
  --font-heading: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-body:    'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

**Google Fonts:**
```
Outfit: wght@400;500;600;700;800
Plus Jakarta Sans: wght@400;500;600;700
JetBrains Mono: wght@400;500
```

**Type Scale:**

| Name | Size | Weight | Usage |
|------|------|--------|-------|
| 2xl | 28px | 700 | Page headings |
| xl | 22px | 700 | Section headings |
| lg | 18px | 600 | Card titles |
| md | 15px | 600 | Sub-headings |
| base | 13px | 400/500 | Body text |
| sm | 12px | 500 | Secondary labels |
| xs | 11px | 500 | Captions, timestamps |
| 2xs | 10px | 700 | Badges, pills |

### 2.4 Spacing & Radius

```css
/* Spacing: 4 | 8 | 12 | 16 | 20 | 24 | 32 | 40 | 48px */

--radius-xs:   4px;   /* Tags, badges */
--radius-sm:   6px;   /* Inputs, small buttons */
--radius-md:   10px;  /* Cards, dropdowns */
--radius-lg:   16px;  /* Panels, modals */
--radius-xl:   24px;  /* Hero cards */
--radius-full: 9999px; /* Pills, toggles */
```

### 2.5 Shadows & Glows

```css
--shadow-card:         0 4px 20px -2px rgba(0,0,0,0.5), 0 0 1px 1px rgba(255,255,255,0.05);
--shadow-modal:        0 25px 60px -10px rgba(0,0,0,0.8), 0 0 2px rgba(255,255,255,0.06);
--shadow-glow-primary: 0 0 25px -5px rgba(99,102,241,0.4);
--shadow-glow-success: 0 0 20px -5px rgba(16,185,129,0.4);
--shadow-glow-cyan:    0 0 20px -5px rgba(6,182,212,0.4);
--shadow-glow-purple:  0 0 20px -5px rgba(168,85,247,0.4);
```

---

## 3. Animation System

### 3.1 Keyframes

```css
@keyframes slideInUp    { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
@keyframes slideInRight { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:translateX(0); } }
@keyframes fadeIn       { from { opacity:0; } to { opacity:1; } }
@keyframes scaleIn      { from { opacity:0; transform:scale(0.95); } to { opacity:1; transform:scale(1); } }
@keyframes pulseGlow    { 0%,100% { opacity:0.8; transform:scale(1); } 50% { opacity:1; transform:scale(1.08); } }
@keyframes spinSlow     { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
@keyframes shimmer      { 0% { background-position:-200% 0; } 100% { background-position:200% 0; } }
@keyframes blink        { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
```

### 3.2 Transition Standards

| Use Case | Duration | Easing |
|----------|----------|--------|
| Hover state | 150ms | ease |
| Button press | 100ms | ease-in |
| Panel open/close | 250ms | cubic-bezier(0.16,1,0.3,1) |
| Modal entrance | 300ms | cubic-bezier(0.16,1,0.3,1) |
| Page view switch | 200ms | ease-out |

### 3.3 Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 4. Base Component Library

### 4.1 Glass Panel

```css
.glass-panel {
  background: var(--bg-card);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.glass-panel:hover {
  border-color: var(--border-medium);
  box-shadow: var(--shadow-card), 0 0 20px rgba(99,102,241,0.05);
}
```

### 4.2 Buttons

```css
/* Primary */
.btn-primary {
  display:inline-flex; align-items:center; gap:6px;
  padding:8px 16px; border-radius:var(--radius-md);
  background:var(--primary); color:#fff;
  font-size:13px; font-weight:600; border:none; cursor:pointer;
  box-shadow:0 0 20px rgba(99,102,241,0.35);
  transition:all 150ms ease;
}
.btn-primary:hover { background:var(--primary-light); box-shadow:0 0 30px rgba(99,102,241,0.5); transform:translateY(-1px); }

/* Ghost */
.btn-ghost {
  display:inline-flex; align-items:center; gap:6px;
  padding:7px 14px; border-radius:var(--radius-md);
  background:rgba(255,255,255,0.05); border:1px solid var(--border-subtle);
  color:var(--text-muted); font-size:12px; font-weight:500; cursor:pointer;
  transition:all 150ms ease;
}
.btn-ghost:hover { background:rgba(255,255,255,0.08); border-color:var(--border-medium); color:var(--text-sub); }

/* Danger */
.btn-danger { background:var(--danger-dim); border:1px solid var(--border-danger); color:#fca5a5; }

/* Icon (square) */
.btn-icon {
  width:32px; height:32px; border-radius:var(--radius-sm);
  display:flex; align-items:center; justify-content:center;
  background:rgba(255,255,255,0.05); border:1px solid var(--border-subtle);
  color:var(--text-muted); cursor:pointer; transition:all 150ms ease;
}
```

### 4.3 Inputs & Forms

```css
.input {
  width:100%; padding:9px 12px;
  background:var(--bg-input); border:1px solid var(--border-subtle);
  border-radius:var(--radius-sm); color:var(--text-main);
  font-size:13px; font-family:var(--font-body); outline:none;
  transition:border-color 150ms ease, box-shadow 150ms ease;
}
.input::placeholder { color:var(--text-dim); }
.input:focus { border-color:var(--border-focus); box-shadow:0 0 0 3px rgba(99,102,241,0.1); }
```

Variants: `.input--sm`, `.input--mono`, `.input--error`

### 4.4 Badges & Pills

```css
.badge {
  display:inline-flex; align-items:center; gap:4px;
  padding:2px 8px; border-radius:var(--radius-full);
  font-size:10px; font-weight:700;
  text-transform:uppercase; letter-spacing:0.05em;
}
.badge--primary { background:var(--primary-dim); color:var(--primary-light); border:1px solid rgba(99,102,241,0.25); }
.badge--success { background:var(--success-dim); color:#6ee7b7;             border:1px solid rgba(16,185,129,0.25); }
.badge--warning { background:var(--warning-dim); color:#fcd34d;             border:1px solid rgba(245,158,11,0.25); }
.badge--danger  { background:var(--danger-dim);  color:#fca5a5;             border:1px solid rgba(239,68,68,0.25); }
.badge--purple  { background:var(--purple-dim);  color:#d8b4fe;             border:1px solid rgba(168,85,247,0.25); }
.badge--cyan    { background:rgba(6,182,212,0.12); color:#67e8f9;           border:1px solid rgba(6,182,212,0.25); }
.badge--neutral { background:rgba(255,255,255,0.07); color:var(--text-muted); border:1px solid var(--border-subtle); }
```

### 4.5 Status Dot

```css
.status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; }
.status-dot--online  { background:var(--success); box-shadow:0 0 8px var(--success); animation:pulseGlow 2s infinite; }
.status-dot--warning { background:var(--warning); box-shadow:0 0 8px var(--warning); animation:pulseGlow 2s infinite; }
.status-dot--offline { background:var(--text-dim); }
.status-dot--ai      { background:var(--primary);  box-shadow:0 0 10px var(--primary); animation:pulseGlow 1.5s infinite; }
```

### 4.6 Progress Bar

```css
.progress-track { width:100%; height:6px; background:rgba(255,255,255,0.06); border-radius:var(--radius-full); overflow:hidden; }
.progress-fill  { height:100%; border-radius:var(--radius-full); transition:width 600ms cubic-bezier(0.16,1,0.3,1); }
```

### 4.7 KPI / Stat Card

```css
.stat-card {
  /* Extends .glass-panel */
  padding:20px; display:flex; flex-direction:column; gap:8px;
  position:relative; overflow:hidden;
}
.stat-card__label { font-size:11px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.06em; }
.stat-card__value { font-size:32px; font-weight:800; font-family:var(--font-heading); letter-spacing:-0.03em; }
.stat-card__delta.up   { color:var(--success); }
.stat-card__delta.down { color:var(--danger); }
/* Corner glow via ::after pseudo-element */
```

### 4.8 Tabs

```css
.tab-container {
  display:flex; background:rgba(15,23,42,0.8);
  border:1px solid var(--border-subtle); border-radius:var(--radius-md);
  padding:3px; gap:2px;
}
.tab-item {
  display:flex; align-items:center; gap:6px; padding:7px 14px;
  border-radius:var(--radius-sm); border:none; font-size:12px; font-weight:600;
  cursor:pointer; transition:all 150ms ease; color:var(--text-muted); background:transparent;
}
.tab-item.active { background:var(--primary); color:#fff; box-shadow:0 0 15px var(--primary-glow); }
```

### 4.9 Modal

```css
.modal-backdrop {
  position:fixed; inset:0; background:rgba(0,0,0,0.7);
  backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center;
  z-index:50; animation:fadeIn 0.2s ease-out;
}
.modal-box {
  background:var(--bg-surface); border:1px solid var(--border-subtle);
  border-radius:var(--radius-xl); box-shadow:var(--shadow-modal);
  max-width:560px; width:100%; max-height:90vh; overflow-y:auto;
  animation:scaleIn 0.25s cubic-bezier(0.16,1,0.3,1);
}
```

### 4.10 Toast Notification

```css
.toast {
  position:fixed; top:20px; right:20px;
  background:rgba(99,102,241,0.95); color:#fff;
  padding:10px 18px; border-radius:var(--radius-md);
  font-size:13px; font-weight:600;
  box-shadow:0 10px 25px rgba(0,0,0,0.5);
  z-index:9999; animation:slideInUp 0.2s ease-out;
}
/* Variants: .toast--success .toast--warning .toast--danger */
```

### 4.11 Skeleton Loader

```css
.skeleton {
  background:linear-gradient(90deg,
    rgba(255,255,255,0.04) 25%,
    rgba(255,255,255,0.08) 50%,
    rgba(255,255,255,0.04) 75%);
  background-size:200% 100%;
  animation:shimmer 1.5s infinite;
  border-radius:var(--radius-sm);
}
```

---

## 5. Global Layout

### 5.1 App Shell

```
┌──────────────────────────────────────────────────────────────┐
│  HEADER (sticky, 64px)                                        │
│  [Brand Logo]  [Nav Tabs × 5]  [AI Status | Action Buttons]  │
├──────────────────────────────────────────────────────────────┤
│  STATS BAR (conditional, ~48px)                               │
│  [KPI-1]  [KPI-2]  [KPI-3]  [KPI-4]  [KPI-5]               │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  MAIN CONTENT AREA  (flex:1, overflow-y:scroll)              │
│  Renders one of 5 views based on currentView state           │
│                                                               │
└──────────────────────────────────────────────────────────────┘
      ▲ ACTIVITY DRAWER slides in from right (fixed, z:30)
```

### 5.2 Grid Definitions

```css
.grid-kpi     { display:grid; grid-template-columns:repeat(5,1fr); gap:16px; }
.grid-2       { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
.grid-3       { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; }
.grid-sidebar { display:grid; grid-template-columns:280px 1fr; gap:20px; }
.grid-kanban  { display:grid; grid-template-columns:repeat(7,minmax(220px,1fr)); gap:14px; overflow-x:auto; }
```

---

## 6. Header Component

### Navigation Tabs

| Tab | Icon | Active BG | Glow |
|-----|------|-----------|------|
| Admissions Pipeline | `Layers` | `#6366f1` | indigo |
| Student Health Map | `GraduationCap` | `#10b981` | green |
| Teacher Portal | `ClipboardList` | `#a855f7` | purple |
| Founder Oversight | `ShieldCheck` | `#8b5cf6` | violet |
| Dev Console | `Terminal` | `#06b6d4` | cyan |

### Right Controls

1. **AI Online Pill** — pulsing green dot + Bot icon + count badge
2. **Follow-Up Button** — ghost, `leads` view only
3. **Reminders Button** — ghost, `leads` view only
4. **WhatsApp Button** — gradient green, always visible
5. **Logs Button** — toggleable with activity count badge

---

## 7. View: Admissions Pipeline (CRM Kanban)

### 7.1 Kanban Board

7 columns, horizontally scrollable:

| Column | Left Border Color |
|--------|-------------------|
| New | `#6366f1` (indigo) |
| Contacted | `#06b6d4` (cyan) |
| Interested | `#84cc16` (lime) |
| Demo Booked | `#f59e0b` (amber) |
| Follow-up | `#f97316` (orange) |
| Admission | `#10b981` (green) |
| Lost | `rgba(239,68,68,0.5)` (dim red) |

### 7.2 Lead Card Anatomy

```
┌──────────────────────────────────────────────┐  ← Left border: stage color
│  Aryan Kumar                    [AI: 92] ──  │  ← Name + AI score badge
│  +91 98765 43210  [Meta Ads]                 │  ← Phone + source badge
│  Class 10 • CBSE • Maths, Science            │  ← Academic info
│  "Wants weekend batch near home"             │  ← Parent note (italic)
│  Last: 2h ago  [🟢 Shahasna Replied]         │  ← Recency + AI reply status
│  ──────────────────────────────────────────  │
│  [View]  [Message]  [Move Stage ▸]           │  ← Action bar
└──────────────────────────────────────────────┘
```

**AI Score Colors:**
- 90-100 → `--success` (green)
- 70-89 → `--warning` (amber)
- 50-69 → orange
- < 50 → `--danger` (red)

### 7.3 Lead Detail Modal

**Sections:**
1. Header: name, phone, stage badge, close button
2. **AI Insight Panel** — purple tint: score, recommendation, urgency level
3. Contact Info: phone, email, source, parent name
4. Academic Info: class, board, subjects, goals
5. **Shahasna Chat Preview**: last 3 WhatsApp messages
6. Timeline: scrollable activity log
7. Footer Actions: [Update Stage] [Send Message] [Book Demo] [Mark Lost]

---

## 8. View: Student Health Map

### 8.1 Health Filter Bar

```
[All Students]  [🟢 Healthy]  [🟡 At-Risk]  [🔴 Critical]  |  [Batch ▾]  [+ Enroll]  [🔍 Scan]
```

### 8.2 Student Health Card

**Visual States:**

| Health | Left Border | BG Tint | Glow |
|--------|-------------|---------|------|
| Healthy (≥80%) | `#10b981` | `rgba(16,185,129,0.05)` | green |
| At-Risk (60-79%) | `#f59e0b` | `rgba(245,158,11,0.05)` | amber |
| Critical (<60%) | `#ef4444` | `rgba(239,68,68,0.05)` | red pulse |

**Card Content:**
- Header: name + health score ring gauge + batch badge
- Subject progress bars (Maths / Science / English / etc.)
- Attendance % with color badge
- Last assessment: score + teacher + date
- AI flags: "3 missed sessions", "Declining in Maths"
- Actions: [View Profile] [Message Parent] [Flag Review]

### 8.3 Score Ring Gauge (SVG)

- Outer ring: `rgba(255,255,255,0.06)`, stroke-width: 4
- Progress stroke: health-level color, animated `stroke-dashoffset`
- Center: percentage value in bold

---

## 9. View: Teacher Portal

### 9.1 Layout

```
LEFT (280px): Batch Sidebar          RIGHT: Assessment Feed
──────────────────────               ────────────────────────────
[Batch Card] × N                     [Assessment Card] × N
Click → filter right panel           Filtered by selected batch
```

### 9.2 Batch Card

```
┌────────────────────────────────┐  ← Purple left border
│  📚  Class 10-A (CBSE)         │
│  Teacher: Mrs. Priya Sharma    │
│  Students: 18                  │
│  ████████░░ 15/18 Present      │  ← attendance mini-bar
└────────────────────────────────┘
```

### 9.3 Assessment Card

```
┌────────────────────────────────────────────────────────────┐
│  Aryan Kumar  [Mathematics]  Score: 87/100  [Oct 12, 2026] │
│  "Strong in calculus, needs work on trigonometry"          │
│  🤖 AI: "Slight decline from last month's 91"  [🟡 Amber] │
│  [Edit]  [Delete]  [Send to Parent via WhatsApp]           │
└────────────────────────────────────────────────────────────┘
```

### 9.4 Assessment Modal (Form)

Step 1: Select student (searchable), subject, score / max score  
Step 2: Exam type tabs: `[Unit Test] [Mid-Term] [Final] [Assignment]`  
Step 3: Notes textarea + date picker → [Save & Analyze]

---

## 10. View: Founder Oversight (Analytics)

### 10.1 Layout

```
ROW 1: Revenue KPI Cards (5)
  Total Revenue | MRR | Avg Fee/Student | Churn Rate | LTV

ROW 2: 2-col
  [Conversion Funnel Chart]  |  [Agent Health Grid]

ROW 3: 2-col
  [Lead Source Donut]        |  [Batch Performance Table]

ROW 4: 2-col
  [Shahasna Conversation Stats]  |  [AI Token Cost Monitor]
```

### 10.2 Conversion Funnel

Horizontal bars, proportional to count, left-to-right gradient:
- Stage label + count + drop-off % between stages
- Animated bar fill on mount

### 10.3 Agent Status Grid

| Agent | Key Metrics |
|-------|-------------|
| AdmissionsAI (Shahasna) | Messages sent, reply rate, avg response time |
| DemoCoordinatorAI | Reminders sent, demos booked, no-shows |
| AcademicMonitoringAI | Students scanned, flags raised, at-risk count |
| HermesAI (Orchestrator) | Tasks routed, errors, uptime |

Each card: status dot, last run timestamp, success/error count, [Trigger] button.

### 10.4 Lead Source Chart

Donut chart + legend:
- Sources: Meta Ads, WhatsApp Organic, BotBiz, Direct Call, Referral
- Center: total leads count
- Hover: slice details

### 10.5 Batch Performance Table

| Batch | Teacher | Students | Avg Score | Attendance | Health |
|-------|---------|----------|-----------|------------|--------|
| Class 10 A | Mrs. S. | 18 | 82.4% | 91% | 🟢 |

Sortable columns, row click → drill down modal.

### 10.6 Token Cost Monitor

Stacked bar chart per day per agent + cost estimate:
```
Today: ~₹0.00 (Ollama local — FREE)
If OpenAI: ~₹2.14 @ current volume
Monthly savings: ~₹64.20
```

---

## 11. View: Developer Console

### 11.1 Sub-Tabs

```
[⚙️ Configuration]  [🤖 Ollama & LLM]  [💬 WhatsApp / Shahasna]
[🔌 Integrations]   [📊 API Monitor]    [📝 System Logs]
```

Each tab uses cyan (`#06b6d4`) as accent color.

---

## 12. Dev Tab: Configuration

### Environment Variables Table

```
KEY                    VALUE             ACTIONS
──────────────────────────────────────────────────
OPENAI_API_KEY         sk-****...xZ7    [Edit] [Delete]
WHATSAPP_TOKEN         EAAx...          [Edit] [Delete]
POSTGRES_URL           postgres://...   [Edit] [Delete]
```

[+ Add Variable]  [Save All]  [Validate Config]

### Agent Configuration

Per agent card:
- ON/OFF toggle
- Model override selector (Ollama model list)
- Temperature slider (0.0 – 2.0)
- Max tokens input
- System prompt preview (expandable)

### Shahasna Persona Settings

```
Name:         [Shahasna              ]
Age:          [21                   ]
Personality:  [textarea: system prompt]
Typing Speed: [──●────] 0.05s/char
Chunking:     [ON ●] Split long replies
Memory:       [5] past messages
Language:     [Tamil ✓] [English ✓] [Hindi ✓]
[Save Persona]  [Preview Chat]  [Reset Memory]
```

---

## 13. Dev Tab: Ollama & LLM Monitor

### 13.1 Daemon Status Banner

```
┌─────────────────────────────────────────────────────────────────────┐
│  ● Ollama Online  │  localhost:11434  │  Models: 4  │  [Test Ping] │
│  Provider: [Ollama ●──── OpenAI ──── Rule-based]  [Switch]         │
└─────────────────────────────────────────────────────────────────────┘
```

### 13.2 Model Cards Grid (3 columns)

```
┌───────────────────────────────────────────┐
│  🤖  qwen3.8:27b                [★ Default]│
│  ─────────────────────────────────────    │
│  Params: 27B  │  Context: 32768 tokens    │
│  Quant: Q4_K_M  │  Size on disk: 16.4 GB │
│  ─────────────────────────────────────    │
│  Capabilities:                            │
│  [chat] [tools] [thinking]                │  ← colored badges
│  ─────────────────────────────────────    │
│  Avg Latency: 320ms                       │
│  Last Used: 2m ago · by AdmissionsAI      │
│  ─────────────────────────────────────    │
│  [▶ Test Inference]  [Assign to Agent ▾]  │
└───────────────────────────────────────────┘
```

Available models: `qwen3.8:27b`, `gemma4:26b`, `gpt-oss:20b`, `nimble:9b`

### 13.3 Test Playground

```
Scenario: [Lead Followup] [Academic Alert] [Parent Message] [Custom]

Prompt:
┌──────────────────────────────────────────────────────────────────┐
│  A parent asks: "What is the fee for Class 10 batch?"            │
└──────────────────────────────────────────────────────────────────┘

[▶ Run Test]  [Clear]

Response: (streamed, token by token)
┌──────────────────────────────────────────────────────────────────┐
│  Namaskar! Class 10 CBSE batch fees are...                      │
│  ...                                                             │
│  Tokens: 287  │  Latency: 312ms  │  Model: qwen3.8:27b         │
└──────────────────────────────────────────────────────────────────┘
```

### 13.4 Token Monitor

**4 Hero KPI Cards:**
- 📊 Total Tokens Today
- ⬆️ Prompt Tokens
- ⬇️ Completion Tokens
- ⏱ Avg Latency (ms)

**Per-Agent Usage Bars:**
```
AdmissionsAI   ████████████░░  62,450 tok  [Ollama qwen3.8:27b]
DemoCoord.     ████░░░░░░░░░░  18,200 tok  [Ollama nimble:9b]
AcademicMon.   ██████░░░░░░░░  29,100 tok  [Ollama gemma4:26b]
HermesAI       ██░░░░░░░░░░░░   8,750 tok  [Ollama gpt-oss:20b]
```

### 13.5 API Event Stream Table

```
TIME      │ AGENT          │ METHOD │ ENDPOINT    │ TOKENS │ LATENCY │ STATUS
09:42:17  │ HermesAI       │ POST   │ /chat       │ 1,240  │ 312ms   │ ✅ 200
09:42:09  │ AdmissionsAI   │ POST   │ /generate   │ 890    │ 287ms   │ ✅ 200
09:41:55  │ AcademicMon.   │ POST   │ /chat       │ 2,100  │ 890ms   │ ⚠️ 429
```

Click row → expand request/response body JSON viewer.

---

## 14. Dev Tab: WhatsApp / Shahasna

### 14.1 WhatsApp API Config

```
Phone Number ID:   [_______________________]
Access Token:      [_______________________] [👁 Show]
Webhook URL:       https://yourserver/api/v1/webhook  [Copy]
Verify Token:      [_______________________]
[Save & Verify]  [Send Test Message]  [Test Webhook]
```

### 14.2 Shahasna Live Chat Preview

Side-by-side panel simulating WhatsApp:
- Dark background (`#111b21`)
- Received bubbles: left-aligned, dark grey
- Sent bubbles: right-aligned, WhatsApp green gradient
- Typing indicator: 3-dot animation

```css
.bubble-sent     { background: linear-gradient(135deg, #25D366, #128C7E); border-radius: 16px 4px 16px 16px; }
.bubble-received { background: rgba(255,255,255,0.08); border-radius: 4px 16px 16px 16px; }
.typing-dot      { animation: blink 1.4s infinite; }
.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }
```

### 14.3 Memory Settings

```
Vector DB:  [ChromaDB ●──── Qdrant ──── In-Memory]
DB URL:     [http://localhost:8000       ]
Context:    [─────●──────────] 5 messages
[Test Connection]  [Clear Memory]  [Export Conversations]
```

---

## 15. Dev Tab: Integrations

| Integration | Status | Config Fields |
|-------------|--------|---------------|
| Meta Ads | 🟢 Connected | App ID, Access Token, Pixel ID |
| BotBiz | 🟡 Partial | API Key, Webhook URL |
| Google Sheets | ⚪ Not Set | Service Account JSON |
| Razorpay | ⚪ Not Set | Key ID, Key Secret |
| Twilio | ⚪ Not Set | SID, Auth Token |

Each card: status badge + [Configure] [Test] [Disconnect] buttons.

---

## 16. Dev Tab: API Monitor

Full-width table with filter bar:

**Filters:** Agent selector | HTTP Method | Status Code | Time Range  
**Auto-refresh toggle** (every 5s)  
**Export CSV** button  
**Table:** Time | Method | Endpoint | Agent | Status | Duration | Token count

---

## 17. Dev Tab: System Logs

Terminal-style log viewer:

```css
.log-terminal {
  background: rgba(0,0,0,0.6);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 16px;
  height: 500px;
  overflow-y: auto;
}
.log-line--info    { color: #93c5fd; }  /* blue */
.log-line--warn    { color: #fcd34d; }  /* yellow */
.log-line--error   { color: #fca5a5; }  /* red */
.log-line--success { color: #6ee7b7; }  /* green */
.log-line--ai      { color: #c4b5fd; }  /* purple */
```

Filter pills: `[All] [INFO] [WARN] [ERROR] [AI Activity]`  
Search input (regex-capable)  
[Clear] [Download .log] buttons

---

## 18. Activity Stream Drawer

Right-side slide-in panel:

```css
.activity-drawer {
  position:fixed; top:64px; right:0;
  width:360px; height:calc(100vh - 64px);
  background:rgba(8,11,18,0.97);
  border-left:1px solid var(--border-subtle);
  backdrop-filter:blur(20px);
  transform:translateX(100%);
  transition:transform 250ms cubic-bezier(0.16,1,0.3,1);
  z-index:30;
}
.activity-drawer.open { transform:translateX(0); }
```

**Filter Pills:** `[All] [Admissions] [Academic] [WhatsApp] [System]`

**Log Item:**
```
[●] [Bot Icon]  AdmissionsAI         09:42 ✓
Sent follow-up to Aryan Kumar via WhatsApp
[✅ SUCCESS]  [View Details ▾]
```

Agent pulse colors: green / cyan / amber / purple / grey

---

## 19. Modals

### 19.1 Simulate WhatsApp Message

- Phone input (pre-filled)
- Message textarea
- Quick templates: `[Inquiry] [Fee Question] [Demo Request] [Complaint]`
- [Send to Shahasna] → shows AI response preview
- Response preview panel with typing indicator animation

### 19.2 Onboard Student Wizard (3 Steps)

**Step 1:** Select admitted lead (searchable)  
**Step 2:** Assign batch + start date + fee plan  
**Step 3:** Review + toggle "Send WhatsApp Welcome" → [Enroll]  

Progress: `● Lead ——— ○ Batch ——— ○ Confirm`

### 19.3 Add Lead

Fields: Name, Phone, Parent Name, Class, Board, Subjects (multi), Source, Notes  
[Save as New Lead]

---

## 20. Data Visualization

### 20.1 Sparkline

Inline SVG, 80×32px, no axes. Stroke: accent color. Gradient fill below.

### 20.2 Bar Chart

```css
.bar-chart { display:flex; gap:6px; align-items:flex-end; height:80px; }
.bar-chart__bar { flex:1; border-radius:4px 4px 0 0; background:var(--primary); transition:height 500ms cubic-bezier(0.16,1,0.3,1); }
.bar-chart__bar:hover { filter:brightness(1.2); }
```

### 20.3 Donut Chart

SVG with animated `stroke-dashoffset` on mount. Colored slices + legend below.

### 20.4 Funnel Chart

Horizontal bars, decreasing width, gradient fill, drop-off % annotations.

### 20.5 Score Ring Gauge

SVG circular progress. Outer = track, inner = progress arc. Center: score text.

### 20.6 Heatmap Grid

Students × Subjects grid. Cell color: green (high) → yellow → red (low).  
Hover tooltip: student name + score + trend arrow.

---

## 21. Icon System (Lucide React)

| Context | Icons Used |
|---------|-----------|
| Navigation | `Layers` `GraduationCap` `ClipboardList` `ShieldCheck` `Terminal` |
| AI / Agents | `Bot` `Sparkles` `Zap` `Brain` `Cpu` |
| CRM / Leads | `Users` `UserPlus` `Phone` `MessageSquare` `Send` |
| Academic | `BookOpen` `BarChart2` `TrendingUp` `TrendingDown` `Award` |
| Status | `CheckCircle` `AlertTriangle` `XCircle` `Clock` `Activity` |
| Actions | `Plus` `Edit2` `Trash2` `RefreshCw` `Download` `Copy` |
| Settings | `Settings` `Key` `Shield` `Lock` `Eye` `EyeOff` |

**Size Standards:** nav=14 · card header=16 · section header=18 · hero=24 · empty state=48

---

## 22. Complete Component Inventory

### Layout
`AppShell` · `Header` · `StatsBar` · `PageContainer` · `ActivityDrawer`

### Primitives
`GlassPanel` · `Button` (primary/ghost/danger/icon) · `Input` · `Textarea` · `Select` · `Checkbox` · `Toggle` · `Badge` · `Tag` · `Pill` · `StatusDot` · `ProgressBar` · `RingGauge` · `Divider` · `Tooltip` · `Toast` · `Modal` · `Drawer` · `Tabs` · `Accordion` · `Skeleton` · `EmptyState` · `SectionHeader` · `KpiCard`

### Data Viz
`SparklineChart` · `BarChart` · `DonutChart` · `FunnelChart` · `HeatmapGrid` · `ScoreRing` · `UsageBar`

### Admissions CRM
`KanbanBoard` · `KanbanColumn` · `LeadCard` · `LeadModal` · `AddLeadModal` · `SimulateModal`

### Student Health
`StudentHealthCard` · `HealthSummaryRow` · `OnboardWizard`

### Teacher Portal
`BatchCard` · `AssessmentCard` · `AssessmentModal`

### Founder Oversight
`AgentStatusCard` · `AgentStatusGrid` · `BatchPerformanceTable` · `SourceChart` · `FunnelView` · `TokenCostPanel`

### Developer Console
`DevConsoleTabs` · `EnvVarTable` · `AgentConfigCard` · `ShahasnaPersonaCard` · `ModelCard` · `ModelGrid` · `OllamaStatusBanner` · `TestPlayground` · `TokenMonitorHero` · `AgentUsageBar` · `ApiEventTable` · `LogTerminal` · `IntegrationCard` · `WhatsAppConfigPanel` · `ChatPreview` · `TypingIndicator` · `MemorySettings` · `ActivityLogItem`

---

## 23. View Color Map

| View | Accent | Tab BG when active |
|------|---------|--------------------|
| Admissions Pipeline | `#6366f1` indigo | indigo |
| Student Health Map | `#10b981` emerald | green |
| Teacher Portal | `#a855f7` purple | purple |
| Founder Oversight | `#8b5cf6` violet | violet |
| Dev Console | `#06b6d4` cyan | cyan |

---

## 24. Implementation Notes

### CSS Architecture
- CSS custom properties in `:root` of `index.css`
- Inline styles for dynamic/data-driven values (colors from data)
- Utility classes (`.glass-panel`, `.animate-*`) for static patterns
- No CSS Modules / CSS-in-JS — vanilla CSS for performance

### Performance
- `React.lazy()` + `Suspense` for heavy views
- `React.memo` / `useMemo` for expensive renders
- `will-change: transform` on frequently animated cards
- 300ms debounce on search inputs
- Virtualize lists >50 items

### Fonts (in `index.html`)
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

### Accessibility
- All interactive elements have `aria-label`
- Focus states: `outline: 2px solid var(--primary); outline-offset: 2px;`
- Color never the sole signal (always + icon or text)
- Modal traps focus, Tab cycles within, Escape closes
- `prefers-reduced-motion` respected

---

*End of E-Kalavya Design System & Component Specification v2.0*
