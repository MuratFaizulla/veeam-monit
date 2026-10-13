/**
 * How the Repository report looks: A4 landscape pages, Inter, one palette.
 * The colours are the variables at the top; the rest of the sheet only names them.
 */
export const STYLE = `
:root {
  --ink: #0b1220; --text: #334155; --muted: #64748b; --faint: #94a3b8; --line: #e2e8f0; --hair: #eef2f7;
  --panel: #f8fafc; --panel2: #f1f5f9;
  --brand: #4f46e5; --brand2: #6366f1; --brand-soft: #eef2ff; --win: #f3f0ff;
  --crit: #e11d48; --crit-bg: #fff1f2; --crit-ink: #9f1239; --crit-line: #fecdd3;
  --warn: #f59e0b; --warn-bg: #fffbeb; --warn-ink: #92400e; --warn-line: #fde68a;
  --ok: #10b981; --ok-bg: #ecfdf5; --ok-ink: #065f46; --ok-line: #a7f3d0;
  --unk: #94a3b8; --unk-bg: #f8fafc; --unk-ink: #475569; --unk-line: #e2e8f0;
  --used: #334155; --orph: #a78bfa;
}
@page { size: 297mm 210mm; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Inter Variable', 'Segoe UI', sans-serif; font-size: 8.5pt; line-height: 1.35; color: var(--text); background: #fff; font-feature-settings: 'tnum' 1, 'cv11' 1, 'ss03' 1; }
a { color: inherit; text-decoration: none; }
b { font-weight: 650; }
.dim { color: var(--faint); }

.page { width: 297mm; height: 210mm; padding: 9mm 12mm 9mm; position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 3.2mm; break-after: page; }
.page:last-child { break-after: auto; }
.grow { flex: 1; min-height: 0; }

/* Top bar */
.top { display: flex; justify-content: space-between; align-items: center; font-size: 7pt; color: var(--faint); padding-bottom: 2.6mm; border-bottom: 0.3mm solid var(--line); }
.top b { color: var(--ink); font-weight: 650; }
.top .crumb em { font-style: normal; margin: 0 1.6mm; color: #cbd5e1; }
.logo { display: inline-block; width: 2.6mm; height: 2.6mm; border-radius: 0.8mm; background: linear-gradient(135deg, var(--brand), #a78bfa); margin-right: 2mm; vertical-align: -0.35mm; }
.gl { width: 3.2mm; height: 3.2mm; vertical-align: -0.6mm; flex: none; }

/* Headings */
.sect { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; }
h2 { font-size: 15pt; font-weight: 750; color: var(--ink); letter-spacing: -0.015em; line-height: 1.15; }
.h2sub { font-size: 7.6pt; color: var(--muted); margin-top: 0.8mm; max-width: 200mm; }
h3 { font-size: 9.5pt; font-weight: 700; color: var(--ink); display: flex; align-items: center; gap: 1.8mm; }
h3 .gl { color: var(--brand); }
.sub { font-size: 7pt; color: var(--muted); margin-top: 0.6mm; }
.panel { background: #fff; border: 0.3mm solid var(--line); border-radius: 3.2mm; padding: 3.6mm 4.2mm; }
.empty { color: var(--faint); font-size: 8pt; padding: 4mm 0; }

/* Pills and chips */
.pill { display: inline-flex; align-items: center; gap: 1.2mm; padding: 0.6mm 2.2mm; border-radius: 99px; font-size: 6.6pt; font-weight: 650; letter-spacing: 0.02em; white-space: nowrap; }
.pill i { width: 1.5mm; height: 1.5mm; border-radius: 50%; background: currentColor; }
.pill.big { font-size: 9pt; padding: 1.5mm 3.6mm; gap: 1.6mm; }
.pill.big i { width: 2mm; height: 2mm; }
.pill.crit { background: var(--crit-bg); color: var(--crit-ink); box-shadow: inset 0 0 0 0.25mm var(--crit-line); }
.pill.crit i { background: var(--crit); }
.pill.warn { background: var(--warn-bg); color: var(--warn-ink); box-shadow: inset 0 0 0 0.25mm var(--warn-line); }
.pill.warn i { background: var(--warn); }
.pill.ok { background: var(--ok-bg); color: var(--ok-ink); box-shadow: inset 0 0 0 0.25mm var(--ok-line); }
.pill.ok i { background: var(--ok); }
.pill.unk { background: var(--panel2); color: var(--unk-ink); box-shadow: inset 0 0 0 0.25mm var(--line); }
.pill.unk i { background: var(--unk); }
.chip { display: inline-block; font-size: 6.6pt; font-weight: 650; padding: 0.35mm 1.7mm; border-radius: 99px; white-space: nowrap; }
.chip.ok { background: var(--ok-bg); color: var(--ok-ink); }
.chip.warn { background: var(--warn-bg); color: var(--warn-ink); box-shadow: inset 0 0 0 0.25mm var(--warn-line); }
.chip.crit { background: var(--crit-bg); color: var(--crit-ink); box-shadow: inset 0 0 0 0.25mm var(--crit-line); }
.chip.run { background: var(--brand-soft); color: var(--brand); }
b.crit { color: var(--crit); } b.warn { color: #b45309; } b.ok { color: var(--ok-ink); }

/* Status icons */
.ic { flex: none; width: 6.4mm; height: 6.4mm; border-radius: 50%; display: grid; place-items: center; color: #fff; background: var(--brand); }
.ic svg { width: 3.7mm; height: 3.7mm; }
.ic.crit { background: var(--crit); } .ic.warn { background: var(--warn); } .ic.ok { background: var(--ok); } .ic.unk { background: var(--unk); }

/* Cover */
.cover { gap: 4mm; }
.hero { position: relative; border-radius: 5mm; padding: 7mm 10mm 6.5mm; color: #fff; overflow: hidden;
  background: radial-gradient(140mm 90mm at 105% -10%, rgba(129, 140, 248, 0.55), transparent 60%), radial-gradient(110mm 70mm at -5% 120%, rgba(16, 185, 129, 0.22), transparent 60%), linear-gradient(120deg, #0b1220, #1e1b4b 60%, #312e81); }
.hero .eyebrow { display: flex; justify-content: space-between; font-size: 7pt; letter-spacing: 0.18em; color: #a5b4fc; font-weight: 600; }
.hero h1 { font-size: 27pt; font-weight: 780; letter-spacing: -0.025em; margin: 3.5mm 0 1.4mm; line-height: 1.05; }
.hero .lead { font-size: 9.5pt; color: #c7d2fe; }
.hk-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; margin-top: 5mm; }
.hk { background: rgba(255, 255, 255, 0.07); border: 0.3mm solid rgba(255, 255, 255, 0.15); border-radius: 3.5mm; padding: 3mm 4.4mm; }
.hk-l { font-size: 6.6pt; letter-spacing: 0.14em; text-transform: uppercase; color: #a5b4fc; font-weight: 650; }
.hk-v { font-size: 22pt; font-weight: 760; letter-spacing: -0.02em; margin-top: 0.8mm; line-height: 1.1; }
.hk-v small { font-size: 10.5pt; font-weight: 600; color: #c7d2fe; margin-left: 1.2mm; letter-spacing: 0; }
.hk-h { font-size: 7.3pt; color: #c7d2fe; margin-top: 0.4mm; }
.strip { display: flex; gap: 1mm; height: 7mm; }
.seg { border-radius: 2mm; display: flex; align-items: center; padding: 0 3mm; font-size: 8pt; color: #fff; white-space: nowrap; }
.seg b { font-size: 10pt; margin-right: 1.2mm; }
.seg.crit { background: var(--crit); } .seg.warn { background: var(--warn); } .seg.ok { background: var(--ok); } .seg.unk { background: var(--unk); }
.cols3 { display: grid; grid-template-columns: 1fr 1.25fr 1fr; gap: 4mm; flex: 1; min-height: 0; }
.cols3 > .panel { display: flex; flex-direction: column; }
.panel.accent { background: linear-gradient(180deg, var(--brand-soft), #fff 70%); border-color: #c7d2fe; }
.hot { display: flex; flex-direction: column; gap: 2mm; margin-top: 3mm; }
.hot-r { display: grid; grid-template-columns: minmax(15mm, auto) 1fr auto; gap: 2.5mm; align-items: center; padding: 1.8mm 3mm; border-radius: 2.6mm; background: var(--panel); border: 0.25mm solid var(--hair); }
.hr-n { font-size: 11pt; font-weight: 760; color: var(--ink); letter-spacing: -0.01em; }
.hr-d { font-size: 7.2pt; color: var(--text); }
.fill { margin-top: auto; padding-top: 3mm; display: flex; flex-direction: column; gap: 1.1mm; }
.fill-h { font-size: 6.6pt; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 650; margin-bottom: 0.6mm; }
.fl { display: grid; grid-template-columns: 19mm 1fr 9mm; gap: 2mm; align-items: center; font-size: 7pt; color: var(--text); }
.fl-b { height: 2.2mm; background: var(--panel2); border-radius: 99px; overflow: hidden; }
.fl-b i { display: block; height: 100%; border-radius: 99px; }
.fl-b i.ok { background: var(--ok); } .fl-b i.warn { background: var(--warn); } .fl-b i.crit { background: var(--crit); }
.fl b { text-align: right; font-size: 7pt; }
.first { display: flex; flex-direction: column; gap: 1.8mm; margin-top: 3mm; }
.fi { display: grid; grid-template-columns: 5.6mm 1fr; gap: 2.4mm; align-items: start; }
.fi-t { font-weight: 650; color: var(--ink); font-size: 8.2pt; }
.fi-d { font-size: 7pt; color: var(--muted); margin-top: 0.3mm; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.a-n { width: 5.6mm; height: 5.6mm; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 7.5pt; color: #fff; background: var(--warn); }
.crit > .a-n, .act.crit .a-n { background: var(--crit); }
.recs { display: flex; flex-direction: column; gap: 2.6mm; margin-top: 3mm; }
.rec { background: #fff; border: 0.3mm solid #c7d2fe; border-radius: 3mm; padding: 3mm 3.6mm; }
.rec-s { font-size: 6.8pt; letter-spacing: 0.1em; text-transform: uppercase; color: var(--brand); font-weight: 650; display: flex; align-items: center; gap: 1mm; }
.rec-n { font-size: 17pt; font-weight: 780; color: var(--ink); letter-spacing: -0.02em; margin-top: 0.6mm; }
.rec-w { display: flex; flex-wrap: wrap; gap: 1.2mm; margin-top: 1.2mm; }
.rec-w span { font-size: 6.8pt; background: var(--brand-soft); color: var(--brand); border-radius: 99px; padding: 0.4mm 1.8mm; font-weight: 600; }
.rec-2 { font-size: 7pt; color: var(--muted); margin-top: 1.4mm; }
.rec.none { border-style: dashed; }
.rec-x { font-size: 7.6pt; color: var(--text); margin-top: 1mm; }

/* Storage cards */
.site { display: flex; flex-direction: column; gap: 2.2mm; }
.site-h { display: flex; align-items: baseline; gap: 2mm; font-size: 8pt; color: var(--muted); }
.site-h b { font-size: 10.5pt; color: var(--ink); }
.site-h .gl { color: var(--brand); align-self: center; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
.rc { position: relative; display: flex; flex-direction: column; gap: 1.25mm; border: 0.3mm solid var(--line); border-radius: 3.2mm; padding: 3mm 3.6mm 2.8mm 4.6mm; background: #fff; overflow: hidden; }
.rc::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 1.3mm; background: var(--unk); }
.rc.crit::before { background: var(--crit); } .rc.warn::before { background: var(--warn); } .rc.ok::before { background: var(--ok); }
.rc-h { display: flex; justify-content: space-between; align-items: center; }
.rc-n { font-size: 14pt; font-weight: 780; color: var(--ink); letter-spacing: -0.02em; }
.rc-f { font-size: 6.4pt; color: var(--faint); margin-top: -1mm; }
.bar { display: flex; gap: 0.5mm; height: 2.6mm; border-radius: 99px; overflow: hidden; background: var(--panel2); }
.bar span { height: 100%; }
.b-used { background: var(--used); } .b-orph { background: var(--orph); }
.b-free.ok { background: var(--ok); } .b-free.warn { background: var(--warn); } .b-free.crit { background: var(--crit); }
.rc-free { font-size: 7.2pt; color: var(--muted); }
.rc-free b { font-size: 9pt; }
.rc-s { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5mm; padding: 1.2mm 0; border-top: 0.25mm solid var(--hair); border-bottom: 0.25mm solid var(--hair); }
.rc-s b { display: block; font-size: 11pt; font-weight: 720; color: var(--ink); }
.rc-s span { font-size: 6.2pt; color: var(--muted); }
.rc-b { display: flex; justify-content: space-between; align-items: center; gap: 2mm; }
.rc-i { font-size: 7.2pt; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.rc-p { flex: none; font-size: 6.6pt; color: var(--brand); font-weight: 600; display: flex; align-items: center; gap: 1mm; }

/* Attachments */
.mx { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 7.6pt; }
.mx th { text-align: left; font-weight: 600; font-size: 6.6pt; color: var(--muted); padding: 0 2mm 1.8mm; border-bottom: 0.3mm solid var(--line); vertical-align: bottom; }
.mx th.r, .mx td.r { text-align: right; }
.mx td { padding: 0.9mm 2mm; border-bottom: 0.25mm solid var(--hair); vertical-align: middle; }
.sv { display: flex; align-items: center; gap: 1.2mm; color: var(--ink); font-size: 7.4pt; font-weight: 650; }
.sv i { width: 1.6mm; height: 1.6mm; border-radius: 50%; }
.sv i.ok { background: var(--ok); } .sv i.unk { background: var(--crit); }
.sv-s { font-weight: 500; color: var(--faint); margin-top: 0.3mm; }
.mx-site td { background: var(--panel); font-weight: 700; color: var(--ink); font-size: 7.8pt; padding: 1.4mm 2mm; }
.mx-site .gl { color: var(--brand); }
.mx-n { display: flex; align-items: center; gap: 2mm; font-weight: 700; color: var(--ink); font-size: 9pt; }
.mx-p { font-size: 6.3pt; color: var(--faint); margin-top: 0.2mm; }
.mx-c { display: inline-flex; align-items: baseline; gap: 0.3mm; padding: 0.6mm 2.2mm; border-radius: 1.6mm; font-weight: 700; font-size: 8.4pt; }
.mx-c small { font-size: 6.6pt; font-weight: 600; opacity: 0.75; }
.mx-c em { font-style: normal; font-size: 6pt; margin-left: 1.2mm; font-weight: 650; }
.mx-c.on { background: var(--brand-soft); color: var(--brand); }
.mx-c.idle { background: var(--panel2); color: var(--faint); }
.mx-c.twice { background: var(--warn-bg); color: var(--warn-ink); box-shadow: inset 0 0 0 0.25mm var(--warn-line); }
.mx-no { color: #cbd5e1; }
.mx-q { display: inline-block; padding: 0.6mm 2.2mm; border-radius: 1.6mm; background: var(--crit-bg); color: var(--crit-ink); font-weight: 700; }
.duo { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; align-items: start; }
.duo.one { grid-template-columns: 1fr; }
.cfg { display: flex; flex-direction: column; gap: 2.2mm; margin-top: 2.6mm; }
.cfg > div { display: flex; gap: 2.4mm; align-items: flex-start; }
.cfg b { display: block; color: var(--ink); font-size: 8pt; }
.cfg span { font-size: 7pt; color: var(--muted); }
.howto { display: flex; flex-direction: column; gap: 1.8mm; margin-top: 2.6mm; }
.howto > div { display: grid; grid-template-columns: 22mm 1fr; gap: 2mm; align-items: center; font-size: 7.2pt; }
.howto > div > .pill, .howto > div > .chip { justify-self: start; }

/* Repository header */
.rhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 6mm; }
.rhead .eyebrow { font-size: 7pt; color: var(--muted); display: flex; align-items: center; gap: 1mm; }
.rhead .eyebrow .gl { color: var(--brand); }
.rhead h1 { font-size: 25pt; font-weight: 800; letter-spacing: -0.03em; color: var(--ink); line-height: 1.05; margin-top: 0.8mm; }
.rhead h1 span { font-size: 9.5pt; font-weight: 500; color: var(--faint); margin-left: 3mm; letter-spacing: 0; }
.srv { display: flex; gap: 1.4mm; flex-wrap: wrap; margin-top: 1.6mm; }
.srv span { font-size: 6.8pt; background: var(--panel2); color: var(--text); border-radius: 1.4mm; padding: 0.5mm 1.8mm; }
.srv span.off { background: var(--crit-bg); color: var(--crit-ink); }
.verdict { display: flex; align-items: center; gap: 3mm; border-radius: 3mm; padding: 2.4mm 4mm; font-size: 9pt; font-weight: 550; color: var(--ink); }
.verdict.crit { background: var(--crit-bg); box-shadow: inset 1.1mm 0 0 var(--crit); }
.verdict.warn { background: var(--warn-bg); box-shadow: inset 1.1mm 0 0 var(--warn); }
.verdict.ok { background: var(--ok-bg); box-shadow: inset 1.1mm 0 0 var(--ok); }
.verdict.unk { background: var(--panel2); box-shadow: inset 1.1mm 0 0 var(--unk); }
.rowA { display: grid; grid-template-columns: 104mm 1fr; gap: 3.2mm; }
.cap { display: flex; align-items: center; gap: 5mm; }
.donut { width: 33mm; height: 33mm; flex: none; }
.d-v { font-size: 8.6px; font-weight: 780; fill: var(--ink); letter-spacing: -0.3px; }
.d-l { font-size: 3.4px; fill: var(--muted); font-weight: 500; }
.lg { display: flex; flex-direction: column; gap: 1.6mm; flex: 1; }
.lg > div { display: grid; grid-template-columns: 2.4mm 1fr auto; align-items: center; gap: 2mm; font-size: 7.8pt; }
.lg i { width: 2.4mm; height: 2.4mm; border-radius: 0.7mm; }
.lg b { color: var(--ink); }
.lg small { display: block; color: var(--faint); font-size: 6.3pt; }
.lg .lg-tot { border-top: 0.25mm solid var(--hair); padding-top: 1.4mm; grid-template-columns: 1fr auto; color: var(--muted); }
.lg p { font-size: 6.3pt; color: var(--faint); line-height: 1.3; }
.rcol { display: flex; flex-direction: column; gap: 3.2mm; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3.2mm; }
.kpi { border: 0.3mm solid var(--line); border-radius: 3.2mm; padding: 2.8mm 3.4mm; background: #fff; }
.k-l { font-size: 6.3pt; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
.k-v { font-size: 19pt; font-weight: 760; color: var(--ink); letter-spacing: -0.02em; margin-top: 0.6mm; line-height: 1.1; }
.k-v small { font-size: 7.6pt; font-weight: 600; color: var(--muted); margin-left: 1mm; letter-spacing: 0; }
.k-h { font-size: 6.6pt; color: var(--muted); margin-top: 0.3mm; }
.kpi.warn { background: var(--warn-bg); border-color: var(--warn-line); } .kpi.warn .k-v { color: #b45309; }
.kpi.crit { background: var(--crit-bg); border-color: var(--crit-line); } .kpi.crit .k-v { color: var(--crit); }
.spread { padding: 2.8mm 3.6mm; }
.sp-h { font-size: 7pt; color: var(--muted); }
.sp-h b { color: var(--ink); }
.sp-bar { display: flex; gap: 0.6mm; height: 5mm; margin-top: 1.6mm; border-radius: 1.4mm; overflow: hidden; }
.sp-bar span { display: flex; align-items: center; padding: 0 2mm; font-size: 6.8pt; font-weight: 650; color: #fff; white-space: nowrap; overflow: hidden; }
.sp-Source { background: #0ea5e9; } .sp-Proxy { background: #8b5cf6; } .sp-Network { background: #14b8a6; } .sp-Target { background: #f43f5e; }
.sp-n { font-size: 6.2pt; color: var(--faint); margin-top: 1.4mm; }
.probs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.4mm; }
.prob { display: flex; gap: 2.4mm; align-items: flex-start; border-radius: 3mm; padding: 2.4mm 3mm; border: 0.3mm solid var(--line); background: #fff; }
.prob.crit { background: var(--crit-bg); border-color: var(--crit-line); }
.prob.unk { background: var(--panel2); }
.pt { font-weight: 650; color: var(--ink); font-size: 8.1pt; }
.pd { font-size: 6.9pt; color: var(--text); margin-top: 0.4mm; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.probs.tight .prob { padding: 1.8mm 2.6mm; }
.probs.tight .pd { -webkit-line-clamp: 1; }
.heatp { display: flex; flex-direction: column; gap: 2.4mm; }
.heatp .ph { display: flex; justify-content: space-between; align-items: flex-start; gap: 4mm; }
.scale { display: flex; align-items: center; gap: 0.7mm; font-size: 6.4pt; color: var(--muted); white-space: nowrap; }
.scale i { width: 4mm; height: 2.6mm; border-radius: 0.6mm; }
.scale span { margin: 0 1mm; }
.heat { display: grid; grid-template-columns: 7mm repeat(24, 1fr); gap: 0.6mm; flex: 1; grid-auto-rows: 1fr; grid-template-rows: 3.4mm; }
.hh { font-size: 6pt; color: var(--faint); text-align: center; border-radius: 0.8mm; display: grid; place-items: center; }
.hh.win { background: var(--win); color: var(--brand); font-weight: 600; }
.hd { font-size: 7pt; font-weight: 650; color: var(--text); display: flex; align-items: center; }
.hc { border-radius: 1.1mm; font-size: 6.8pt; font-weight: 650; display: grid; place-items: center; min-height: 4mm; }
.hc.peak { box-shadow: inset 0 0 0 0.45mm var(--ink); }

/* Jobs on 24 hours */
.legend { display: flex; flex-wrap: wrap; gap: 3mm; font-size: 6.6pt; color: var(--muted); justify-content: flex-end; max-width: 150mm; }
.legend span { display: inline-flex; align-items: center; gap: 1.1mm; }
.legend i { display: inline-block; width: 4.4mm; height: 2.2mm; border-radius: 0.6mm; }
.lg-run { background: var(--brand2); } .lg-max { background: #c7d2fe; } .lg-meh { background: var(--warn); } .lg-bad { background: var(--crit); }
.lg-live { background: repeating-linear-gradient(45deg, rgba(225, 29, 72, 0.75) 0 0.7mm, rgba(225, 29, 72, 0.22) 0.7mm 1.4mm); }
.lg-win { background: var(--win); box-shadow: inset 0 0 0 0.2mm #ddd6fe; }
.lg-now { width: 0 !important; height: 3mm !important; border-left: 0.4mm dashed var(--crit); border-radius: 0 !important; }
.gantt { display: flex; flex-direction: column; }
.g-row { display: grid; grid-template-columns: 9mm 54mm 1fr 11mm 11mm 15mm 19mm 17mm; gap: 2mm; align-items: center; padding: 0.5mm 0; border-bottom: 0.25mm solid var(--hair); line-height: 1.16; }
.g-head { font-size: 6.2pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 650; border-bottom: 0.3mm solid var(--line); padding: 0 0 1.4mm; align-items: end; }
.g-head .r, .g-num { text-align: right; }
.g-start { font-weight: 700; color: var(--ink); font-size: 7.8pt; }
.g-name { min-width: 0; }
.g-n { font-size: 7.6pt; color: var(--ink); font-weight: 560; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-s { font-size: 6.1pt; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-num { font-size: 7.4pt; color: var(--text); }
.g-num.hot { color: var(--crit); font-weight: 700; }
.g-c { min-width: 0; }
.bn { font-size: 7pt; color: var(--muted); }
.track { position: relative; height: 4.4mm; border-radius: 1.2mm; box-shadow: inset 0 0 0 0.25mm var(--line);
  background-image: repeating-linear-gradient(90deg, transparent 0, transparent calc(12.5% - 0.25mm), var(--hair) calc(12.5% - 0.25mm), var(--hair) 12.5%), linear-gradient(90deg, var(--win) 0 29.1667%, #fff 29.1667% 75%, var(--win) 75% 100%); }
.track i { position: absolute; top: 0.75mm; bottom: 0.75mm; border-radius: 0.9mm; }
.t-max.good { background: #c7d2fe; } .t-run.good { background: var(--brand2); }
.t-max.meh { background: #fde68a; } .t-run.meh { background: var(--warn); }
.t-max.bad { background: #fecdd3; } .t-run.bad { background: var(--crit); }
.track i.t-live { top: 0.35mm; bottom: 0.35mm; background: repeating-linear-gradient(45deg, rgba(99, 102, 241, 0.75) 0 0.8mm, rgba(99, 102, 241, 0.22) 0.8mm 1.6mm); }
.track i.t-live.hang { background: repeating-linear-gradient(45deg, rgba(225, 29, 72, 0.8) 0 0.8mm, rgba(225, 29, 72, 0.22) 0.8mm 1.6mm); }
.t-now { position: absolute; top: -1.1mm; bottom: -1.1mm; width: 0; border-left: 0.35mm dashed var(--crit); }
.g-axis { position: relative; height: 3.2mm; text-transform: none; letter-spacing: 0; }
.g-axis span { position: absolute; bottom: 0; transform: translateX(-10%); font-size: 6pt; color: var(--faint); font-weight: 500; }
.g-axis em { position: absolute; top: -2.6mm; transform: translateX(-50%); font-style: normal; font-size: 5.8pt; color: var(--crit); font-weight: 650; }
.notes { font-size: 7pt; color: var(--muted); display: flex; flex-direction: column; gap: 0.8mm; }
.notes b { color: var(--text); }

/* What to do */
.acts { display: grid; grid-template-columns: 1fr 1fr; gap: 2.4mm; }
.act { display: grid; grid-template-columns: 5.6mm 1fr; gap: 2.6mm; align-items: start; padding: 2.4mm 3.2mm; border: 0.3mm solid var(--line); border-radius: 3mm; background: #fff; }
.a-f { display: flex; justify-content: space-between; align-items: center; gap: 2mm; margin-top: 1.2mm; }
.act.crit { background: var(--crit-bg); border-color: var(--crit-line); }
.a-t { font-weight: 650; color: var(--ink); font-size: 8.2pt; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.a-p { display: flex; flex-wrap: wrap; align-items: center; gap: 0.8mm; font-size: 6.4pt; }
.a-p span { background: var(--panel2); color: var(--text); padding: 0.3mm 1.5mm; border-radius: 1mm; }
.a-p em { font-style: normal; color: var(--faint); }
.a-e { flex: none; display: flex; align-items: center; gap: 1mm; font-size: 6.8pt; font-weight: 650; color: var(--ok-ink); background: var(--ok-bg); padding: 0.6mm 2.2mm; border-radius: 99px; white-space: nowrap; }
.mvs { display: flex; flex-direction: column; margin-top: 2.4mm; }
.mv { display: grid; grid-template-columns: 40mm 1fr 25mm 18mm; gap: 2mm; align-items: center; padding: 1.2mm 0; border-bottom: 0.25mm solid var(--hair); }
.mv-n { min-width: 0; }
.track.mini { height: 3.6mm; }
.track i.t-old { background: repeating-linear-gradient(45deg, #cbd5e1 0 0.7mm, #e2e8f0 0.7mm 1.4mm); }
.track i.t-new { background: var(--brand2); }
.mv-x { font-size: 8pt; color: var(--ink); display: flex; align-items: center; gap: 1mm; justify-content: flex-end; }
.mv-x s { color: var(--faint); }
.mv-x .gl { color: var(--brand); width: 2.8mm; }
.mv-e { justify-self: end; }
.orph { display: flex; flex-direction: column; margin-top: 2.4mm; }
.or { display: grid; grid-template-columns: 1fr 26mm 16mm 15mm; gap: 2mm; align-items: center; padding: 1mm 0; border-bottom: 0.25mm solid var(--hair); font-size: 7.4pt; }
.or-n { color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.or-n small { color: var(--faint); margin-left: 1.4mm; font-size: 6.2pt; }
.or-b { height: 2.2mm; background: var(--panel2); border-radius: 99px; overflow: hidden; }
.or-b i { display: block; height: 100%; background: var(--orph); border-radius: 99px; }
.or-v { text-align: right; font-weight: 650; color: var(--ink); }
.or-d { text-align: right; color: var(--muted); font-size: 6.8pt; }
.more { font-size: 6.8pt; color: var(--muted); margin-top: 1.4mm; }
`;
