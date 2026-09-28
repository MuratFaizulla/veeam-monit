const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
require('reflect-metadata');

const { AppModule } = require('../dist/app.module');
const { VeeamModule } = require('../dist/veeam/veeam.module');
const { TelegramModule } = require('../dist/telegram/telegram.module');
const { EstateModule } = require('../dist/estate/estate.module');
const { LiveModule } = require('../dist/live/live.module');
const { MonitorModule } = require('../dist/monitor/monitor.module');
const { TelegramUpdatesModule } = require('../dist/updates/updates.module');
const { MONITOR } = require('../dist/monitor/monitor');

const importsOf = (module) =>
  (Reflect.getMetadata('imports', module) ?? []).map((imported) => imported.name).sort();

test('every module import points one way, and none points back', () => {
  // The whole service used to be one module because the ear and the monitor
  // needed each other. This is the list of edges that replaced it; an import
  // added in the other direction is the cycle coming back, and fails here
  // rather than as a forwardRef somebody reaches for later.
  assert.deepEqual(
    Object.fromEntries(
      [VeeamModule, TelegramModule, EstateModule, LiveModule, MonitorModule, TelegramUpdatesModule]
        .map((module) => [module.name, importsOf(module)]),
    ),
    {
      VeeamModule: [],
      TelegramModule: [],
      EstateModule: ['VeeamModule'],
      LiveModule: ['TelegramModule'],
      MonitorModule: ['EstateModule', 'LiveModule', 'TelegramModule'],
      TelegramUpdatesModule: ['MonitorModule', 'TelegramModule'],
    },
  );
});

test('the monitor module hands out the Monitor seam and nothing else', () => {
  assert.deepEqual(Reflect.getMetadata('exports', MonitorModule), [MONITOR]);
});

test('the whole application assembles', () => {
  // The unit tests build every class by hand, which says nothing about whether
  // Nest can: a provider left out of a module's exports compiles, passes every
  // test above, and fails only on startup. So the real AppModule is started,
  // in a child process and an empty directory — no .env of anybody's is read,
  // no bot token, no timer, no state file of the real service touched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam-app-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(TELEGRAM|VEEAM)_/.test(key)),
  );
  const root = path.resolve(__dirname, '..');
  const script = `
    require(${JSON.stringify(path.join(root, 'node_modules/reflect-metadata'))});
    const { NestFactory } = require(${JSON.stringify(path.join(root, 'node_modules/@nestjs/core'))});
    const { AppModule } = require(${JSON.stringify(path.join(root, 'dist/app.module'))});
    const { MONITOR } = require(${JSON.stringify(path.join(root, 'dist/monitor/monitor'))});
    const { TelegramUpdatesService } = require(${JSON.stringify(path.join(root, 'dist/updates/updates.service'))});
    const { TelegramLiveService } = require(${JSON.stringify(path.join(root, 'dist/live/live.service'))});
    (async () => {
      const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
      const monitor = app.get(MONITOR);
      const answer = [
        typeof monitor.check,
        Boolean(app.get(TelegramUpdatesService)),
        Boolean(app.get(TelegramLiveService)),
      ].join(',');
      await app.close();
      process.stdout.write(answer);
    })().catch((error) => { process.stderr.write(error.message); process.exit(1); });
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: dir,
      env: {
        ...env,
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_MONITOR_INTERVAL_MS: '0',
        TELEGRAM_STATE_FILE: path.join(dir, 'state.json'),
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(out, 'function,true,true');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(AppModule);
});

test('every import between folders points down the layers the modules are wired in', () => {
  // The Nest imports above can be clean while the files are not: a helper
  // imported across folders is invisible to Reflect metadata. That is how the
  // estate files came to import the live slots' formatter, and the state store
  // two files living in monitor/ and live/, while those modules imported them
  // back — cycles between folders the module graph could not see.
  //
  // Lower layers never import higher ones. Two files are vocabulary, named
  // here rather than inferred — the slot names and the notification kinds —
  // and any layer may use them, because they import nothing of ours.
  const LAYERS = [
    ['config', 'logging'],
    ['veeam', 'telegram'],
    ['estate'],
    ['live'],
    ['monitor'],
    ['updates', 'http'],
  ];
  const rank = new Map(LAYERS.flatMap((folders, index) => folders.map((folder) => [folder, index])));
  const src = path.resolve(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) files.push(full);
    }
  })(src);
  const fileImportsOf = (file) =>
    [...fs.readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)]
      .map((match) => path.resolve(path.dirname(file), match[1]) + '.ts');
  const folderOf = (file) => path.relative(src, file).split(path.sep)[0];
  const VOCABULARY = new Set(['live/slots.ts', 'telegram/types.ts'].map((file) => path.join(src, file)));
  for (const file of VOCABULARY) assert.deepEqual(fileImportsOf(file), [], `${file} is vocabulary and imports nothing`);

  const wrong = [];
  for (const file of files) {
    const from = folderOf(file);
    if (!rank.has(from)) {
      assert.ok(!file.slice(src.length + 1).includes(path.sep), `folder ${from} has no layer`);
      continue; // main.ts and app.module.ts wire everything
    }
    for (const target of fileImportsOf(file)) {
      const to = folderOf(target);
      if (to === from) continue;
      if (VOCABULARY.has(target)) continue;
      if (!rank.has(to) || rank.get(to) >= rank.get(from)) {
        wrong.push(`${path.relative(src, file)} -> ${path.relative(src, target)}`);
      }
    }
  }
  assert.deepEqual(wrong, [], 'импорт вверх по слоям или вбок');
});
