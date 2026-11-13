const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerVoiceShortcuts, normalizeConfig, parseAccelerator, DEFAULTS } = require('../main/voice-shortcuts');
const configured = () => ({ voice: { enabled: true, accelerator: 'Control+Alt+Space' }, meeting: { enabled: true, accelerator: 'Control+Alt+R' } });
function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shixu-hotkey-test-'));
  const app = new EventEmitter(); app.getPath = () => dir; app.whenReady = () => Promise.resolve();
  const powerMonitor = new EventEmitter();
  const actions = [], updates = [], children = [], registrations = new Map(), handlers = new Map();
  const sender = { send: (channel, payload) => updates.push({ channel, payload }) };
  const blocked = new Set();
  let deny = false, autoReady = true;
  const service = registerVoiceShortcuts({
    app, ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, powerMonitor,
    globalShortcut: {
      register: (name, cb) => { if (blocked.has(name) || registrations.has(name)) return false; registrations.set(name, cb); return true; },
      unregister: name => registrations.delete(name),
    },
    getWindow: () => ({ webContents: sender }), getPanelShortcut: () => options.panel || 'Space',
    onAction: action => actions.push(action), platform: 'darwin', readyTimeoutMs: 200,
    spawnProcess: (_path, args) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.args = args; child.killed = false;
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
      child.event = event => child.stdout.write(JSON.stringify(event) + '\n');
      children.push(child);
      if (autoReady) queueMicrotask(() => child.event(deny ? { error: '需要输入监控权限' } : { event: 'ready' }));
      return child;
    },
  });
  t.after(() => { service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { service, dir, app, powerMonitor, actions, updates, children, registrations, handlers, sender, blocked, deny: () => { deny = true; }, stall: () => { autoReady = false; } };
}
test('normalizes aliases, maps native key codes, rejects modifier-only and unsafe bindings', () => {
  assert.deepEqual(parseAccelerator('Option+Cmd+v', 'darwin'), { accelerator: 'Alt+Command+V', keyCode: 9, flags: (1 << 19) | (1 << 20) });
  assert.equal(parseAccelerator('CommandOrControl+Shift+R', 'darwin').accelerator, 'Shift+Command+R');
  for (const binding of ['V', 'Shift+V', 'Control', 'Control+Alt', 'Cmd+Command+V', 'Command+;']) assert.throws(() => parseAccelerator(binding));
});
test('rejects conflicts between the two functions and with the panel, including aliases', () => {
  const value = configured(); value.meeting.accelerator = 'Option+Ctrl+Space';
  assert.throws(() => normalizeConfig(value, 'Space', 'darwin'), /同一个/);
  assert.throws(() => normalizeConfig(configured(), 'Option+Control+R', 'darwin'), /唤出/);
});
test('disabled defaults do not start listeners or reserve keys; IPC rejects other senders', async t => {
  const h = harness(t); await h.service.ready;
  assert.deepEqual(h.service.getState().config, DEFAULTS);
  assert.equal(h.children.length, 0); assert.equal(h.registrations.size, 0);
  assert.equal(h.handlers.get('voice-shortcuts:set')({ sender: {} }, configured()).error, 'invalid_sender');
});
test('press/release drives voice, meetings use press edges, settings persist, and suspend stops recordings', async t => {
  const h = harness(t); await h.service.ready;
  const result = await h.service.setConfig(configured());
  assert.equal(result.ok, true); assert.equal(result.status.voice.state, 'ready'); assert.equal(result.status.meeting.state, 'ready');
  assert.equal(h.service.hasConflict('Option+Control+Space'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'voice-shortcuts.json'))), configured());
  h.children[0].event({ event: 'down' }); h.children[0].event({ event: 'down' }); h.children[0].event({ event: 'up' });
  h.children[1].event({ event: 'down' }); h.children[1].event({ event: 'up' });
  assert.deepEqual(h.actions.map(a => a.action), ['voice-start', 'voice-stop', 'meeting-toggle']);
  h.powerMonitor.emit('suspend'); assert.equal(h.actions.at(-1).action, 'stop-all');
  h.service.dispose(); assert.equal(h.registrations.size, 0); assert.ok(h.children.every(child => child.killed));
});
test('occupied new binding rolls back to working old configuration without changing saved settings', async t => {
  const h = harness(t); await h.service.ready; await h.service.setConfig(configured());
  h.blocked.add('Control+Alt+T');
  const next = configured(); next.meeting.accelerator = 'Control+Alt+T';
  const result = await h.service.setConfig(next);
  assert.equal(result.ok, false); assert.match(result.error, /占用/);
  assert.deepEqual(result.config, configured()); assert.equal(result.status.voice.state, 'ready'); assert.equal(h.registrations.size, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'voice-shortcuts.json'))), configured());
});
test('permission failure keeps defaults and releases registered combinations', async t => {
  const h = harness(t); await h.service.ready; h.deny();
  const result = await h.service.setConfig(configured());
  assert.equal(result.ok, false); assert.match(result.error, /输入监控/);
  assert.deepEqual(result.config, DEFAULTS); assert.equal(h.registrations.size, 0);
});
test('listener death releases an active hold and reports error', async t => {
  const h = harness(t); await h.service.ready; await h.service.setConfig(configured());
  h.children[0].event({ event: 'down' }); h.children[0].emit('exit', 1);
  assert.equal(h.actions.at(-1).action, 'voice-stop');
  assert.equal(h.service.getState().status.voice.state, 'error');
  assert.equal(h.registrations.has('Control+Alt+Space'), false);
});
test('quit during listener startup cancels the pending configuration and releases keys', async t => {
  const h = harness(t); await h.service.ready; h.stall();
  const pending = h.service.setConfig(configured());
  h.service.dispose();
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(h.registrations.size, 0);
});

test('listener startup timeout rolls back and releases the reserved combination', async t => {
  const h = harness(t); await h.service.ready; h.stall();
  const result = await h.service.setConfig(configured());
  assert.equal(result.ok, false); assert.match(result.error, /未就绪/);
  assert.equal(h.registrations.size, 0); assert.deepEqual(result.config, DEFAULTS);
});
test('a second settings request during activation is rejected without corrupting the first', async t => {
  const h = harness(t); await h.service.ready; h.stall();
  const first = h.service.setConfig(configured());
  const second = await h.service.setConfig(DEFAULTS);
  assert.equal(second.ok, false); assert.match(second.error, /正在应用/);
  h.service.dispose(); await first;
});
