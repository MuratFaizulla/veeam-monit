// One file per folder of src/, plus the two live renderers that already had
// their own. Running a single file no longer means running a quarter of the
// suite without noticing — use `npm test`.
require('./telegram.test.cjs');
require('./commands.test.cjs');
require('./monitor.test.cjs');
require('./live.test.cjs');
require('./live-performance.test.cjs');
require('./live-repositories.test.cjs');
require('./veeam.test.cjs');
require('./architecture.test.cjs');
