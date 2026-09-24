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
const { EstateModule } = require('../dist/monitor/estate.module');
const { LiveModule } = require('../dist/live/live.module');
const { MonitorModule } = require('../dist/monitor/monitor.module');
const { TelegramUpdatesModule } = require('../dist/telegram/updates.module');
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
      LiveModule: ['EstateModule', 'TelegramModule', 'VeeamModule'],
      MonitorModule: ['EstateModule', 'LiveModule', 'TelegramModule', 'VeeamModule'],
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
    const { TelegramUpdatesService } = require(${JSON.stringify(path.join(root, 'dist/telegram/updates.service'))});
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
