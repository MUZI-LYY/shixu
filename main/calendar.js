const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ERROR_MESSAGES = {
  calendar_permission_denied: '请在系统设置 → 隐私与安全性 → 日历中允许拾序访问，然后重试。',
  calendar_unavailable: '没有可写的日历账户，请先在 Mac 日历中添加或启用一个日历。',
  calendar_not_writable: '所选日历已移除或不可写，请重新选择日历。',
  calendar_ownership_mismatch: '原日历事件已不再属于这条待办，已停止修改。',
  calendar_event_missing: '关联日历事件已被删除，未自动重建。请先在 Mac 日历中确认。',
  calendar_duplicate_events: '发现多条关联日历事件，请先在 Mac 日历中检查，避免重复安排。',
  calendar_write_failed: '日历保存失败，请检查日历账户连接后重试。',
  calendar_invalid_payload: '日历内容或时间无效，请检查安排。',
};
function validateSave(value) {
  if (!value || value.confirmed !== true) throw new Error('请先确认日历安排。');
  const { taskId, title, start, end } = value;
  if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 256) throw new Error('待办标识无效。');
  if (typeof title !== 'string' || !title.trim() || title.length > 500) throw new Error('请填写 1—500 字的日历标题。');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < Date.UTC(2001, 0, 1) || end > Date.UTC(2101, 0, 1) || end <= start || end - start > 366 * 86400000) throw new Error('请设置有效的开始和结束时间，单次安排最长一年。');
  if (value.allDay !== undefined && typeof value.allDay !== 'boolean') throw new Error('全天选项无效。');
  if (value.calendarId !== undefined && (typeof value.calendarId !== 'string' || value.calendarId.length > 1024)) throw new Error('日历标识无效。');
  return { taskId, title: title.trim(), start, end, allDay: value.allDay === true, calendarId: value.calendarId || '' };
}
function invokeNative(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(__dirname, '..', 'native', 'workspace-native'), ['calendar-command'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('日历响应超时，请检查系统授权后重试。')); }, 60000);
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.length > 2 * 1024 * 1024) { child.kill(); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error('无法读取日历响应，请重试。')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
function createCalendarService({ storageDir, native = invokeNative }) {
  const file = path.join(storageDir, 'shixu-calendar-links.json');
  let queue = Promise.resolve();
  async function readState() {
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state.version !== 1 || typeof state.scope !== 'string' || !state.links || typeof state.links !== 'object' || Array.isArray(state.links)) throw new Error('invalid_state');
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('日历关联记录无法读取。为避免重复创建，已停止写入。');
      return { version: 1, scope: crypto.randomUUID(), links: {} };
    }
  }
  async function persist(state) {
    await fs.mkdir(storageDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  async function save(payload) {
    const value = validateSave(payload);
    const state = await readState();
    const key = crypto.createHash('sha256').update(value.taskId).digest('hex');
    const previous = state.links[key] || {};
    const marker = `shixu://task/${state.scope}/${key}`;
    // Persist intent before calling EventKit. Retrying after a crash can locate the
    // event by its marker and attempted date even if the identifier was not saved.
    const lookupStarts = [...new Set([...(previous.lookupStarts || []), previous.start, value.start].filter(Number.isFinite))];
    state.links[key] = { ...previous, lookupStarts };
    await persist(state);
    const result = await native({ action: 'save', ...value, marker, eventId: previous.eventId || '', lookupStarts });
    if (!result?.ok) return readableResult(result);
    if (typeof result.eventId !== 'string' || !result.eventId) throw new Error('日历返回的关联标识无效，请重试。');
    state.links[key] = { eventId: result.eventId, calendarId: result.calendarId, start: value.start, lookupStarts: [value.start] };
    await persist(state);
    return result;
  }
  return {
    list: async () => readableResult(await native({ action: 'list' })),
    save(payload) {
      const task = queue.then(() => save(payload));
      queue = task.catch(() => {});
      return task;
    },
  };
}
function readableResult(result) {
  if (result?.ok) return result;
  return { ok: false, code: result?.error || 'calendar_write_failed', error: ERROR_MESSAGES[result?.error] || '日历操作失败，请检查权限与账户后重试。' };
}
function registerCalendar({ ipcMain, getWindow, storageDir, beginInteraction = () => {}, endInteraction = () => {}, native }) {
  const service = createCalendarService({ storageDir, native });
  let interactions = 0, permissionWindow, restoreTop = false;
  for (const action of ['list', 'save']) {
    ipcMain.handle(`calendar:${action}`, async (event, payload) => {
      if (event.sender !== getWindow()?.webContents) return { ok: false, error: 'invalid_sender' };
      if (process.platform !== 'darwin' && !native) return { ok: false, error: 'Apple 日历仅在 macOS 可用。' };
      beginInteraction();
      // The panel normally floats above other windows. Let the system's calendar
      // permission dialog become visible, including concurrent list/save requests.
      if (interactions++ === 0) {
        permissionWindow = getWindow();
        restoreTop = permissionWindow?.isAlwaysOnTop?.() === true;
        if (restoreTop) permissionWindow.setAlwaysOnTop(false);
      }
      try { return await service[action](payload); }
      catch (error) { return { ok: false, error: error.message || '日历操作失败。' }; }
      finally {
        if (--interactions === 0 && restoreTop && permissionWindow && !permissionWindow.isDestroyed?.()) permissionWindow.setAlwaysOnTop(true, 'screen-saver');
        endInteraction();
      }
    });
  }
  return service;
}
module.exports = { registerCalendar, createCalendarService, validateSave };
