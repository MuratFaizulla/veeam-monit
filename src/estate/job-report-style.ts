/**
 * What the Job report adds to the Repository report's sheet (`STYLE`): the
 * month of runs, the machines by run, the errors and the neighbours. The
 * colours are the same variables.
 */
export const JOB_STYLE = `
.kpis.k5 { grid-template-columns: repeat(5, 1fr); }
.jr-head h1 { font-size: 22pt; }
.srv b { color: var(--ink); }
.runs { display: flex; flex-direction: column; gap: 1mm; }
.runs .ph, .nb .ph { display: flex; justify-content: space-between; align-items: flex-start; gap: 4mm; }
.lg-ok { background: var(--ok); } .lg-none { background: var(--panel2); box-shadow: inset 0 0 0 0.25mm var(--line); }
.lg-miss { box-shadow: inset 0 0 0 0.3mm var(--unk); background: repeating-linear-gradient(45deg, transparent 0 0.6mm, var(--line) 0.6mm 1.2mm); }

/* The month of runs */
.chart { position: relative; flex: 1; min-height: 0; margin: 6mm 3mm 0 12mm; }
.ch-plot { position: absolute; left: 0; right: 0; top: 0; bottom: 11mm; }
.ch-grid { position: absolute; left: 0; right: 0; border-top: 0.25mm dashed var(--line); }
.ch-grid span { position: absolute; left: -12mm; width: 10.5mm; text-align: right; top: -1.7mm; font-size: 6pt; color: var(--faint); white-space: nowrap; }
.ch-col { position: absolute; top: 0; bottom: 0; transform: translateX(-50%); }
.ch-bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column-reverse; gap: 0.35mm; }
.ch-bar i { display: block; border-radius: 0.7mm; min-height: 0.7mm; flex: none; }
.ch-bar i.success { background: var(--ok); } .ch-bar i.warning { background: var(--warn); } .ch-bar i.failed { background: var(--crit); } .ch-bar i.none { background: var(--unk); }
.ch-bar i.retry { opacity: 0.62; }
.ch-bar.cut::after { content: ''; position: absolute; left: -0.8mm; right: -0.8mm; top: 6mm; height: 0.5mm; background: var(--page); box-shadow: 0 1.1mm 0 var(--page); transform: skewY(-14deg); }
.ch-lab { position: absolute; bottom: 100%; left: 50%; transform: translate(-50%, -1mm); font-size: 6.2pt; white-space: nowrap; color: var(--ink); font-weight: 650; text-align: center; }
.ch-lab em { font-style: normal; color: var(--muted); font-weight: 600; margin-left: 0.8mm; }
.ch-d { position: absolute; bottom: -11mm; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; font-size: 5.8pt; color: var(--faint); line-height: 1.2; white-space: nowrap; }
.ch-d b { color: var(--text); font-size: 6.4pt; }
.ch-d .bad { color: var(--crit); font-weight: 700; }
.ch-d.left { transform: translateX(-88%); align-items: flex-end; } .ch-d.right { transform: translateX(-12%); align-items: flex-start; }
.ch-miss { position: absolute; left: 0; right: 0; bottom: 0; height: 9mm; border-radius: 0.7mm; box-shadow: inset 0 0 0 0.3mm var(--unk); background: repeating-linear-gradient(45deg, transparent 0 0.6mm, var(--line) 0.6mm 1.2mm); }
.ch-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--faint); font-size: 9pt; }

/* Machines by run */
.vms { table-layout: fixed; }
.vms td { padding: 0.7mm 2mm; }
.vms td.r, .vms th.r { white-space: nowrap; }
.vms tr.bad td { background: var(--crit-bg); }
.vm-n { display: flex; align-items: baseline; gap: 1.6mm; min-width: 0; }
.vm-n span { font-weight: 650; color: var(--ink); font-size: 7.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.vm-n small { flex: none; font-size: 6.2pt; color: var(--faint); }
.vms .err { font-size: 6.5pt; color: var(--text); line-height: 1.2; }
.vms .err.crit { color: var(--crit-ink); } .vms .err.warn { color: var(--warn-ink); } .vms .err.healed { color: var(--muted); }
.vms .err em { font-style: normal; color: var(--ok-ink); font-weight: 600; }
.err-t { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.hist { display: flex; gap: 0.6mm; flex-wrap: wrap; }
.hist i { width: 3.6mm; height: 3.6mm; border-radius: 0.8mm; background: var(--panel2); box-shadow: inset 0 0 0 0.25mm var(--line); }
.hist.dense i { width: 2.2mm; height: 2.2mm; border-radius: 0.5mm; }
.hist i.success { background: var(--ok); box-shadow: none; } .hist i.warning { background: var(--warn); box-shadow: none; } .hist i.failed { background: var(--crit); box-shadow: none; }

/* The chain, the errors, the neighbours */
.duo.jr { grid-template-columns: minmax(0, 1fr) minmax(0, 1.45fr); }
.duo.jr > .panel { min-width: 0; }
.or.ch { grid-template-columns: 26mm 1fr 18mm 20mm; }
.or-b i.full { background: var(--brand2); }
.repo { margin-top: 3mm; padding-top: 2.4mm; border-top: 0.25mm solid var(--hair); display: flex; flex-direction: column; gap: 1.2mm; }
.repo > div:first-child { display: flex; justify-content: space-between; font-size: 7.6pt; color: var(--ink); }
.repo span { color: var(--muted); }
.errs { display: flex; flex-direction: column; gap: 1.4mm; margin-top: 2.2mm; }
.er { display: grid; grid-template-columns: 13mm 1fr; gap: 2.4mm; align-items: start; padding: 1.5mm 2.4mm; border-radius: 2.4mm; background: var(--panel); }
.er.crit { background: var(--crit-bg); } .er.warn { background: var(--warn-bg); }
.er > div:last-child { min-width: 0; }
.er-c { display: flex; flex-direction: column; align-items: center; line-height: 1.05; }
.er-c b { font-size: 12pt; font-weight: 760; color: var(--ink); }
.er-c span { font-size: 5.8pt; color: var(--muted); }
.er-t { font-size: 7.2pt; color: var(--ink); font-weight: 560; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.er-d { font-size: 6.3pt; color: var(--muted); margin-top: 0.4mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nbs { display: flex; flex-direction: column; margin-top: 2mm; }
.nb-r { display: grid; grid-template-columns: 54mm 1fr 34mm; gap: 2mm; align-items: center; padding: 0.4mm 0; border-bottom: 0.25mm solid var(--hair); }
.nb-r .g-num { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nb-r.own .g-n { color: var(--brand); font-weight: 700; }
.nb-r .track.mini { background-image: repeating-linear-gradient(90deg, transparent 0, transparent calc(12.5% - 0.25mm), var(--hair) calc(12.5% - 0.25mm), var(--hair) 12.5%), linear-gradient(90deg, var(--page) 0 25%, var(--win) 25% 79.1667%, var(--page) 79.1667%); }
.a-x { font-size: 7pt; color: var(--text); margin-top: 0.6mm; line-height: 1.3; }
.act .a-p { margin-top: 1.2mm; }
.act.ok .a-n { background: var(--ok); }
.partial { font-size: 6.8pt; color: var(--warn-ink); background: var(--warn-bg); border-radius: 2mm; padding: 1.4mm 3mm; }
`;
