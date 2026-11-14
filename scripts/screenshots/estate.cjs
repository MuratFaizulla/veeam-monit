// An invented Veeam estate for the README's pictures: every job, machine, host and repository is made up.
// estateAt(now) answers the bot's requests as a Veeam B&R REST API would, relative to `now`.

const OFF = 5 * 3600e3; // the estate's local time is UTC+5, the bot's TELEGRAM_TIMEZONE
const DAY = 86400e3;
const GB = 1024 ** 3;

const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function estateAt(now) {
  const localDay = (ms) => new Date(ms + OFF).toISOString().slice(0, 10);
  const weekday = (ms) => WEEK[new Date(ms + OFF).getUTCDay()];
  const iso = (ms) => `${new Date(ms + OFF).toISOString().slice(0, 19)}+05:00`;
  const bare = (ms) => new Date(ms + OFF).toISOString().slice(0, 23); // a task session's time, without its offset
  const at = (daysAgo, hhmm) => Date.parse(`${localDay(now - daysAgo * DAY)}T${hhmm}:00+05:00`);
  const hhmm = (ms) => new Date(ms + OFF).toISOString().slice(11, 16);
  const span = (ms) => `${pad(Math.floor(ms / 3600e3))}:${pad(Math.floor(ms / 60e3) % 60)}:${pad(Math.floor(ms / 1e3) % 60)}`;

  const repositories = [
    { id: 'r1', name: 'SITE1_NAS_BKP01', type: 'Smb', hostName: 'nas01.example.com', path: '\\\\nas01.example.com\\SITE1_NAS_BKP01', capacityGB: 122880, freeGB: 21606 },
    { id: 'r2', name: 'SITE1_NAS_BKP02', type: 'Smb', hostName: 'nas01.example.com', path: '\\\\nas01.example.com\\SITE1_NAS_BKP02', capacityGB: 81920, freeGB: 3891 },
    { id: 'r3', name: 'SITE1_SSD_BKP03', type: 'WinLocal', hostName: 'repo01.example.com', path: 'E:\\Backups\\SITE1_SSD_BKP03', capacityGB: 20480, freeGB: 8397 },
    { id: 'r4', name: 'SITE2_NAS_BKP01', type: 'Nfs', hostName: 'nas02.example.com', path: 'nas02.example.com:/vol/SITE2_NAS_BKP01', capacityGB: 204800, freeGB: 112640 },
  ];
  const proxies = [
    { id: 'p1', name: 'proxy01.example.com', type: 'ViProxy' },
    { id: 'p2', name: 'proxy02.example.com', type: 'ViProxy' },
    { id: 'p3', name: 'proxy03.example.com', type: 'ViProxy' },
  ];

  // The SQL job failed a few minutes ago and Veeam is about to retry it.
  const sqlStart = now - 44 * 60e3;
  const sqlEnd = now - 3 * 60e3;
  const vm = (name, sizeGB, change = 0.04, host = 'vc01.example.com') => ({ name, sizeGB, change, host });
  const jobs = [
    { id: 'j1', name: 'OPS_Billing_Prod', time: '01:00', days: WEEK, full: ['sunday'], repo: 'r1', keep: 28,
      vms: [vm('billing-db01', 2400, 0.06), vm('billing-app01', 600), vm('billing-app02', 600), vm('billing-web01', 180)],
      bottleneck: 'Target', healed: [3, 11, 19], warned: [8] },
    { id: 'j2', name: 'OPS_SQL_Nightly', time: hhmm(sqlStart), days: WEEK, full: ['sunday'], repo: 'r2', keep: 14,
      vms: [vm('sql01', 1800, 0.08), vm('sql02', 1200, 0.07), vm('app01', 300)], bottleneck: 'Source', failedNow: true },
    { id: 'j3', name: 'CUST_FINHUB', time: '21:00', days: WEEK, full: ['saturday'], repo: 'r2', keep: 14,
      vms: [vm('finhub-db01', 900, 0.05, 'vc02.example.com'), vm('finhub-app01', 250, 0.03, 'vc02.example.com')], bottleneck: 'Network', failingFor: 4 },
    { id: 'j4', name: 'CUST_CHEMPLANT', time: '20:00', days: WEEK, full: ['saturday'], repo: 'r1', keep: 21,
      vms: [vm('chem-db01', 1100, 0.05, 'vc02.example.com'), vm('chem-app01', 420, 0.03, 'vc02.example.com'), vm('chem-hist01', 900, 0.06, 'vc02.example.com')],
      bottleneck: 'Target', missedFull: 'latest', healed: [5, 16] },
    { id: 'j5', name: 'OPS_FileServer', time: '23:30', days: WEEK, full: ['saturday'], repo: 'r1', keep: 14,
      vms: [vm('fs01', 7200, 0.02)], bottleneck: 'Source', running: 0.64 },
    { id: 'j6', name: 'CUST_HOUSING_1', time: hhmm(now - 17 * 60e3), days: WEEK, full: ['sunday'], repo: 'r4', keep: 14,
      vms: [vm('housing-db01', 700, 0.04, 'vc02.example.com'), vm('housing-web01', 120, 0.02, 'vc02.example.com')], bottleneck: 'Network', running: 0.23 },
    { id: 'j7', name: 'OPS_Exchange', time: '22:00', days: WEEK, full: ['saturday'], repo: 'r1', keep: 14,
      vms: [vm('mbx01', 2600, 0.03), vm('mbx02', 2600, 0.03)], bottleneck: 'Target' },
    { id: 'j8', name: 'OPS_DC', time: '02:00', days: WEEK, full: ['sunday'], repo: 'r3', keep: 30,
      vms: [vm('dc01', 120, 0.01), vm('dc02', 120, 0.01)], bottleneck: 'Source' },
    { id: 'j9', name: 'CUST_RETAIL', time: '19:00', days: WEEK.slice(1, 6), full: ['friday'], repo: 'r4', keep: 14,
      vms: [vm('retail-db01', 800, 0.05, 'vc02.example.com'), vm('retail-pos01', 200, 0.02, 'vc02.example.com')], bottleneck: 'Network' },
    { id: 'j10', name: 'OPS_Monitoring', time: '04:00', days: WEEK, full: ['sunday'], repo: 'r3', keep: 14,
      vms: [vm('mon01', 300, 0.06), vm('mon-db01', 500, 0.07)], bottleneck: 'Source', warned: [0] },
    { id: 'j11', name: 'CUST_LOGISTICS', time: '00:30', days: WEEK, full: ['sunday'], repo: 'r4', keep: 14,
      vms: [vm('logi-app01', 400, 0.03, 'vc02.example.com'), vm('logi-db01', 650, 0.05, 'vc02.example.com')], bottleneck: 'Network' },
    { id: 'j12', name: 'OPS_Web_DMZ', time: '05:00', days: WEEK, full: ['sunday'], repo: 'r3', keep: 7,
      vms: [vm('web-dmz01', 80, 0.02), vm('web-dmz02', 80, 0.02)], bottleneck: 'Source' },
    { id: 'j13', name: 'OPS_Archive', time: '06:00', days: [], full: [], repo: 'r2', keep: 90, disabled: true,
      vms: [vm('archive01', 4000, 0.01)], bottleneck: 'Target' },
  ];

  const sessions = []; const tasks = {}; const taskLogs = {}; const points = []; const files = {}; const backups = [];
  const VDDK = 'Failed to open VDDK disk [[DATASTORE01] sql01/sql01_1.vmdk] ( is read-only mode - [true] ) / Failed to open disk for read.';

  // A job whose newest scheduled Full ran as an increment: the 🛡 topic's «пропущен Full».
  for (const job of jobs) {
    if (job.missedFull !== 'latest') continue;
    for (let daysAgo = 0; daysAgo < 8; daysAgo += 1) {
      const start = at(daysAgo, job.time);
      if (start <= now && job.full.includes(weekday(start))) { job.missedFull = daysAgo; break; }
    }
  }
  for (const job of jobs) {
    const random = rng(job.id.length * 7919 + job.name.length * 31);
    const backupId = `b-${job.id}`;
    backups.push({ id: backupId, name: job.name, jobId: job.id, creationTime: iso(now - 200 * DAY), repositoryId: job.repo, platformName: 'VMware' });
    files[backupId] = [];
    if (job.disabled) continue;
    for (let daysAgo = 35; daysAgo >= 0; daysAgo -= 1) {
      const start = at(daysAgo, job.time);
      if (start > now || !job.days.includes(weekday(start))) continue;
      const day = localDay(start).replace(/-/g, '');
      const isFull = job.full.includes(weekday(start)) && job.missedFull !== daysAgo;
      const failedForGood = job.failingFor && daysAgo < job.failingFor;
      const firstFails = (job.healed || []).includes(daysAgo) || failedForGood || (job.failedNow && daysAgo === 0);
      const attempts = failedForGood ? 4 : firstFails && !(job.failedNow && daysAgo === 0) ? 2 : 1;
      const running = job.running && daysAgo === (job.time > hhmm(now) ? 1 : 0) ? job.running : undefined;
      let at0 = start;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const id = `${job.id}-${day}-a${attempt}`;
        const fails = attempt < attempts || failedForGood || (job.failedNow && daysAgo === 0);
        const warned = !fails && (job.warned || []).includes(daysAgo);
        const machineTasks = []; const runPoints = []; let t = at0 + 40e3; let read = 0; let sent = 0;
        job.vms.forEach((machine, index) => {
          const machineFails = fails && (index === 0 || failedForGood);
          const machineWarns = (warned && index === job.vms.length - 1) || (job.failedNow && daysAgo === 0 && machine.name === 'app01');
          const readGB = isFull ? machine.sizeGB * (0.92 + random() * 0.05) : machine.sizeGB * machine.change * (0.6 + random() * 0.8);
          const rate = (job.bottleneck === 'Target' ? 110 : 160) * (0.8 + random() * 0.4); // MB/s
          const took = machineFails ? (job.failedNow && daysAgo === 0 ? sqlEnd - sqlStart - 90e3 : 70e3 + random() * 60e3) : Math.max(120e3, (readGB * 1024 / rate) * 1e3);
          const begin = t + index * 15e3; const end = running ? undefined : begin + took;
          const taskId = `${id}-t${index + 1}`;
          const message = machineFails
            ? job.failedNow && daysAgo === 0 ? VDDK : failedForGood ? 'Cannot complete login due to an incorrect user name or password.' : 'Getting VM info from vSphere\nError: Cannot get service content.'
            : machineWarns ? job.failedNow ? 'Unable to truncate SQL Server transaction logs.' : 'Unable to truncate Microsoft SQL Server transaction logs. Details: Not enough permissions.' : 'Success';
          const done = machineFails ? 0 : readGB * GB;
          machineTasks.push({
            id: taskId, sessionId: id, name: machine.name, type: 'Backup', state: running ? 'Working' : 'Stopped',
            status: machineFails ? 'Failed' : machineWarns ? 'Warning' : 'Success',
            algorithm: machineFails ? 'None' : isFull ? 'Full' : 'Increment',
            creationTime: bare(begin), ...(end ? { endTime: bare(end) } : {}),
            result: running ? { result: 'None' } : { result: machineFails ? 'Failed' : machineWarns ? 'Warning' : 'Success', message },
            progress: { duration: span(Math.min(took, (running ? now - begin : took))), processingRate: `${Math.round(rate)} MB/s`, bottleneck: job.bottleneck,
              processedSize: machineFails ? 0 : machine.sizeGB * GB, readSize: done, transferredSize: done * 0.38 },
          });
          const busy = { Source: [92, 14, 9, 21], Proxy: [35, 88, 12, 30], Network: [28, 16, 86, 33], Target: [21, 12, 9, 89] }[job.bottleneck];
          const disks = machine.sizeGB > 1000 ? 3 : machine.sizeGB > 300 ? 2 : 1;
          const log = [
            { status: 'Succeeded', title: 'Queued for processing', startTime: iso(begin - 5e3), updateTime: iso(begin - 5e3) },
            { status: 'Succeeded', title: `Using gateway ${job.repo === 'r4' ? 'gw02.example.com' : 'gw01.example.com'} for repository ${repositories.find((r) => r.id === job.repo).name}`, startTime: iso(begin), updateTime: iso(begin) },
            { status: 'Succeeded', title: 'Creating VM snapshot', startTime: iso(begin + 20e3), updateTime: iso(begin + 23e3) },
            ...Array.from({ length: disks }, (_, disk) => ({ status: 'Succeeded', title: `Using backup proxy ${proxies[(index + disk) % 2].name} for disk Hard disk ${disk + 1} [${disk === disks - 1 && disks > 1 && job.id === 'j1' && index === 0 ? 'nbd' : 'hotadd'}]`, startTime: iso(begin + 40e3), updateTime: iso(begin + 80e3) })),
          ];
          if (machineFails) log.push({ status: 'Failed', title: `Error: ${message.split('\n').pop()}`, startTime: iso(begin + took - 5e3), updateTime: iso(begin + took) });
          else if (!running) log.push(
            { status: 'Succeeded', title: 'Removing VM snapshot', startTime: iso(begin + took - 30e3), updateTime: iso(begin + took - 24e3) },
            ...(machineWarns ? [{ status: 'Warning', title: message, startTime: iso(begin + took - 20e3), updateTime: iso(begin + took - 20e3) }] : []),
            { status: 'Succeeded', title: `Busy: Source ${busy[0]}% > Proxy ${busy[1]}% > Network ${busy[2]}% > Target ${busy[3]}%`, startTime: iso(begin + took), updateTime: iso(begin + took) },
            { status: 'Succeeded', title: `Primary bottleneck: ${job.bottleneck}`, startTime: iso(begin + took), updateTime: iso(begin + took) },
          );
          taskLogs[taskId] = log;
          if (!machineFails && !running) {
            const pointId = `${id}-p${index + 1}`;
            runPoints.push(pointId);
            points.push({ id: pointId, name: machine.name, backupId, sessionId: id, creationTime: iso(begin + 25e3), type: isFull ? 'Full' : 'Increment' });
          }
          read += done; sent += done * 0.38;
        });
        const ended = running ? undefined : Math.max(...machineTasks.map((task) => Date.parse(`${task.endTime}+05:00`)));
        const result = running ? 'None' : machineTasks.some((task) => task.status === 'Failed') ? 'Failed' : machineTasks.some((task) => task.status === 'Warning') ? 'Warning' : 'Success';
        const failedNames = machineTasks.filter((task) => task.status === 'Failed').map((task) => task.name);
        sessions.push({
          id, jobId: job.id, name: `${job.name}${isFull ? ' (Full)' : ''}${attempt > 1 ? ` (Retry ${attempt - 1})` : ''}`.replace(') (', ', '),
          sessionType: 'BackupJob', state: running ? 'Working' : 'Stopped', creationTime: iso(at0), ...(ended ? { endTime: iso(ended) } : {}),
          progressPercent: running ? Math.round(running * 100) : 100,
          result: { result, message: result === 'Failed' ? `Processing ${failedNames[0]} Error: ${machineTasks.find((task) => task.status === 'Failed').result.message.split('\n').pop()}` : result === 'Warning' ? 'Job finished with warning' : '' },
        });
        tasks[id] = machineTasks;
        if (runPoints.length) {
          const dataSize = read; const backupSize = isFull ? read * 0.58 : read * 0.31;
          files[backupId].push({ id: `${id}-f`, name: `${job.name}D${day}T${job.time.replace(':', '')}00_${id.slice(-4).toUpperCase()}.${isFull ? 'vbk' : 'vib'}`, restorePointIds: runPoints, dataSize, backupSize, dedupRatio: 1.3, compressRatio: 1.9, creationTime: iso(at0) });
        }
        if (ended) at0 = ended + 10 * 60e3;
      }
    }
  }

  // Retention: whole chains older than the job's days are gone, as Veeam removes them.
  for (const job of jobs) {
    const backupId = `b-${job.id}`;
    const mine = points.filter((point) => point.backupId === backupId).sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime));
    const edge = now - job.keep * DAY;
    const oldestKept = mine.filter((point) => Date.parse(point.creationTime) < edge && point.type === 'Full')[0];
    const cut = oldestKept ? Date.parse(oldestKept.creationTime) - 60e3 : edge;
    for (const point of mine) if (Date.parse(point.creationTime) < cut) points.splice(points.indexOf(point), 1);
    files[backupId] = files[backupId].filter((file) => file.restorePointIds.some((id) => points.some((point) => point.id === id)));
  }
  // A backup its job was deleted from under: the 🧹 topic's and the Repository report's.
  backups.push({ id: 'b-legacy', name: 'OPS_Legacy_ERP', jobId: 'j-gone', creationTime: iso(now - 400 * DAY), repositoryId: 'r2', platformName: 'VMware' });
  for (const [n, name] of ['erp-db01', 'erp-app01'].entries()) {
    points.push({ id: `legacy-${n}`, name, backupId: 'b-legacy', sessionId: `legacy-s${n}`, creationTime: iso(now - 214 * DAY), type: 'Full' });
  }
  files['b-legacy'] = [{ id: 'legacy-f', name: 'OPS_Legacy_ERPD2026-04-14T013000_7A1B.vbk', restorePointIds: ['legacy-0', 'legacy-1'], dataSize: 6.1 * 1024 * GB, backupSize: 3.4 * 1024 * GB, creationTime: iso(now - 214 * DAY) }];

  const newest = (job) => sessions.filter((s) => s.jobId === job.id).sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime));
  const nextRun = (job) => {
    for (let ahead = 0; ahead <= 8; ahead += 1) {
      const t = at(-ahead, job.time);
      if (t > now && job.days.includes(weekday(t))) return iso(t);
    }
    return undefined;
  };
  const jobStates = (lastResultOf = () => undefined) => jobs.map((job) => {
    const [last] = newest(job).filter((s) => s.state === 'Stopped');
    const working = newest(job).find((s) => s.state === 'Working');
    return {
      id: job.id, name: job.name, type: 'Backup', status: job.disabled ? 'Disabled' : working ? 'Working' : 'Stopped',
      lastRun: (working ?? last) ? (working ?? last).creationTime : undefined,
      lastResult: lastResultOf(job) ?? (working ? 'None' : last ? last.result.result : 'None'),
      nextRun: job.disabled ? undefined : nextRun(job), objectsCount: job.vms.length,
    };
  });
  const configuration = (job) => ({
    id: job.id, name: job.name, type: 'Backup', isDisabled: Boolean(job.disabled),
    description: `Created by EXAMPLE\\backup-admin at ${localDay(now - 400 * DAY).split('-').reverse().join('.')} 10:00.`,
    schedule: {
      runAutomatically: !job.disabled,
      daily: { isEnabled: job.days.length > 0, dailyKind: job.days.length === 7 ? 'Everyday' : job.days.length === 5 ? 'WeekDays' : 'SelectedDays', localTime: job.time, days: job.days },
      monthly: { isEnabled: false }, periodically: { isEnabled: false }, continuously: { isEnabled: false },
      retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 },
    },
    storage: {
      backupRepositoryId: job.repo, backupProxies: { autoSelectEnabled: true, proxyIds: [] },
      retentionPolicy: { type: 'Days', quantity: job.keep },
      advancedSettings: { backupModeType: 'Incremental', activeFulls: { isEnabled: job.full.length > 0, weekly: { isEnabled: job.full.length > 0, days: job.full } } },
    },
    virtualMachines: { includes: job.vms.map((machine) => ({ name: machine.name, hostName: machine.host, type: 'VirtualMachine', platform: 'VMware', size: `${(machine.sizeGB / 1024).toFixed(1).replace('.', ',')} TB` })), excludes: { vms: [] } },
  });

  const page = (items, params = {}) => {
    const skip = Number(params.skip ?? 0); const limit = Number(params.limit ?? 100);
    return { data: items.slice(skip, skip + limit), pagination: { total: items.length, count: Math.min(limit, Math.max(0, items.length - skip)), skip, limit } };
  };
  const ordered = (list) => [...list].sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime));

  return {
    jobs, sqlEnd,
    unknown: new Set(),
    lastResultOf: () => undefined,
    request(req) {
      const params = req.params ?? {}; const path = req.path;
      if (path === '/api/v1/serverTime') return { serverTime: iso(now) };
      if (path === '/api/v1/jobs/states') return page(jobStates(this.lastResultOf), params);
      if (path === '/api/v1/jobs') return page(jobs.map(configuration), params);
      let m;
      if ((m = /^\/api\/v1\/jobs\/([^/]+)$/.exec(path))) return configuration(jobs.find((job) => job.id === decodeURIComponent(m[1])));
      if (path === '/api/v1/sessions') {
        let list = ordered(sessions);
        if (params.jobIdFilter) list = list.filter((s) => s.jobId === params.jobIdFilter);
        if (params.stateFilter) list = list.filter((s) => s.state === params.stateFilter);
        if (params.createdAfterFilter) list = list.filter((s) => Date.parse(s.creationTime) > Date.parse(params.createdAfterFilter));
        return page(list, params);
      }
      if ((m = /^\/api\/v1\/sessions\/([^/]+)\/taskSessions$/.exec(path))) return page(tasks[decodeURIComponent(m[1])] ?? [], params);
      if ((m = /^\/api\/v1\/sessions\/([^/]+)\/logs$/.exec(path))) {
        const id = decodeURIComponent(m[1]); const session = sessions.find((s) => s.id === id);
        const records = (tasks[id] ?? []).map((task) => ({ status: task.status === 'Failed' ? 'Failed' : task.status === 'Warning' ? 'Warning' : 'Succeeded', title: `Processing ${task.name}`, startTime: `${task.creationTime}+05:00`, updateTime: task.endTime ? `${task.endTime}+05:00` : undefined }));
        if (session && session.endTime) records.push({ status: session.result.result === 'Failed' ? 'Failed' : 'Succeeded', title: `Job finished with ${session.result.result === 'Success' ? 'success' : session.result.result === 'Warning' ? 'warning' : 'error'} at ${session.endTime}`, startTime: session.endTime, updateTime: session.endTime });
        return { records };
      }
      if ((m = /^\/api\/v1\/taskSessions\/([^/]+)\/logs$/.exec(path))) return { records: taskLogs[decodeURIComponent(m[1])] ?? [] };
      if (path === '/api/v1/backups') return page(backups, params);
      if ((m = /^\/api\/v1\/backups\/([^/]+)\/backupFiles$/.exec(path))) return page(ordered(files[decodeURIComponent(m[1])] ?? []), params);
      if (path === '/api/v1/restorePoints') return page(ordered(points), params);
      if (path === '/api/v1/backupInfrastructure/repositories/states') return page(repositories.map((r) => ({ ...r, usedSpaceGB: r.capacityGB - r.freeGB, isOnline: true })), params);
      if (path === '/api/v1/backupInfrastructure/repositories') return page(repositories.map(({ id, name, type }) => ({ id, name, type })), params);
      if (path === '/api/v1/backupInfrastructure/proxies') return page(proxies, params);
      this.unknown.add(path);
      return { data: [] };
    },
  };
}

module.exports = { estateAt, OFF };
