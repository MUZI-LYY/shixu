const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NOTCH_LLM_API_KEY;
delete env.DASHSCOPE_API_KEY;
env.TODO_TEST_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-workspace-check-'));
const root = path.resolve(__dirname, '..');
let code = 0;
for (const phase of ['actions', 'restart']) {
  const result = spawnSync(require('electron'), ['tests/assistant.electron.js'], { cwd: root, env: { ...env, VOICE_CHECK_PHASE: phase }, stdio: 'inherit', timeout: 90000 });
  if (result.status !== 0) { code = result.status || 1; break; }
}
fs.rmSync(env.TODO_TEST_USER_DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
process.exit(code);
