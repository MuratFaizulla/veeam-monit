// The README's pictures, drawn by the bot's own code from an invented estate (./estate.cjs).
//
//   npm run build && node scripts/screenshots/shoot.cjs
//
// The bot is run as the tests run it (test/world.cjs), with its clock set to one
// night, against a Veeam that answers from estate.cjs: two passes of the monitor
// fill the live topics and raise two alerts, then /menu, /job, the job's report,
// /points, /repos and /calendar are asked in General. What it would send to Telegram is set
// in a Telegram-like window, light and dark; the first page of each PDF is shown
// as it prints. Everything lands in docs/assets/screenshots.
//
// Needs Chrome or Chromium: BROWSER, or REPORT_BROWSER, or google-chrome on PATH.

const RealDate = Date;
const FIXED = RealDate.parse(process.env.SHOTS_AT || '2026-11-12T03:47:00+05:00');
const started = RealDate.now();
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED + (RealDate.now() - started));
  }
  static now() {
    return FIXED + (RealDate.now() - started);
  }
};

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Logger } = require('@nestjs/common');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'assets', 'screenshots');
const BROWSER = process.env.BROWSER || process.env.REPORT_BROWSER || 'google-chrome';
const W = require(path.join(ROOT, 'test', 'world.cjs'));
const { encode } = require(path.join(ROOT, 'dist', 'updates', 'keyboard'));
const { estateAt } = require('./estate.cjs');

Logger.overrideLogger(false);
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * What the bot says
 * ------------------------------------------------------------------ */

async function said() {
  const estate = estateAt(Date.now());
  const w = W.world({
    VEEAM_SERVERS: 'https://veeam01.example.com:9419',
    TELEGRAM_TIMEZONE: 'Asia/Qyzylorda',
    TELEGRAM_ROUTING_MODE: 'single',
    TELEGRAM_LIVE: 'true',
    TELEGRAM_LIVE_ORPHANS: 'true',
    TELEGRAM_REPOSITORY_FREE_PERCENT: '10',
    REPORT_SITES: 'Site 1=SITE1_*,Site 2=SITE2_*',
  });
  const veeam = { baseUrl: 'https://veeam01.example.com:9419', request: async (req) => estate.request(req), reachability: W.VeeamHttpService.prototype.reachability };
  const server = W.serverOf(w, veeam, W.monitorAccount({ username: 'svc-veeam-monitor@example.com' }));
  const printer = W.printerOf();
  const { monitor, answers } = W.watching(w, [server], printer);
  const { updates } = W.ear(w, monitor, answers);
  const forum = { id: Number(W.CHAT), type: 'supergroup', is_forum: true };
  const typed = (text) => updates.handleUpdate({ update_id: 1, message: { message_id: 50, message_thread_id: 1, is_topic_message: true, text, chat: forum } });
  const pressed = (data) => updates.handleUpdate({ update_id: 2, callback_query: { id: 'cb', data, message: { message_id: 60, message_thread_id: 1, is_topic_message: true, chat: forum } } });

  // The first pass knows the SQL job as it was before tonight; the second sees it fail.
  estate.lastResultOf = (job) => (job.id === 'j2' ? 'Success' : undefined);
  await server.evidence.refresh(true, await server.reader.jobStates());
  await monitor.check();
  estate.lastResultOf = () => undefined;
  await monitor.check();
  await settle(400);

  const topics = {};
  const created = w.api.of('createForumTopic').map((payload, index) => ({ name: payload.name, thread: 101 + index }));
  for (const call of w.api.calls) {
    if (!['sendMessage', 'editMessageText'].includes(call.method)) continue;
    const topic = created.find((candidate) => candidate.thread === call.payload.message_thread_id);
    (topics[topic ? topic.name : 'General'] ??= []).push(call.payload.text);
  }

  // Asked one by one: the bot answers one read in five seconds.
  const answered = {};
  const ask = async (key, act) => {
    await settle(5200);
    w.api.reset();
    await act();
    await settle(2500);
    answered[key] = w.api.calls
      .filter((call) => ['sendMessage', 'sendDocument'].includes(call.method))
      .map((call) => ({ method: call.method, text: call.payload.text ?? call.payload.caption, markup: call.payload.reply_markup }));
  };
  await ask('menu', () => typed('/menu'));
  await ask('job', () => typed('/job billing'));
  await ask('report', () => pressed(encode({ kind: 'report', id: 'j1', server: server.key })));
  await ask('points', () => typed('/points chemplant'));
  await ask('repos', () => typed('/repos'));
  await ask('calendar', () => typed('/calendar'));

  if (estate.unknown.size) throw new Error(`The estate does not answer ${[...estate.unknown].join(', ')}`);
  if (printer.pages.length !== 4) throw new Error(`Expected four reports printed, got ${printer.pages.length}`);
  const [job, points, repositories, calendar] = printer.pages.map(String);
  return { topics, order: created.map((topic) => topic.name), answered, reports: { job, points, repositories, calendar } };
}

/* ------------------------------------------------------------------ *
 * A Telegram-like window, light and dark
 * ------------------------------------------------------------------ */

const THEMES = {
  light: { page: '#ffffff', chat: '#c9d9e4', side: '#ffffff', head: '#ffffff', line: '#e6ebef', text: '#000000', dim: '#8b98a5', bubble: '#ffffff', mine: '#effdde', mineTime: '#62ac55', name: '#3a8e5a', button: 'rgba(76, 106, 128, 0.42)', key: '#ffffff', keyText: '#000000', keyShadow: '0 1px 2px rgba(0,0,0,.18)', link: '#2481cc', code: '#f1f1f1', codeBar: '#3a8bd1', active: '#419fd9', pill: 'rgba(76, 106, 128, 0.5)', input: '#ffffff' },
  dark: { page: '#0e1621', chat: '#0e1621', side: '#17212b', head: '#17212b', line: '#0b121a', text: '#f5f5f5', dim: '#708499', bubble: '#182533', mine: '#2b5278', mineTime: '#7da8d3', name: '#6ab3f3', button: 'rgba(43, 82, 120, 0.55)', key: '#2b5278', keyText: '#ffffff', keyShadow: 'none', link: '#6ab3f3', code: '#11202d', codeBar: '#6ab3f3', active: '#2b5278', pill: 'rgba(30, 44, 58, 0.85)', input: '#17212b' },
};

const styleOf = (t) => `
@import url('${'file://' + path.join(ROOT, 'node_modules/@fontsource-variable/inter/index.css')}');
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: ${t.page}; font-family: 'Inter Variable', 'Noto Color Emoji', sans-serif; color: ${t.text}; font-size: 15px; line-height: 1.32; -webkit-font-smoothing: antialiased; }
.win { display: flex; overflow: hidden; border-radius: 12px; }
.chatcol { flex: 1; display: flex; flex-direction: column; min-width: 0; background: ${t.chat}; }
.head { background: ${t.head}; padding: 12px 18px; border-bottom: 1px solid ${t.line}; }
.head b { font-size: 16px; font-weight: 600; display: block; } .head span { color: ${t.dim}; font-size: 13.5px; }
.msgs { flex: 1; padding: 14px 16px 12px; display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: flex-end; gap: 8px; } .row.mine { justify-content: flex-end; }
.ava { width: 34px; height: 34px; border-radius: 50%; background: #3fa45b; color: #fff; font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: center; flex: none; }
.col { display: flex; flex-direction: column; gap: 3px; max-width: 100%; min-width: 0; }
.bubble { background: ${t.bubble}; border-radius: 12px; padding: 7px 11px 6px; white-space: pre-wrap; overflow-wrap: anywhere; box-shadow: 0 1px 1px rgba(0,0,0,.08); }
.mine .bubble { background: ${t.mine}; }
.from { color: ${t.name}; font-weight: 600; font-size: 14px; margin-bottom: 1px; white-space: normal; } .from small { color: ${t.dim}; font-weight: 400; margin-left: 6px; font-size: 13px; }
.time { float: right; color: ${t.dim}; font-size: 12px; margin: 6px 0 -4px 12px; } .mine .time { color: ${t.mineTime}; }
.bubble b { font-weight: 650; }
.bubble code, .bubble pre { font-family: 'DejaVu Sans Mono', monospace; font-size: 13.5px; }
.bubble pre { background: ${t.code}; border-left: 3px solid ${t.codeBar}; border-radius: 4px; padding: 6px 9px; margin: 3px 0; white-space: pre; }
.bubble a, .cmd { color: ${t.link}; text-decoration: none; }
.buttons { display: flex; flex-direction: column; gap: 3px; } .buttons div { display: flex; gap: 3px; }
.buttons span { flex: 1; background: ${t.button}; color: #fff; text-align: center; border-radius: 8px; padding: 8px 6px; font-weight: 600; font-size: 14px; white-space: nowrap; }
.pill { align-self: center; background: ${t.pill}; color: #fff; border-radius: 12px; padding: 3px 11px; font-size: 13.5px; font-weight: 500; margin: 2px 0 4px; }
.input { background: ${t.input}; border-top: 1px solid ${t.line}; padding: 13px 18px; color: ${t.dim}; display: flex; gap: 14px; align-items: center; } .input .grow { flex: 1; }
.keys { background: ${t.input}; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 6px; } .keys div { display: flex; gap: 6px; }
.keys span { flex: 1; background: ${t.key}; color: ${t.keyText}; box-shadow: ${t.keyShadow}; border-radius: 8px; text-align: center; padding: 10px; }
.side { width: 330px; background: ${t.side}; border-right: 1px solid ${t.line}; flex: none; }
.group { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-bottom: 1px solid ${t.line}; }
.group .gava { width: 44px; height: 44px; border-radius: 50%; background: #4f8fd6; color: #fff; font-weight: 600; font-size: 20px; display: flex; align-items: center; justify-content: center; }
.group b { font-weight: 600; font-size: 15.5px; display: block; } .group span { color: ${t.dim}; font-size: 13.5px; }
.topic { display: flex; gap: 12px; align-items: center; padding: 9px 14px; }
.topic .ic { width: 28px; text-align: center; font-size: 22px; color: ${t.dim}; flex: none; } .topic .tx { flex: 1; min-width: 0; }
.topic .t1 { display: flex; justify-content: space-between; } .topic .t1 b { font-weight: 600; } .topic .t1 small { color: ${t.dim}; font-size: 12.5px; }
.topic .t2 { color: ${t.dim}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
.topic.on { background: ${t.active}; } .topic.on b, .topic.on .t2, .topic.on small, .topic.on .ic { color: #fff; }
.panels > .chatcol { border-right: 1px solid ${t.line}; } .panels > .chatcol:last-child { border-right: none; }
`;

const bubble = (html, { mine = false, time = '03:47', buttons } = {}) => `
<div class="row${mine ? ' mine' : ''}">${mine ? '' : '<div class="ava">VM</div>'}<div class="col">
<div class="bubble">${mine ? `<span class="cmd">${html}</span>` : `<div class="from">Veeam Monitor<small>bot</small></div>${html}`}<span class="time">${time}${mine ? ' ✓✓' : ''}</span></div>
${buttons ? `<div class="buttons">${buttons.map((row) => `<div>${row.map((button) => `<span>${button.text}</span>`).join('')}</div>`).join('')}</div>` : ''}
</div></div>`;
const head = (title, sub = 'Backup Ops') => `<div class="head"><b>${title}</b><span>${sub}</span></div>`;
const input = (placeholder = 'Сообщение') => `<div class="input"><span>📎</span><span class="grow">${placeholder}</span><span>🙂</span></div>`;
const firstLine = (html) => html.split('\n')[0].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const windows = (bot) => {
  const last = (topic) => bot.topics[topic].at(-1);
  const reply = (key, method = 'sendMessage') => bot.answered[key].filter((answer) => answer.method === method).at(-1);
  return {
    overview: { width: 980, body: () => {
      const names = ['General', ...bot.order];
      const preview = (name) => (name === 'General' ? '🤖 Меню Veeam Monitor' : firstLine(last(name)));
      return `<div class="win"><div class="side"><div class="group"><div class="gava">B</div><div><b>Backup Ops</b><span>${names.length} тем · 14 участников</span></div></div>
${names.map((name) => { const [icon, ...rest] = name === 'General' ? ['#', 'General'] : name.split(' '); return `<div class="topic${name === '🚨 Alerts' ? ' on' : ''}"><div class="ic">${icon}</div><div class="tx"><div class="t1"><b>${rest.join(' ')}</b><small>03:47</small></div><div class="t2">${preview(name)}</div></div></div>`; }).join('')}
</div><div class="chatcol">${head('🚨 Alerts')}<div class="msgs"><div class="pill">12 ноября</div>${bot.topics['🚨 Alerts'].map((text) => bubble(text)).join('')}</div>${input()}</div></div>`;
    } },
    live: { width: 1440, body: () => `<div class="win panels">${['▶️ Running now', '🛡 Protection', '💾 Repositories'].map((name) => `<div class="chatcol">${head(name, 'Backup Ops · обновляется само')}<div class="msgs">${bubble(last(name))}</div></div>`).join('')}</div>` },
    job: { width: 660, body: () => {
      const card = reply('job');
      return `<div class="win"><div class="chatcol">${head('General')}<div class="msgs">${bubble('/job billing', { mine: true, time: '03:48' })}${bubble(card.text, { time: '03:48', buttons: card.markup.inline_keyboard })}</div>${input()}</div></div>`;
    } },
    menu: { width: 600, body: () => {
      const menu = reply('menu');
      return `<div class="win"><div class="chatcol">${head('General')}<div class="msgs">${bubble(menu.text, { time: '03:50' })}</div>${input(menu.markup.input_field_placeholder)}<div class="keys">${menu.markup.keyboard.map((row) => `<div>${row.map((key) => `<span>${key.text}</span>`).join('')}</div>`).join('')}</div></div></div>`;
    } },
  };
};

/* ------------------------------------------------------------------ *
 * Taking the pictures
 * ------------------------------------------------------------------ */

const chrome = (args, options = {}) =>
  execFileSync(BROWSER, ['--headless', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars', '--virtual-time-budget=4000', ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', ...options });

/** `html` as a PNG `width` wide and as tall as it is, at `scale`. */
const picture = (dir, name, html, width, scale = 2) => {
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, html.replace('</body>', '<script>setTimeout(() => { const p = document.createElement("pre"); p.id = "h"; p.textContent = document.getElementById("shot").getBoundingClientRect().height; document.body.appendChild(p); }, 600);</script></body>'));
  const height = Math.ceil(Number(/<pre id="h">([\d.]+)<\/pre>/.exec(chrome([`--window-size=${width},4000`, '--dump-dom', `file://${file}`]))[1]));
  fs.writeFileSync(file, html);
  const png = path.join(OUT, `${name}.png`);
  chrome([`--force-device-scale-factor=${scale}`, '--default-background-color=00000000', `--window-size=${width},${height}`, `--screenshot=${png}`, `file://${file}`]);
  return `${name}.png ${width}×${height}`;
};

/**
 * The pictures down to 256 colours, as the README has always kept them: a
 * fifth of the size, and nothing a reader would miss. Done by Pillow where
 * python3 has it; without it they stay as the browser took them.
 */
const SHRINK = `
import sys
from PIL import Image
for name in sys.argv[1:]:
    image = Image.open(name)
    # Pillow before 9.1 has the methods as plain numbers: MEDIANCUT 0, FASTOCTREE 2, no dither 0.
    method = getattr(Image, 'Quantize', None)
    fast, median = (method.FASTOCTREE, method.MEDIANCUT) if method else (2, 0)
    dither = Image.Dither.NONE if hasattr(Image, 'Dither') else 0
    quantized = image.quantize(256, method=fast) if image.mode == 'RGBA' else image.convert('RGB').quantize(256, method=median, dither=dither)
    quantized.save(name, optimize=True)
`;
const shrink = () => {
  const pictures = fs.readdirSync(OUT).filter((name) => name.endsWith('.png')).map((name) => path.join(OUT, name));
  try {
    execFileSync('python3', ['-I', '-c', SHRINK, ...pictures], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    console.warn(`Left at full size: ${String(error.stderr || error.message).trim().split('\n').pop()}`);
  }
};

(async () => {
  const bot = await said();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam-shots-'));
  try {
    for (const [name, screen] of Object.entries(windows(bot))) {
      for (const [theme, colours] of Object.entries(THEMES)) {
        const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styleOf(colours)} body { width: ${screen.width}px; }</style></head><body><div id="shot">${screen.body()}</div></body></html>`;
        console.log(picture(dir, `${name}-${theme}`, html, screen.width));
      }
    }
    // A report's first page as it prints — the Job report and the Points report A4 upright, the Repository report and the Calendar landscape — in a frame that reads on a light page and a dark one.
    for (const [name, report] of Object.entries(bot.reports)) {
      const page = path.join(dir, `${name}-page.html`);
      fs.writeFileSync(page, report);
      const [w, h] = name === 'repositories' || name === 'calendar' ? [1123, 794] : [794, 1123];
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>body { margin: 0; background: transparent; width: ${w + 48}px; } #shot { padding: 24px; } .sheet { width: ${w}px; height: ${h}px; border-radius: 10px; overflow: hidden; box-shadow: 0 0 0 1px rgba(0,0,0,.14), 0 6px 22px rgba(0,0,0,.22); } iframe { border: 0; display: block; }</style></head><body><div id="shot"><div class="sheet"><iframe src="file://${page}" width="${w}" height="${h}"></iframe></div></div></body></html>`;
      console.log(picture(dir, `report-${name}`, html, w + 48, 1.5));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  shrink();
  process.exit(0);
})().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
