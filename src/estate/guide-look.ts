import { escapeHtml as esc } from '../telegram/format';
import { VEEAM_LOGO } from './veeam-logo';

/**
 * The reports drawn the way Veeam's own User Guide is: an A4 page upright,
 * the first one under a green band with Veeam's logo in white, the title in
 * a light green under a thin rule, headings in the same green, tables with a
 * grey head and white words, and on every page after the first a line at the
 * foot with its number, what the document is and when it was read.
 *
 * The first page is named `cover` and has no margins, so the band reaches the
 * paper's edges; what is on it keeps to the margins by its own padding. The
 * pages after it have the margins and the foot line.
 */

/** Veeam's logo as the Guide's cover has it: drawn in white on the green. */
export const VEEAM_LOGO_WHITE = VEEAM_LOGO.replace('fill="#00D15F"', 'fill="none" stroke="#fff" stroke-width="2.4"').replace(/<path(?![^>]*fill=)/g, '<path fill="#fff"');

/**
 * The Guide's colours: its green, a grey for table heads, and the amber and coral the reports have always said trouble in.
 * A restore point as the Guide draws its files: a Full (.vbk) violet, an increment (.vib) green, and the older Fulls of a chain in lighter violets.
 */
export const GUIDE = {
  green: '#00b336', bright: '#00d15f', ink: '#1f1f1f', muted: '#5f5f5f', rule: '#c8c8c8', head: '#8c8c8c', warning: '#fe8a25', failed: '#e8403a',
  full: '#8e71f4', increment: '#00d15f', fullOlder: '#b3a0f7', fullOldest: '#d9cffb',
  // The Guide's dark green and its tints, for what is neutral: past, empty, not known. Its link blue for what is going on now.
  dark: '#005f4b', teal: '#639c90', tealSoft: '#a9c9c2', tealPale: '#c7dcd7', tealMist: '#e3edeb',
  link: '#00a7e2', linkPale: '#d9edfd',
} as const;

/** The band at the head of the first page, and the product line under the logo. */
export const guideBand = (product: string): string => `<div class="g-band">
<svg class="g-wave" viewBox="0 0 800 170" preserveAspectRatio="none"><path d="M380 0 L520 120 Q545 140 570 120 L700 0Z" fill="#fff" opacity=".13"/><path d="M560 0 L800 0 L800 150 Q700 175 640 120 L560 40Z" fill="#fff" opacity=".18"/><path d="M720 170 L800 170 L800 120Z" fill="#fff" opacity=".25"/></svg>
${VEEAM_LOGO_WHITE}<div class="g-product">Backup &amp; Replication · ${esc(product)}</div></div>`;

/** The foot line of the first page, which has no margin to hold it. */
export const guideFoot = (foot: string): string => `<div class="g-foot">1 | ${esc(foot)}</div>`;

/**
 * A string as CSS reads one between double quotes. `<` and `>` as CSS escapes
 * too: the string sits inside `<style>`, which a job named `</style>…` would
 * otherwise close.
 */
const cssString = (text: string): string =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3c ').replace(/>/g, '\\3e ').replace(/[\r\n]/g, ' ')}"`;

/**
 * The pages and the parts every report has. `foot` is the foot line after the
 * page's number: «Veeam Backup & Replication | Отчёт по заданию X | 12.11.2026 03:47».
 */
export const guideStyle = (foot: string): string => `
@page { size: 210mm 297mm; margin: 15mm 16mm 17mm;
  @bottom-left { content: counter(page) " | " ${cssString(foot)}; font: 300 7.5pt 'Inter Variable', sans-serif; color: #4a4a4a; vertical-align: top; padding-top: 4mm; } }
@page cover { margin: 0; @bottom-left { content: none; } }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; font-family: 'Inter Variable', 'Segoe UI', sans-serif; font-size: 8.8pt; line-height: 1.42; font-weight: 350; color: ${GUIDE.ink}; font-feature-settings: 'tnum' 1; }
.g-cover { page: cover; position: relative; height: 297mm; padding: 0 16mm; overflow: hidden; break-after: page; box-sizing: border-box; }
.g-band { position: relative; height: 36mm; margin: 0 -16mm; background: linear-gradient(100deg, ${GUIDE.green} 0%, ${GUIDE.bright} 70%, #3fe57f 100%); overflow: hidden; }
.g-wave { position: absolute; inset: 0; width: 100%; height: 100%; }
.g-band .veeam-logo { position: absolute; left: 16mm; top: 9mm; height: 8.6mm; width: auto; }
.g-product { position: absolute; left: 16mm; top: 20.5mm; color: #fff; font-weight: 450; font-size: 8.6pt; letter-spacing: 0.02em; }
.g-foot { position: absolute; left: 16mm; right: 16mm; bottom: 8mm; font-weight: 300; font-size: 7.5pt; color: #4a4a4a; }
.g-kicker { margin: 7mm 0 0.6mm; color: ${GUIDE.muted}; font-weight: 450; font-size: 8pt; letter-spacing: 0.08em; text-transform: uppercase; }
.g-title { margin: 0; color: ${GUIDE.green}; font-weight: 300; font-size: 26pt; line-height: 1.12; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.g-rule { border: 0; border-top: 0.25mm solid ${GUIDE.rule}; margin: 3.6mm 0 2.4mm; }
.g-meta { display: flex; flex-wrap: wrap; gap: 1mm 7mm; align-items: center; color: ${GUIDE.muted}; }
.g-meta .g-state { display: inline-flex; align-items: center; gap: 1.6mm; color: ${GUIDE.ink}; font-weight: 600; }
.g-h2, .g-panel h3 { margin: 5.5mm 0 2.2mm; color: ${GUIDE.green}; font-weight: 300; font-size: 15pt; line-height: 1.2; letter-spacing: -0.005em; break-after: avoid; }
.g-h2 small, .g-sub { color: ${GUIDE.muted}; font-size: 8.4pt; font-weight: 300; letter-spacing: 0; }
.g-table { width: 100%; border-collapse: collapse; }
.g-table th { background: ${GUIDE.head}; color: #fff; font-weight: 500; font-size: 8pt; text-align: left; padding: 1.9mm 2.6mm; border: 0.25mm solid ${GUIDE.head}; }
.g-table td { padding: 1.7mm 2.6mm; border: 0.25mm solid ${GUIDE.rule}; vertical-align: top; }
.g-table tr { break-inside: avoid; }
.g-spec td:first-child { width: 34%; font-weight: 600; }
.g-note { margin-top: 4.5mm; padding: 2.8mm 4mm; border-left: 0.9mm solid ${GUIDE.warning}; background: #fff3e8; font-size: 9.6pt; line-height: 1.38; }
.g-note.crit { border-left-color: ${GUIDE.failed}; background: #fdeceb; }
.g-note.ok { border-left-color: ${GUIDE.green}; background: #e6faef; }
.g-note.unknown { border-left-color: #adacaf; background: #f5f6f7; }
.g-note b { font-weight: 650; }
`;
