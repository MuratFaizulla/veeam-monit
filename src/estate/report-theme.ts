/**
 * The PDF reports' palettes. Every colour the Repository and Job reports
 * paint is a variable from here; the sheets (`STYLE`, `JOB_STYLE`) and the
 * pages only name them. `REPORT_THEME` picks one: `indigo` (the default),
 * `graphite` or `blue`.
 *
 * What the three share: the four status tones, readable at the reports' small
 * sizes (a white glyph on every status fill holds 3:1), and load shown as one
 * hue from pale to deep rather than blue turning amber turning red, so colour
 * on a heat map means "how busy" and colour elsewhere means "how healthy".
 */

/** The status tones and neutrals every palette keeps. */
const BASE: Record<string, string> = {
  ink: '#0b1220',
  text: '#334155',
  muted: '#5b6b80',
  faint: '#7b8798',
  hint: '#cbd5e1',
  line: '#e2e8f0',
  hair: '#eef2f7',
  page: '#ffffff',
  panel: '#f8fafc',
  panel2: '#f1f5f9',

  crit: '#dc2626',
  'crit-bg': '#fef2f2',
  'crit-ink': '#991b1b',
  'crit-line': '#fecaca',
  'crit-pale': '#fecaca',
  warn: '#d97706',
  'warn-bg': '#fffbeb',
  'warn-ink': '#92400e',
  'warn-line': '#fde68a',
  'warn-pale': '#fde68a',
  ok: '#059669',
  'ok-bg': '#ecfdf5',
  'ok-ink': '#065f46',
  'ok-line': '#a7f3d0',
  unk: '#7b8798',
  'unk-bg': '#f8fafc',
  'unk-ink': '#475569',
  'unk-line': '#e2e8f0',

  used: '#334155',
  'hang-a': 'rgba(220, 38, 38, 0.8)',
  'hang-b': 'rgba(220, 38, 38, 0.22)',
  'old-a': '#cbd5e1',
  'old-b': '#e2e8f0',
};

/** What makes one palette itself: its accent, the load scale, the cover. */
interface Palette {
  /** The accent: section glyphs, «идёт» chips, the job's own row. */
  brand: string;
  /** A usual run on the 24-hour chart and a moved start. */
  brand2: string;
  'brand-soft': string;
  /** Borders around accent panels and the longest run's pale bar. */
  'brand-line': string;
  /** The backup window, 18:00–07:00, behind charts. */
  win: string;
  'win-line': string;
  /** Backups no job owns, in the capacity bar and ring. */
  orph: string;
  /** The cover's banner: its ground, the text on it, its quieter text. */
  'hero-bg': string;
  'hero-ink': string;
  'hero-sub': string;
  'hero-card': string;
  'hero-card-line': string;
  /** The four stages of a run, Source → Target, and the text on each. */
  'stage-source': string;
  'stage-source-ink': string;
  'stage-proxy': string;
  'stage-proxy-ink': string;
  'stage-network': string;
  'stage-network-ink': string;
  'stage-target': string;
  'stage-target-ink': string;
  /** A run under way, hatched. */
  'live-a': string;
  'live-b': string;
  /** Jobs writing at once, 0 to 10+: [ground, digits]. */
  heat: Array<[string, string]>;
}

const PALETTES: Record<string, Palette> = {
  indigo: {
    brand: '#4f46e5',
    brand2: '#6366f1',
    'brand-soft': '#eef2ff',
    'brand-line': '#c7d2fe',
    win: '#f5f3ff',
    'win-line': '#ddd6fe',
    orph: '#a78bfa',
    'hero-bg': '#1e1b4b',
    'hero-ink': '#ffffff',
    'hero-sub': '#c7d2fe',
    'hero-card': 'rgba(255, 255, 255, 0.07)',
    'hero-card-line': 'rgba(255, 255, 255, 0.16)',
    'stage-source': '#c7d2fe',
    'stage-source-ink': '#1e1b4b',
    'stage-proxy': '#a5b4fc',
    'stage-proxy-ink': '#1e1b4b',
    'stage-network': '#818cf8',
    'stage-network-ink': '#ffffff',
    'stage-target': '#4338ca',
    'stage-target-ink': '#ffffff',
    'live-a': 'rgba(99, 102, 241, 0.75)',
    'live-b': 'rgba(99, 102, 241, 0.22)',
    heat: [
      ['#f8fafc', 'transparent'],
      ['#eef2ff', '#3730a3'],
      ['#e0e7ff', '#3730a3'],
      ['#c7d2fe', '#312e81'],
      ['#a5b4fc', '#1e1b4b'],
      ['#818cf8', '#1e1b4b'],
      ['#6366f1', '#ffffff'],
      ['#4f46e5', '#ffffff'],
      ['#4338ca', '#ffffff'],
      ['#3730a3', '#ffffff'],
      ['#1e1b4b', '#ffffff'],
    ],
  },
  graphite: {
    brand: '#1e293b',
    brand2: '#475569',
    'brand-soft': '#f1f5f9',
    'brand-line': '#cbd5e1',
    win: '#f6f7f9',
    'win-line': '#e2e8f0',
    orph: '#a1a1aa',
    'hero-bg': '#0f172a',
    'hero-ink': '#ffffff',
    'hero-sub': '#cbd5e1',
    'hero-card': 'rgba(255, 255, 255, 0.06)',
    'hero-card-line': 'rgba(255, 255, 255, 0.14)',
    'stage-source': '#e2e8f0',
    'stage-source-ink': '#0f172a',
    'stage-proxy': '#cbd5e1',
    'stage-proxy-ink': '#0f172a',
    'stage-network': '#94a3b8',
    'stage-network-ink': '#0f172a',
    'stage-target': '#334155',
    'stage-target-ink': '#ffffff',
    'live-a': 'rgba(71, 85, 105, 0.75)',
    'live-b': 'rgba(71, 85, 105, 0.2)',
    heat: [
      ['#fafafa', 'transparent'],
      ['#f1f5f9', '#334155'],
      ['#e2e8f0', '#334155'],
      ['#cbd5e1', '#1e293b'],
      ['#94a3b8', '#0f172a'],
      ['#64748b', '#ffffff'],
      ['#475569', '#ffffff'],
      ['#334155', '#ffffff'],
      ['#1e293b', '#ffffff'],
      ['#0f172a', '#ffffff'],
      ['#020617', '#ffffff'],
    ],
  },
  blue: {
    brand: '#1d4ed8',
    brand2: '#3b82f6',
    'brand-soft': '#eff6ff',
    'brand-line': '#bfdbfe',
    win: '#f0f7ff',
    'win-line': '#dbeafe',
    orph: '#7dd3fc',
    'hero-bg': '#0b2a5b',
    'hero-ink': '#ffffff',
    'hero-sub': '#bfdbfe',
    'hero-card': 'rgba(255, 255, 255, 0.07)',
    'hero-card-line': 'rgba(255, 255, 255, 0.16)',
    'stage-source': '#dbeafe',
    'stage-source-ink': '#0b2a5b',
    'stage-proxy': '#93c5fd',
    'stage-proxy-ink': '#0b2a5b',
    'stage-network': '#3b82f6',
    'stage-network-ink': '#ffffff',
    'stage-target': '#1e3a8a',
    'stage-target-ink': '#ffffff',
    'live-a': 'rgba(59, 130, 246, 0.75)',
    'live-b': 'rgba(59, 130, 246, 0.22)',
    heat: [
      ['#f8fafc', 'transparent'],
      ['#eff6ff', '#1e3a8a'],
      ['#dbeafe', '#1e3a8a'],
      ['#bfdbfe', '#1e3a8a'],
      ['#93c5fd', '#0b2a5b'],
      ['#60a5fa', '#0b2a5b'],
      ['#3b82f6', '#ffffff'],
      ['#2563eb', '#ffffff'],
      ['#1d4ed8', '#ffffff'],
      ['#1e40af', '#ffffff'],
      ['#1e3a8a', '#ffffff'],
    ],
  },
};

export const THEMES = Object.keys(PALETTES);

/** The palette `REPORT_THEME` names, or indigo. */
const chosen = (): Palette => PALETTES[(process.env.REPORT_THEME ?? '').trim().toLowerCase()] ?? PALETTES.indigo;

/** How many steps the load scale has; 10 and more share the last. */
export const HEAT_STEPS = 11;

/** The `:root` block and the load scale's classes, `.h0` … `.h10`. */
export const themeCss = (): string => {
  const { heat, ...palette } = chosen();
  const vars = Object.entries({ ...BASE, ...palette })
    .map(([name, value]) => `--${name}: ${value};`)
    .join(' ');
  const steps = heat.map(([ground, digits], step) => `.h${step} { background: ${ground}; color: ${digits}; }`).join('\n');
  return `:root { ${vars} }\n${steps}\n`;
};
