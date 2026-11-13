const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const DEFAULTS = Object.freeze({
  voice: { enabled: false, accelerator: 'Control+Alt+Space' },
  meeting: { enabled: false, accelerator: 'Control+Alt+R' },
});
const KEY_CODES = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9,
  B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29,
  O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46,
  Space: 49, F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Command'];
const MODIFIER_FLAGS = { Control: 1 << 18, Alt: 1 << 19, Shift: 1 << 17, Command: 1 << 20 };
function parseAccelerator(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('请输入修饰键加字母、数字、空格或 F1–F12');
  const parts = value.trim().split('+').map(part => part.trim());
  const keyRaw = parts.pop();
  const key = keyRaw?.toLowerCase() === 'space' ? 'Space' : keyRaw?.toUpperCase();
  const aliases = { command: 'Command', cmd: 'Command', commandorcontrol: platform === 'darwin' ? 'Command' : 'Control', control: 'Control', ctrl: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift' };
  const modifiers = parts.map(part => aliases[part.toLowerCase()]);
  if (!(key in KEY_CODES) || !modifiers.length || modifiers.some(part => !part) || new Set(modifiers).size !== modifiers.length || !modifiers.some(part => part !== 'Shift')) {
    throw new Error('请使用 ⌘、⌃ 或 ⌥ 搭配字母、数字、空格或 F1–F12，可再加 ⇧');
  }
  const ordered = MODIFIERS.filter(part => modifiers.includes(part));
  return { accelerator: [...ordered, key].join('+'), keyCode: KEY_CODES[key], flags: ordered.reduce((flags, part) => flags | MODIFIER_FLAGS[part], 0) };
}
function normalizeConfig(value, panelShortcut, platform = process.platform) {
  if (!value || typeof value !== 'object') throw new Error('快捷键配置无效');
  const result = {};
  for (const kind of ['voice', 'meeting']) {
    const item = value[kind];
    if (!item || typeof item.enabled !== 'boolean') throw new Error('快捷键配置无效');
    result[kind] = { enabled: item.enabled, accelerator: parseAccelerator(item.accelerator, platform).accelerator };
  }
  if (result.voice.enabled && result.meeting.enabled && result.voice.accelerator === result.meeting.accelerator) throw new Error('语音待办与会议录音不能使用同一个快捷键');
  let panel;
  try { panel = parseAccelerator(panelShortcut, platform).accelerator; } catch {}
  if (panel && Object.values(result).some(item => item.enabled && item.accelerator === panel)) throw new Error('该组合已用于唤出工作台，请换一组快捷键');
  return result;
}

function registerVoiceShortcuts({ app, ipcMain, globalShortcut, powerMonitor, getWindow, getPanelShortcut = () => 'Space', onAction, spawnProcess = spawn, fileSystem = fs, platform = process.platform, readyTimeoutMs = 5000 }) {
  const file = path.join(app.getPath('userData'), 'voice-shortcuts.json');
  let config = JSON.parse(JSON.stringify(DEFAULTS));
  let status = { voice: { state: 'disabled', error: '' }, meeting: { state: 'disabled', error: '' } };
  const watchers = new Set();
  let held = false;
  let closed = false;
  let busy = false;
  let initialized = false;
  let watcherGeneration = 0;
  const reserved = new Set();
  const pendingStarts = new Set();
  let stopGuard;
  const getState = () => ({ ok: true, config: JSON.parse(JSON.stringify(config)), status: JSON.parse(JSON.stringify(status)) });
  function send(channel, value) {
    const window = getWindow();
    if (window && !window.isDestroyed?.() && !window.webContents?.isDestroyed?.()) window.webContents?.send?.(channel, value);
  }
  function emitAction(action, reason = '') {
    // A renderer may disappear between an OS key event and delivery. Never let a
    // window teardown exception escape a native stdout listener into the main process.
    try {
      if (onAction) onAction({ action, reason });
      else send('voice-shortcuts:action', { action, reason });
    } catch {}
  }
  function changed() { try { send('voice-shortcuts:changed', getState()); } catch {} }
  function release(reason) {
    clearTimeout(stopGuard);
    if (held) { held = false; emitAction('voice-stop', reason); }
  }
  function stopResources(reason) {
    for (const cancel of pendingStarts) cancel();
    pendingStarts.clear();
    watcherGeneration += 1;
    release(reason);
    for (const watcher of watchers) watcher.kill();
    watchers.clear();
    for (const accelerator of reserved) globalShortcut.unregister(accelerator);
    reserved.clear();
  }
  function reserve(accelerator, callback) {
    let registered = false;
    try { registered = globalShortcut.register(accelerator, callback); } catch {}
    if (!registered) throw new Error(`快捷键 ${accelerator} 已被占用或不可用，请换一组`);
    reserved.add(accelerator);
  }
  async function activate(next) {
    status = { voice: { state: 'disabled', error: '' }, meeting: { state: 'disabled', error: '' } };
    if (Object.values(next).some(item => item.enabled) && platform !== 'darwin') throw new Error('录音全局快捷键目前仅支持 macOS');
    for (const kind of ['voice', 'meeting']) {
      if (!next[kind].enabled) continue;
      await activateWatcher(kind, next[kind]);
    }
  }
  async function activateWatcher(kind, shortcut) {
    // Reserve the combination so another app cannot handle it, while the listen-only
    // session tap observes both edges. Electron itself provides no key-up callback.
    // Use native edges for meetings too, so holding a key cannot repeatedly toggle recording.
    reserve(shortcut.accelerator, () => {});
    status[kind].state = 'starting';
    const spec = parseAccelerator(shortcut.accelerator, platform);
    const generation = watcherGeneration;
    await new Promise((resolve, reject) => {
      let settled = false;
      let child;
      const cancel = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('快捷键启动已取消')); } };
      pendingStarts.add(cancel);
      const fail = message => {
        if (generation !== watcherGeneration) return;
        const error = String(message || '按键监听已停止，请在设置中重新启用').slice(0, 300);
        release('listener-stopped');
        if (settled && kind === 'meeting') emitAction('stop-all', 'listener-stopped');
        status[kind] = { state: 'error', error };
        if (!settled) { settled = true; clearTimeout(timer); pendingStarts.delete(cancel); reject(new Error(error)); }
        else {
          // A dead listener must not leave a useless globally reserved key behind.
          if (reserved.delete(shortcut.accelerator)) globalShortcut.unregister(shortcut.accelerator);
          changed();
        }
      };
      const timer = setTimeout(() => { fail('按键监听未就绪，请检查输入监控权限后重新启用'); child?.kill(); }, readyTimeoutMs);
      try {
        child = spawnProcess(path.join(__dirname, '..', 'native', 'workspace-native'), ['voice-watch', String(spec.keyCode), String(spec.flags)], { stdio: ['ignore', 'pipe', 'ignore'] });
        watchers.add(child);
        const lines = createInterface({ input: child.stdout });
        child.once('error', () => fail('无法启动按键监听，请检查应用安装是否完整'));
        child.once('exit', () => { watchers.delete(child); lines.close(); fail(); });
        lines.on('line', line => {
          if (generation !== watcherGeneration || closed || line.length > 4096) return;
          let event;
          try { event = JSON.parse(line); } catch { return; }
          if (event.error) { fail(event.error); child.kill(); return; }
          if (event.event === 'ready' && !settled) {
            settled = true; clearTimeout(timer); pendingStarts.delete(cancel); status[kind] = { state: 'ready', error: '' }; resolve();
          } else if (event.event === 'down' && kind === 'meeting' && !busy && status[kind].state === 'ready') {
            emitAction('meeting-toggle');
          } else if (event.event === 'down' && kind === 'voice' && !held && !busy && status[kind].state === 'ready') {
            held = true; emitAction('voice-start');
            stopGuard = setTimeout(() => release('maximum-hold-duration'), 120000);
          } else if (event.event === 'up' && kind === 'voice') release('key-released');
        });
      } catch { fail('无法启动按键监听，请检查应用安装是否完整'); }
    });
  }
  async function setConfig(value) {
    if (closed) return { ok: false, error: '应用正在退出' };
    if (busy) return { ok: false, error: '正在应用快捷键设置，请稍后重试' };
    let next;
    try { next = normalizeConfig(value, getPanelShortcut(), platform); } catch (error) { return { ...getState(), ok: false, error: error.message }; }
    const old = config;
    busy = true;
    stopResources('configuration-changed');
    try {
      await activate(next);
      if (closed) throw new Error('应用正在退出');
      fileSystem.mkdirSync(path.dirname(file), { recursive: true });
      fileSystem.writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      fileSystem.renameSync(`${file}.tmp`, file);
      config = next;
      return getState();
    } catch (error) {
      stopResources('configuration-failed');
      if (closed) return { ok: false, error: '应用正在退出' };
      let restoreError = '';
      try { await activate(old); } catch (restore) {
        stopResources('restore-failed');
        restoreError = `；旧快捷键也未恢复：${restore.message}`;
        for (const kind of ['voice', 'meeting']) if (old[kind].enabled) status[kind] = { state: 'error', error: restore.message };
      }
      return { ...getState(), ok: false, error: error.message + restoreError };
    } finally { busy = false; changed(); }
  }
  function hasConflict(accelerator) {
    let canonical;
    try { canonical = parseAccelerator(accelerator, platform).accelerator; } catch { return false; }
    return Object.values(config).some(item => item.enabled && item.accelerator === canonical);
  }
  function stopForSystem(reason) { release(reason); emitAction('stop-all', reason); }
  const onSuspend = () => stopForSystem('system-sleep');
  const onLock = () => stopForSystem('screen-locked');
  function dispose() {
    if (closed) return;
    stopForSystem('application-quit'); closed = true;
    stopResources('application-quit');
    powerMonitor?.removeListener('suspend', onSuspend);
    powerMonitor?.removeListener('lock-screen', onLock);
  }
  async function initialize() {
    if (initialized || closed) return;
    initialized = true;
    try {
      if (fileSystem.existsSync(file)) config = normalizeConfig(JSON.parse(fileSystem.readFileSync(file, 'utf8')), getPanelShortcut(), platform);
    } catch { config = JSON.parse(JSON.stringify(DEFAULTS)); }
    busy = true;
    try { await activate(config); } catch (error) {
      stopResources('initialization-failed');
      for (const kind of ['voice', 'meeting']) if (config[kind].enabled) status[kind] = { state: 'error', error: error.message };
    } finally { busy = false; changed(); }
    if (closed) return;
    powerMonitor?.on('suspend', onSuspend);
    powerMonitor?.on('lock-screen', onLock);
  }
  const own = event => event.sender === getWindow()?.webContents;
  ipcMain.handle('voice-shortcuts:get', event => own(event) ? getState() : { ok: false, error: 'invalid_sender' });
  ipcMain.handle('voice-shortcuts:set', (event, payload) => own(event) ? setConfig(payload) : { ok: false, error: 'invalid_sender' });
  app.once('will-quit', dispose);
  const ready = app.whenReady().then(initialize);
  return { getState, setConfig, hasConflict, dispose, ready };
}
module.exports = { registerVoiceShortcuts, normalizeConfig, parseAccelerator, DEFAULTS };
