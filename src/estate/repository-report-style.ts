/**
 * How the Repository report looks: A4 landscape pages, Inter, and the colours
 * of veeam.com, the ones the Job report is drawn in — its green, its dark
 * navy, and an amber and a coral of the same family. Green is what is going
 * well and what is busy; navy is what is stored and the panel the report
 * opens on; coral and amber say a state and nothing else, each beside its
 * mark and its word. The colours are the variables at the top; the rest of
 * the sheet only names them.
 */
export const STYLE = `
:root {
  --ink: #0e1a15; --text: #2b3a33; --muted: #55635d; --faint: #6f7d76; --line: #dce3df; --hair: #edf1ee;
  --panel: #f5f7f6; --panel2: #edf1ee;
  --brand: #00d15f; --brand2: #00d15f; --deep: #010d35; --deeper: #010d35; --brand-soft: #e9f9ee; --brand-line: #bfeacb; --win: #eef8f1;
  --crit: #ff5a5f; --crit-bg: #fff0f0; --crit-ink: #c9303a; --crit-line: #ffc4c6;
  --warn: #ffb224; --warn-bg: #fff6e0; --warn-ink: #7a5200; --warn-line: #ffdc94;
  --ok: #00d15f; --ok-bg: #e9f9ee; --ok-ink: #006b2b; --ok-line: #bfeacb;
  --unk: #8a9891; --unk-bg: #f5f7f6; --unk-ink: #46544d; --unk-line: #dce3df;
  --used: #010d35; --orph: repeating-linear-gradient(135deg, #6b7697 0 0.7mm, #c9cfdd 0.7mm 1.4mm);
}
@page { size: 297mm 210mm; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Inter Variable', 'Segoe UI', sans-serif; font-size: 8.6pt; line-height: 1.35; color: var(--text); background: #fff; font-feature-settings: 'tnum' 1, 'cv11' 1, 'ss03' 1; }
a { color: inherit; text-decoration: none; }
b { font-weight: 650; }
.dim { color: var(--faint); }

.page { width: 297mm; height: 210mm; padding: 8mm 12mm 8mm; position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 3.2mm; break-after: page; }
.page:last-child { break-after: auto; }
/* The green rule every page but the cover opens with */
.page::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2mm; background: var(--brand); }
.grow { flex: 1; min-height: 0; }

/* Top bar */
.top { display: flex; justify-content: space-between; align-items: center; font-size: 7.5pt; color: var(--muted); padding-bottom: 2.4mm; border-bottom: 0.3mm solid var(--line); }
.top b { color: var(--ink); font-weight: 650; }
.top .crumb em { font-style: normal; margin: 0 1.6mm; color: #b6c2bc; }
.logo { display: inline-block; width: 2.6mm; height: 2.6mm; border-radius: 0.6mm; background: var(--brand); margin-right: 2mm; vertical-align: -0.35mm; }
.gl { width: 3.2mm; height: 3.2mm; vertical-align: -0.6mm; flex: none; }

/* Headings */
.sect { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; }
h2 { font-size: 14pt; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; line-height: 1.15; }
.h2sub { font-size: 8.6pt; color: var(--muted); margin-top: 0.8mm; max-width: 200mm; }
h3 { font-size: 10pt; font-weight: 700; color: var(--ink); display: flex; align-items: center; gap: 1.8mm; }
h3 .gl { color: var(--brand); }
h3 small { font-size: 7.5pt; font-weight: 400; color: var(--muted); }
.sub { font-size: 7.5pt; color: var(--muted); margin-top: 0.6mm; }
.panel { background: #fff; border: 0.3mm solid var(--line); border-radius: 3mm; padding: 3.6mm 4.2mm; }
.empty { color: var(--muted); font-size: 8.6pt; padding: 4mm 0; }

/* A state: Veeam's mark and its word */
.pill { display: inline-flex; align-items: center; gap: 1.4mm; font-size: 8.6pt; font-weight: 650; color: var(--ink); white-space: nowrap; }
.pill svg { width: 3.6mm; height: 3.6mm; flex: none; }
.pill.big { font-size: 10pt; gap: 2mm; padding: 1.7mm 4.2mm 1.7mm 2.8mm; border-radius: 99px; background: var(--unk-bg); box-shadow: inset 0 0 0 0.3mm var(--unk-line); }
.pill.big svg { width: 4.8mm; height: 4.8mm; }
.pill.big.crit { background: var(--crit-bg); box-shadow: inset 0 0 0 0.3mm var(--crit-line); }
.pill.big.warn { background: var(--warn-bg); box-shadow: inset 0 0 0 0.3mm var(--warn-line); }
.pill.big.ok { background: var(--ok-bg); box-shadow: inset 0 0 0 0.3mm var(--ok-line); }
.chip { display: inline-block; font-size: 7.5pt; font-weight: 650; padding: 0.35mm 1.8mm; border-radius: 99px; white-space: nowrap; }
.chip.ok { background: var(--ok-bg); color: var(--ok-ink); }
.chip.warn { background: var(--warn-bg); color: var(--warn-ink); box-shadow: inset 0 0 0 0.25mm var(--warn-line); }
.chip.crit { background: var(--crit-bg); color: var(--crit-ink); box-shadow: inset 0 0 0 0.25mm var(--crit-line); }
.chip.run { background: var(--brand-soft); color: var(--ok-ink); }
b.crit { color: var(--crit); } b.warn { color: var(--warn-ink); } b.ok { color: var(--ink); }

/* A problem's own icon, in the colour of how bad it is */
.ic { flex: none; width: 6.2mm; height: 6.2mm; border-radius: 1.6mm; display: grid; place-items: center; color: var(--ok-ink); background: var(--brand-soft); }
.ic svg { width: 3.7mm; height: 3.7mm; }
.ic.crit { background: var(--crit); color: #fff; } .ic.warn { background: var(--warn); color: #3a2800; } .ic.ok { background: var(--ok); color: #fff; } .ic.unk { background: var(--unk); color: #fff; }
.key { display: inline-block; width: 3mm; height: 3mm; border-radius: 0.8mm; margin-right: 1.5mm; vertical-align: -0.45mm; background: var(--panel2); }
.key.used { background: var(--used); } .key.orph { background: var(--orph); } .key.free { background: #dfe6e2; }

/* Space as a bar: what jobs hold, what no job owns, and the track left over is free */
.bar { display: flex; gap: 0.5mm; height: 3mm; border-radius: 99px; overflow: hidden; background: #dfe6e2; }
.bar span { height: 100%; }
.b-used { background: var(--used); } .b-orph { background: var(--orph); }

/* Cover: a green side, and the page beside it */
.cover { padding: 0; flex-direction: row; gap: 0; }
.cover::before { content: none; }
.side { width: 82mm; flex: none; padding: 11mm 9mm 10mm 10mm; color: #fff; position: relative; overflow: hidden; display: flex; flex-direction: column;
  background: var(--deep); }
.brand { display: flex; align-items: center; gap: 3mm; padding-bottom: 3mm; border-bottom: 0.25mm solid rgba(255, 255, 255, 0.18); font-size: 7.5pt; color: #adb4c6; }
.brand .veeam-logo { height: 8.4mm; width: auto; flex: none; }
.side h1 { font-size: 23pt; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; margin-top: 12mm; }
.side .lead { font-size: 10pt; color: #d6dbe6; margin-top: 3mm; }
.side .when { font-size: 8.6pt; color: #adb4c6; margin-top: 2mm; }
.sum { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 6mm 5mm; }
.sum small { display: block; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--brand); }
.sum b { display: block; font-size: 23pt; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; color: #fff; }
.sum b span { font-size: 10pt; font-weight: 600; color: var(--brand2); margin-left: 1mm; letter-spacing: 0; }
.sum p { font-size: 7.5pt; color: #adb4c6; line-height: 1.3; }
.main { flex: 1; min-width: 0; padding: 10mm 12mm 8mm 11mm; display: flex; flex-direction: column; gap: 4.4mm; }
.main h3::before { content: ''; width: 1.1mm; height: 4.2mm; border-radius: 1mm; background: var(--brand); }
.main h3 { margin-bottom: 2mm; }
.headline { display: flex; gap: 3.6mm; align-items: flex-start; }
.headline > svg { width: 8.4mm; height: 8.4mm; flex: none; margin-top: 0.8mm; }
.headline h2 { font-size: 18pt; }
.headline p { font-size: 10pt; color: var(--text); margin-top: 1mm; }
.grid { width: 100%; border-collapse: separate; border-spacing: 0; border: 0.3mm solid var(--line); border-radius: 2.5mm; overflow: hidden; }
.grid th { background: var(--panel); font-size: 7.5pt; font-weight: 650; color: var(--muted); text-align: left; padding: 1.7mm 3.2mm; border-bottom: 0.3mm solid var(--line); }
.grid td { padding: 1.7mm 3.2mm; border-bottom: 0.3mm solid var(--hair); vertical-align: middle; }
.grid tr:last-child td { border-bottom: 0; }
.grid tr.crit td { background: var(--crit-bg); } .grid tr.warn td { background: var(--warn-bg); } .grid tr.unk td { background: var(--panel); }
.grid .r { text-align: right; }
.gr-n b { font-size: 10pt; font-weight: 700; color: var(--ink); }
.gr-n small, .gr-f small { display: block; font-size: 7.5pt; color: var(--muted); line-height: 1.2; white-space: nowrap; }
.gr-f b { font-size: 10pt; font-weight: 700; color: var(--ink); }
.gr-v { font-size: 10pt; font-weight: 650; color: var(--ink); }
.gr-p { font-size: 7.5pt; color: var(--muted); white-space: nowrap; }
.legend-k { display: flex; flex-wrap: wrap; gap: 1mm 5mm; font-size: 7.5pt; color: var(--muted); margin-top: 1.8mm; }
.legend-k span { white-space: nowrap; }
.lower { display: grid; grid-template-columns: 1.6fr 1fr; gap: 6mm; flex: 1; min-height: 0; }
.first { display: grid; grid-template-columns: 1fr 1fr; column-gap: 5mm; align-content: start; }
.fi { display: grid; grid-template-columns: 5.4mm 1fr; gap: 2.2mm; align-items: start; padding: 1.5mm 0; border-bottom: 0.3mm solid var(--hair); }
.fi-t { font-weight: 650; color: var(--ink); font-size: 8.6pt; line-height: 1.25; }
.fi-d { font-size: 7.5pt; color: var(--muted); margin-top: 0.3mm; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.a-n { width: 5.4mm; height: 5.4mm; border-radius: 1.4mm; display: grid; place-items: center; font-weight: 700; font-size: 7.5pt; color: #3a2800; background: var(--warn); }
.crit > .a-n, .act.crit .a-n { background: var(--crit); color: #fff; }
.recs { display: flex; flex-direction: column; gap: 2.2mm; }
.rec { background: var(--brand-soft); border: 0.3mm solid var(--brand-line); border-radius: 2.5mm; padding: 2.4mm 3.6mm; }
.rec-s { font-size: 7.5pt; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ok-ink); font-weight: 650; display: flex; align-items: center; gap: 1mm; }
.rec-n { font-size: 14pt; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; line-height: 1.2; }
.rec-w { display: flex; flex-wrap: wrap; gap: 0.6mm 3mm; margin-top: 0.4mm; font-size: 7.5pt; color: var(--text); }
.rec-2 { font-size: 7.5pt; color: var(--muted); margin-top: 0.8mm; }
.rec.none { background: #fff; border-style: dashed; border-color: var(--line); }
.rec-x { font-size: 8.6pt; color: var(--text); margin-top: 0.8mm; }
.foot { display: flex; justify-content: space-between; font-size: 7.5pt; color: var(--muted); margin-top: auto; }

/* Storage cards */
.site { display: flex; flex-direction: column; gap: 2.2mm; }
.site-h { display: flex; align-items: baseline; gap: 2mm; font-size: 8.6pt; color: var(--muted); }
.site-h b { font-size: 10pt; color: var(--ink); }
.site-h .gl { color: var(--brand); align-self: center; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
.rc { position: relative; display: flex; flex-direction: column; gap: 1.3mm; border: 0.3mm solid var(--line); border-radius: 3mm; padding: 3mm 3.6mm 2.6mm; background: #fff; overflow: hidden; }
.rc.crit { background: var(--crit-bg); border-color: var(--crit-line); } .rc.warn { background: var(--warn-bg); border-color: var(--warn-line); }
.rc-h { display: flex; justify-content: space-between; align-items: center; }
.rc-n { font-size: 14pt; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; }
.rc-f { font-size: 6.8pt; color: var(--muted); margin-top: -1mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-free { font-size: 7.5pt; color: var(--muted); }
.rc-free b { font-size: 10pt; }
.rc-s { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5mm; padding: 1.2mm 0; border-top: 0.25mm solid rgba(14, 26, 21, 0.1); border-bottom: 0.25mm solid rgba(14, 26, 21, 0.1); }
.rc-s b { display: block; font-size: 10pt; font-weight: 700; color: var(--ink); }
.rc-s span { font-size: 6.8pt; color: var(--muted); }
.rc-b { display: flex; justify-content: space-between; align-items: center; gap: 2mm; }
.rc-i { font-size: 7.5pt; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.rc-p { flex: none; font-size: 7.5pt; color: var(--ok-ink); font-weight: 650; display: flex; align-items: center; gap: 1mm; }

/* Attachments */
.mx { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 8.6pt; border: 0.3mm solid var(--line); border-radius: 2.5mm; overflow: hidden; }
.mx th { text-align: left; font-weight: 600; font-size: 7.5pt; color: var(--muted); padding: 1.6mm 2.6mm; border-bottom: 0.3mm solid var(--line); vertical-align: bottom; background: var(--panel); }
.mx th.r, .mx td.r { text-align: right; }
.mx td { padding: 0.9mm 2.6mm; border-bottom: 0.25mm solid var(--hair); vertical-align: middle; }
.mx tr:last-child td { border-bottom: 0; }
.sv { display: flex; align-items: center; gap: 1.2mm; color: var(--ink); font-size: 7.5pt; font-weight: 650; }
.sv i { width: 1.8mm; height: 1.8mm; border-radius: 50%; }
.sv i.ok { background: var(--ok); } .sv i.unk { background: var(--crit); }
.sv-s { font-weight: 400; color: var(--muted); margin-top: 0.3mm; }
.mx-site td { background: var(--brand-soft); font-weight: 700; color: var(--ink); font-size: 8.6pt; padding: 1.2mm 2.6mm; }
.mx-site .gl { color: var(--brand); }
.mx-n { display: flex; align-items: center; gap: 2.4mm; font-weight: 700; color: var(--ink); font-size: 10pt; }
.mx-n .pill { font-size: 7.5pt; font-weight: 600; } .mx-n .pill svg { width: 3.2mm; height: 3.2mm; }
.mx-p { font-size: 6.8pt; color: var(--muted); margin-top: 0.2mm; }
.mx-c { display: inline-flex; align-items: baseline; gap: 0.3mm; padding: 0.6mm 2.2mm; border-radius: 1.4mm; font-weight: 700; font-size: 8.6pt; }
.mx-c small { font-size: 6.8pt; font-weight: 600; opacity: 0.75; }
.mx-c em { font-style: normal; font-size: 6.8pt; margin-left: 1.2mm; font-weight: 650; }
.mx-c.on { background: var(--brand-soft); color: var(--ok-ink); }
.mx-c.idle { background: var(--panel2); color: var(--muted); }
.mx-c.twice { background: var(--warn-bg); color: var(--warn-ink); box-shadow: inset 0 0 0 0.25mm var(--warn-line); }
.mx-no { color: #b6c2bc; }
.mx-q { display: inline-block; padding: 0.6mm 2.2mm; border-radius: 1.4mm; background: var(--crit-bg); color: var(--crit-ink); font-weight: 700; }
.duo { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; align-items: start; }
.duo.one { grid-template-columns: 1fr; }
.cfg { display: flex; flex-direction: column; gap: 2.2mm; margin-top: 2.6mm; }
.cfg > div { display: flex; gap: 2.4mm; align-items: flex-start; }
.cfg b { display: block; color: var(--ink); font-size: 8.6pt; }
.cfg span { font-size: 7.5pt; color: var(--muted); }
.howto { display: flex; flex-direction: column; gap: 1.8mm; margin-top: 2.6mm; }
.howto > div { display: grid; grid-template-columns: 24mm 1fr; gap: 2mm; align-items: center; font-size: 7.5pt; }
.howto > div > .pill, .howto > div > .chip { justify-self: start; }

/* Repository header */
.rhead { display: flex; justify-content: space-between; align-items: center; gap: 6mm; }
.rhead .eyebrow { font-size: 7.5pt; color: var(--muted); display: flex; align-items: center; gap: 1mm; }
.rhead .eyebrow .gl { color: var(--brand); }
.rhead h1 { font-size: 23pt; font-weight: 700; letter-spacing: -0.025em; color: var(--ink); line-height: 1.05; margin-top: 0.8mm; }
.rhead h1 span { font-size: 10pt; font-weight: 400; color: var(--muted); margin-left: 3mm; letter-spacing: 0; }
.srv { display: flex; gap: 1.4mm; flex-wrap: wrap; margin-top: 1.6mm; }
.srv span { font-size: 7.5pt; background: var(--panel2); color: var(--text); border-radius: 1.2mm; padding: 0.5mm 1.8mm; }
.srv span.off { background: var(--crit-bg); color: var(--crit-ink); }
.verdict { display: flex; align-items: center; gap: 3mm; border-radius: 2.5mm; padding: 2.4mm 4mm; font-size: 10pt; font-weight: 650; color: var(--ink); }
.verdict > svg { width: 5mm; height: 5mm; flex: none; }
.verdict.crit { background: #e5484d; color: #fff; } .verdict.ok { background: #00994a; color: #fff; } .verdict.warn { background: #ffb224; color: #3d2a00; }
.verdict.crit > svg circle, .verdict.ok > svg circle { fill: #fff; } .verdict.crit > svg path { stroke: #e5484d; } .verdict.ok > svg path { stroke: #00994a; }
.verdict.warn > svg path:first-child { fill: #3d2a00; } .verdict.warn > svg path + path { stroke: #ffb224; } .verdict.warn > svg circle { fill: #ffb224; }
.verdict.unk { background: var(--panel2); box-shadow: inset 0 0 0 0.3mm var(--unk-line); }
.rowA { display: grid; grid-template-columns: 110mm 1fr; gap: 3.2mm; }
.cap { display: flex; flex-direction: column; gap: 2.2mm; }
.cap-h { display: flex; justify-content: space-between; align-items: baseline; font-size: 7.5pt; color: var(--muted); }
.cap .bar { height: 7mm; border-radius: 1.8mm; gap: 0.6mm; }
.cap-l { display: flex; justify-content: space-between; gap: 4mm; }
.cap-l span { display: block; font-size: 7.5pt; color: var(--muted); line-height: 1.25; white-space: nowrap; }
.cap-l b { display: block; font-size: 14pt; font-weight: 700; color: var(--ink); letter-spacing: -0.01em; line-height: 1.25; }
.cap-l b small { font-size: 8.6pt; font-weight: 600; color: var(--muted); margin-left: 0.8mm; letter-spacing: 0; }
.cap-l b.crit { color: var(--crit); } .cap-l b.warn { color: var(--warn-ink); }
.cap p { font-size: 6.8pt; color: var(--muted); line-height: 1.3; }
.rcol { display: flex; flex-direction: column; gap: 3.2mm; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2.6mm; }
.kpi { border-radius: 2.5mm; padding: 2.6mm 3.2mm; background: var(--panel); }
.k-l { font-size: 6.8pt; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); font-weight: 650; white-space: nowrap; }
.k-v { font-size: 18pt; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; margin-top: 0.4mm; line-height: 1.1; }
.k-v small { font-size: 7.5pt; font-weight: 600; color: var(--muted); margin-left: 1mm; letter-spacing: 0; }
.k-h { font-size: 6.8pt; color: var(--muted); margin-top: 0.3mm; line-height: 1.25; }
.kpi.warn { background: var(--warn-bg); } .kpi.warn .k-v { color: var(--warn-ink); }
.kpi.crit { background: var(--crit-bg); } .kpi.crit .k-v { color: var(--crit); }
.spread { padding: 2.6mm 3.6mm; }
.sp-h { font-size: 7.5pt; color: var(--muted); }
.sp-h b { color: var(--ink); }
.sp-bar { display: flex; gap: 0.6mm; height: 5mm; margin-top: 1.6mm; border-radius: 1.4mm; overflow: hidden; }
.sp-bar span { display: flex; align-items: center; padding: 0 2mm; font-size: 7.5pt; font-weight: 650; color: #fff; white-space: nowrap; overflow: hidden; }
.sp-Source { background: #010d35; } .sp-Proxy { background: #3d4a78; } .sp-Network { background: #7c88ad; } .sp-Target { background: var(--crit); }
.sp-n { font-size: 6.8pt; color: var(--muted); margin-top: 1.4mm; line-height: 1.3; }
.probs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.2mm; }
.prob { display: flex; gap: 2.4mm; align-items: flex-start; border-radius: 2.5mm; padding: 2.2mm 3mm; border: 0.3mm solid var(--line); background: #fff; }
.prob.crit { background: var(--crit-bg); border-color: var(--crit-line); }
.prob.unk { background: var(--panel2); }
.pt { font-weight: 650; color: var(--ink); font-size: 8.6pt; line-height: 1.25; }
.pd { font-size: 7.5pt; color: var(--text); margin-top: 0.4mm; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.probs.tight .prob { padding: 1.7mm 2.6mm; }
.probs.tight .pd { -webkit-line-clamp: 1; }
.heatp { display: flex; flex-direction: column; gap: 2.2mm; }
.heatp .ph { display: flex; justify-content: space-between; align-items: flex-start; gap: 4mm; }
.scale { display: flex; align-items: center; gap: 0.7mm; font-size: 6.8pt; color: var(--muted); white-space: nowrap; }
.scale i { width: 4.4mm; height: 2.6mm; border-radius: 0.6mm; }
.scale span { margin: 0 1mm; }
.heat { display: grid; grid-template-columns: 7mm repeat(24, 1fr); gap: 0.6mm; flex: 1; grid-auto-rows: 1fr; grid-template-rows: 3.6mm; }
.hh { font-size: 6.8pt; color: var(--faint); text-align: center; display: grid; place-items: center; }
.hh.win { color: var(--ink); font-weight: 700; box-shadow: inset 0 -0.5mm 0 var(--brand); }
.hd { font-size: 7.5pt; font-weight: 650; color: var(--ink); display: flex; align-items: center; }
.hc { border-radius: 1.1mm; font-size: 7.5pt; font-weight: 650; display: grid; place-items: center; min-height: 4mm; }
.hc.peak { box-shadow: inset 0 0 0 0.55mm var(--crit); }

/* Jobs on 24 hours */
.legend { display: flex; flex-wrap: wrap; gap: 1mm 3mm; font-size: 7.5pt; color: var(--muted); justify-content: flex-end; max-width: 160mm; }
.legend span { display: inline-flex; align-items: center; gap: 1.1mm; }
.legend i { display: inline-block; width: 4.4mm; height: 2.2mm; border-radius: 0.6mm; }
.lg-run { background: var(--brand); } .lg-max { background: #a8e6ba; } .lg-meh { background: var(--warn); } .lg-bad { background: var(--crit); }
.lg-live { background: repeating-linear-gradient(45deg, rgba(0, 61, 43, 0.8) 0 0.7mm, rgba(0, 61, 43, 0.22) 0.7mm 1.4mm); }
.lg-win { background: var(--win); box-shadow: inset 0 0 0 0.2mm var(--brand-line); }
.lg-now { width: 0 !important; height: 3mm !important; border-left: 0.4mm dashed var(--crit); border-radius: 0 !important; }
.gantt { display: flex; flex-direction: column; }
.g-row { display: grid; grid-template-columns: 9.5mm 54mm 1fr 11mm 11mm 11mm 15mm 20mm 17mm; gap: 2mm; align-items: center; padding: 0.5mm 0; border-bottom: 0.25mm solid var(--hair); line-height: 1.16; }
.g-head { font-size: 6.8pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 650; border-bottom: 0.3mm solid var(--line); padding: 0 0 1.4mm; align-items: end; }
.g-head .r, .g-num { text-align: right; }
.g-start { font-weight: 700; color: var(--ink); font-size: 8.6pt; }
.g-name { min-width: 0; }
.g-n { font-size: 7.5pt; color: var(--ink); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-s { font-size: 6.8pt; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-num { font-size: 7.5pt; color: var(--text); }
.g-any { grid-column: span 2; }
.g-num.hot { color: var(--crit); font-weight: 700; }
.g-c { min-width: 0; }
.bn { font-size: 7.5pt; color: var(--muted); }
.track { position: relative; height: 4.4mm; border-radius: 1.2mm; box-shadow: inset 0 0 0 0.25mm var(--line);
  background-image: repeating-linear-gradient(90deg, transparent 0, transparent calc(12.5% - 0.25mm), var(--hair) calc(12.5% - 0.25mm), var(--hair) 12.5%), linear-gradient(90deg, var(--win) 0 29.1667%, #fff 29.1667% 75%, var(--win) 75% 100%); }
.track i { position: absolute; top: 0.75mm; bottom: 0.75mm; border-radius: 0.9mm; }
.t-max.good { background: #a8e6ba; } .t-run.good { background: var(--brand); }
.t-max.meh { background: #f7dc8f; } .t-run.meh { background: var(--warn); }
.t-max.bad { background: #f4b9b7; } .t-run.bad { background: var(--crit); }
.track i.t-live { top: 0.35mm; bottom: 0.35mm; background: repeating-linear-gradient(45deg, rgba(0, 61, 43, 0.8) 0 0.8mm, rgba(0, 61, 43, 0.22) 0.8mm 1.6mm); }
.track i.t-live.hang { background: repeating-linear-gradient(45deg, rgba(224, 49, 46, 0.85) 0 0.8mm, rgba(224, 49, 46, 0.22) 0.8mm 1.6mm); }
.t-now { position: absolute; top: -1.1mm; bottom: -1.1mm; width: 0; border-left: 0.35mm dashed var(--crit); }
.g-axis { position: relative; height: 3.2mm; text-transform: none; letter-spacing: 0; }
.g-axis span { position: absolute; bottom: 0; transform: translateX(-10%); font-size: 6.8pt; color: var(--muted); font-weight: 400; }
.g-axis em { position: absolute; top: -2.6mm; transform: translateX(-50%); font-style: normal; font-size: 6.8pt; color: var(--crit); font-weight: 650; }
.notes { font-size: 7.5pt; color: var(--muted); display: flex; flex-direction: column; gap: 0.8mm; }
.notes b { color: var(--text); }

/* What to do */
.acts { display: grid; grid-template-columns: 1fr 1fr; gap: 2.4mm; }
.act { display: grid; grid-template-columns: 5.4mm 1fr; gap: 2.6mm; align-items: start; padding: 2.4mm 3.2mm; border: 0.3mm solid var(--line); border-radius: 2.5mm; background: #fff; }
.a-f { display: flex; justify-content: space-between; align-items: center; gap: 2mm; margin-top: 1.2mm; }
.act.crit { background: var(--crit-bg); border-color: var(--crit-line); }
.a-t { font-weight: 650; color: var(--ink); font-size: 8.6pt; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.a-p { display: flex; flex-wrap: wrap; align-items: center; gap: 0.8mm; font-size: 6.8pt; }
.a-p span { background: var(--panel2); color: var(--text); padding: 0.3mm 1.5mm; border-radius: 1mm; }
.act.crit .a-p span { background: rgba(255, 255, 255, 0.7); }
.a-p em { font-style: normal; color: var(--faint); }
.a-e { flex: none; display: flex; align-items: center; gap: 1mm; font-size: 7.5pt; font-weight: 650; color: var(--ok-ink); background: var(--ok-bg); padding: 0.6mm 2.2mm; border-radius: 99px; white-space: nowrap; }
.mvs { display: flex; flex-direction: column; margin-top: 2.4mm; }
.mv { display: grid; grid-template-columns: 40mm 1fr 25mm 18mm; gap: 2mm; align-items: center; padding: 1.2mm 0; border-bottom: 0.25mm solid var(--hair); }
.mv-n { min-width: 0; }
.track.mini { height: 3.6mm; }
.track i.t-old { background: repeating-linear-gradient(45deg, #b6c2bc 0 0.7mm, #dce3df 0.7mm 1.4mm); }
.track i.t-new { background: var(--brand); }
.mv-x { font-size: 8.6pt; color: var(--ink); display: flex; align-items: center; gap: 1mm; justify-content: flex-end; }
.mv-x s { color: var(--muted); }
.mv-x .gl { color: var(--brand); width: 2.8mm; }
.mv-e { justify-self: end; }
div.orph { display: flex; flex-direction: column; margin-top: 2.4mm; }
.or { display: grid; grid-template-columns: 1fr 26mm 16mm 15mm; gap: 2mm; align-items: center; padding: 1mm 0; border-bottom: 0.25mm solid var(--hair); font-size: 7.5pt; }
.or-n { color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.or-n small { color: var(--muted); margin-left: 1.4mm; font-size: 6.8pt; }
.or-b { height: 2.4mm; background: var(--panel2); border-radius: 99px; overflow: hidden; }
.or-b i { display: block; height: 100%; background: var(--orph); border-radius: 99px; }
.or-v { text-align: right; font-weight: 650; color: var(--ink); }
.or-d { text-align: right; color: var(--muted); font-size: 7.5pt; }
.more { font-size: 7.5pt; color: var(--muted); margin-top: 1.4mm; }
`;
