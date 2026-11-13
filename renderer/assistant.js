(() => {
  const Domain = window.VoiceDomain;
  const Tasks = window.VoiceTasks;
  const api = window.notchAPI;
  if (!Domain || !Tasks) return;
  const $ = id => document.getElementById(id);
  const JOURNAL_KEY = 'voice-operation-history-v1';
  let journal;
  try { journal = JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]'); } catch { journal = []; }
  if (!Array.isArray(journal)) journal = [];
  let plan = [];
  let busy = false;
  let voiceRecording = false;
  let voiceStarting = false;
  let holdRequested = false;
  let voiceSource = null;
  let voiceLimit;
  let voiceStopRequested = false;
  let recentIds = journal.filter(entry => !entry.undone).slice(0, 1).map(entry => entry.id);
  let view = 'tasks';
  let ocrBusy = false;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(text, handler, className = '') {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  }
  function status(text, error = false, target = 'voice-status') {
    $(target).textContent = text;
    $(target).dataset.error = String(error);
  }
  function showView(name) {
    view = name;
    ['tasks', 'plan', 'history'].forEach(key => { $(`voice-${key}`).hidden = key !== name; });
    document.querySelectorAll('[data-voice-view]').forEach(element => element.classList.toggle('selected', element.dataset.voiceView === name));
    if (name === 'history') renderHistory();
  }
  function formatDate(item) {
    if (!item.deadline) return '无截止时间';
    const options = { month: 'numeric', day: 'numeric' };
    if (item.datePrecision !== 'day') { options.hour = '2-digit'; options.minute = '2-digit'; }
    return new Intl.DateTimeFormat('zh-CN', options).format(new Date(item.deadline));
  }
  function signature(item) {
    if (!item) return '';
    return JSON.stringify([item.text, item.done, item.deadline || '', item.datePrecision || 'time', item.durationMinutes || 0, item.category]);
  }
  function appendEmpty(target, title, description) {
    const empty = node('div', 'voice-empty');
    empty.append(node('strong', '', title), node('span', '', description));
    target.append(empty);
    return empty;
  }
  function renderTasks() {
    const container = $('voice-tasks');
    container.replaceChildren();
    const tasks = Tasks.list().filter(task => !task.done).sort((a, b) => (Date.parse(a.deadline) || Infinity) - (Date.parse(b.deadline) || Infinity));
    $('voice-task-count').textContent = tasks.length;
    if (!tasks.length) {
      const empty = appendEmpty(container, '还没有待办', '输入一句话，或打开待办页手动添加。');
      empty.append(button('试试“明天交房租；后天买牛奶”', () => { $('voice-input').value = '明天交房租；后天买牛奶'; $('voice-input').focus(); }, 'voice-example'));
      return;
    }
    const categories = Tasks.categories();
    tasks.slice(0, 50).forEach(task => {
      const row = node('div', 'voice-task-row');
      const check = button('', async () => {
        try { await execute({ action: 'complete', target: task.id }, task); status(`已完成「${task.text}」，可在操作记录撤销`); }
        catch (error) { status(error.message, true); }
      }, 'voice-task-check');
      check.setAttribute('aria-label', `完成 ${task.text}`);
      const copy = node('div');
      copy.append(node('strong', '', task.text), node('small', '', categories[task.category] || task.category));
      const date = node('time', task.deadline && Date.parse(task.deadline) < Date.now() ? 'overdue' : '', formatDate(task));
      if (task.deadline) date.dateTime = task.deadline;
      row.append(check, copy, date, button('日历', () => window.Shixu?.openCalendar(task), 'voice-text-button')); 
      container.append(row);
    });
  }
  function saveJournal(next) {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(next.slice(0, 60)));
    journal = next.slice(0, 60);
  }
  async function persist() {
    const result = await Tasks.flush();
    if (result === false || result?.ok === false) status('已保存到应用，工作区备份暂未成功，请稍后重试', true);
  }
  async function execute(op, expected) {
    if (op.applied) throw new Error('这条操作已经执行');
    const snapshot = Tasks.snapshot();
    const category = expected?.category || op.category || 'P3';
    let previous = null;
    let after;
    if (op.action === 'create') {
      if (Tasks.list().some(item => !item.done && item.text === op.text)) throw new Error('已有同名待办，请先检查，避免重复创建');
      after = { id: crypto.randomUUID(), text: op.text, done: false, createdAt: Date.now(), remindedAt: 0,
        ...Domain.deadlineFields(op.date), durationMinutes: op.durationMinutes || 0 };
      snapshot[category].push(after);
    } else {
      const index = snapshot[category].findIndex(item => item.id === expected?.id);
      if (index < 0) throw new Error('任务已被删除，请重新查询');
      previous = { ...snapshot[category][index] };
      if (signature({ ...previous, category }) !== signature(expected)) throw new Error('任务已发生变化，请重新理解这句话');
      if (op.action === 'update' && !op.date && !op.text) throw new Error('请明确要修改的时间或标题');
      let date = op.date;
      if (date?.length === 10 && previous.datePrecision === 'time' && previous.deadline) {
        const old = new Date(previous.deadline);
        date += `T${String(old.getHours()).padStart(2, '0')}:${String(old.getMinutes()).padStart(2, '0')}`;
      }
      after = { ...previous,
        ...(op.action === 'complete' ? { done: true } : {}),
        ...(op.text ? { text: op.text } : {}),
        ...(date ? { ...Domain.deadlineFields(date), remindedAt: 0 } : {}),
        ...(op.durationMinutes ? { durationMinutes: op.durationMinutes } : {}) };
      snapshot[category][index] = after;
    }
    const entry = { transactionId: crypto.randomUUID(), id: after.id, category, action: op.action, before: previous, after, createdAt: Date.now(), undone: false };
    // Journal first. A crash before the task write leaves a harmless non-matching undo entry.
    saveJournal([entry, ...journal]);
    try { Tasks.commit(snapshot); }
    catch (error) { saveJournal(journal.filter(item => item.transactionId !== entry.transactionId)); throw error; }
    op.applied = true;
    recentIds = [after.id];
    await persist();
    renderTasks();
    return entry;
  }
  async function undo(entry) {
    const snapshot = Tasks.snapshot();
    const list = snapshot[entry.category];
    const index = list.findIndex(item => item.id === entry.id);
    if (index < 0 || signature({ ...list[index], category: entry.category }) !== signature({ ...entry.after, category: entry.category })) {
      throw new Error('任务在这次操作后又有变化，请先查看当前任务');
    }
    if (entry.before) list[index] = { ...entry.before };
    else list.splice(index, 1);
    Tasks.commit(snapshot);
    entry.undone = true;
    saveJournal(journal);
    recentIds = [];
    await persist();
    renderTasks(); renderHistory();
  }
  function renderHistory() {
    const container = $('voice-history'); container.replaceChildren();
    if (!journal.length) { appendEmpty(container, '还没有操作记录', '通过首页完成的事务会保留在这里，支持逐条撤销。'); return; }
    journal.forEach(entry => {
      const row = node('div', 'voice-history-row'); const copy = node('div');
      const names = { create: '新增', update: '修改', complete: '完成' };
      copy.append(node('strong', '', `${names[entry.action]} · ${entry.after.text}`), node('small', '', `${new Date(entry.createdAt).toLocaleString('zh-CN')} · ${entry.undone ? '已撤销' : formatDate(entry.after)}`));
      row.append(copy);
      if (!entry.undone) row.append(button('撤销', async () => {
        try { await undo(entry); status('已撤销该操作'); }
        catch (error) { status(error.message, true); }
      }));
      container.append(row);
    });
  }
  async function loadCalendar(start, end) {
    const result = await api.readCalendar({ start, end });
    if (!result?.ok) throw new Error(result?.error === 'calendar_permission_denied' ? '日历权限未授予，请在系统设置中允许访问' : result?.error || '日历读取失败');
    return result.events;
  }
  async function checkSlots(op, card, actions) {
    const date = op.date?.slice(0, 10);
    if (!date) { card.append(node('p', '', '请补充要安排的日期，然后重新理解。')); return; }
    const start = new Date(`${date}T00:00:00`).getTime();
    const end = start + 86400000;
    actions.replaceChildren(node('span', '', '正在读取日历并检查空闲时间…'));
    try {
      const events = await loadCalendar(start, end);
      const tasks = Tasks.list().filter(task => task.id !== op.selected?.id);
      const slots = Domain.findSlots(date, op.durationMinutes || 60, events, tasks, op.period);
      actions.replaceChildren();
      if (!slots.length) { actions.append(node('p', '', '该时段没有足够空闲时间，请换一天或缩短时长。')); return; }
      slots.forEach(slot => actions.append(button(slot.slice(11), async () => {
        try {
          const fresh = await loadCalendar(start, end);
          const startTime = Date.parse(slot); const finish = startTime + (op.durationMinutes || 60) * 60000;
          if (fresh.some(event => event.start < finish && event.end > startTime)) throw new Error('日历刚有变化，该时段已被占用，请重新检查');
          const localBusy = Tasks.list().filter(task => !task.done && task.id !== op.selected?.id && task.durationMinutes && task.deadline);
          if (localBusy.some(task => Date.parse(task.deadline) < finish && Date.parse(task.deadline) + task.durationMinutes * 60000 > startTime)) throw new Error('已有任务占用了这个时段，请重新检查');
          let task = op.selected;
          if (op.action === 'create') {
            const entry = await execute({ ...op, date: null }, null);
            op.applied = true; task = { ...entry.after, category: entry.category };
          } else if (op.text) {
            const entry = await execute({ ...op, date: null }, op.selected);
            op.applied = true; task = { ...entry.after, category: entry.category };
          }
          actions.replaceChildren(button('查看日历安排', () => window.Shixu.openCalendar(task, {start:startTime,end:finish})));
          window.Shixu.openCalendar(task, {start:startTime,end:finish});
        } catch (error) { status(error.message, true); }
      })));
      card.append(node('p', '', '点击时段保留本地待办，并打开日历确认；安排时间不会改写截止日期。'));
    } catch (error) { actions.replaceChildren(button('重新检查日历', () => checkSlots(op, card, actions))); status(error.message, true); }
  }
  async function applyCard(op, card, patch = {}) {
    if (op.running || op.applied) return;
    op.running = true;
    card.querySelectorAll('button, select').forEach(element => { element.disabled = true; });
    try {
      const entry = await execute(Object.assign(op, patch), op.selected);
      card.replaceChildren();
      const head = node('header'); head.append(node('strong', '', entry.after.text), node('small', '', '✓ 已执行并保存'));
      const changes = entry.before ? `${entry.before.done ? '已完成' : formatDate(entry.before)} → ${entry.after.done ? '已完成' : formatDate(entry.after)}` : formatDate(entry.after);
      const undoButton = button('撤销', async () => {
        try { await undo(entry); undoButton.disabled = true; status('已撤销'); head.lastChild.textContent = '已撤销'; }
        catch (error) { status(error.message, true); }
      });
      card.append(head, node('p', '', changes), undoButton);
      if (!entry.after.done) card.append(button('加入日历 / 改期', () => window.Shixu?.openCalendar({...entry.after, category: entry.category}))); 
      status('已保存，可继续输入新的安排');
    } catch (error) { status(error.message, true); card.querySelectorAll('button, select').forEach(element => { element.disabled = false; }); }
    finally { op.running = false; }
  }
  function operationSummary(op) {
    const category = Tasks.categories()[op.selected?.category || op.category] || '日常';
    const date = op.date ? `目标日期 ${op.date.replace('T', ' ')}` : op.action === 'update' ? '保留原日期' : op.action === 'complete' ? '将标记为已完成' : '无截止时间';
    return `${op.selected ? `「${op.selected.text}」 · ` : ''}${date} · ${category}`;
  }
  function renderPlan() {
    const container = $('voice-plan'); container.replaceChildren();
    if (!plan.length) { appendEmpty(container, '暂时没有可执行操作', '可以修改上方文字后重新理解。'); return; }
    const tasks = Tasks.list();
    plan.forEach(op => {
      const card = node('article', 'voice-op');
      const head = node('header');
      const labels = { create: '新增待办', update: '修改待办', complete: '完成待办', query: '查询结果' };
      head.append(node('strong', '', op.text || op.target || labels[op.action]), node('small', '', labels[op.action]));
      card.append(head);
      container.append(card);
      if (op.question) { card.append(node('p', '', op.question)); return; }
      if (op.action === 'query') {
        const matches = op.target ? tasks.filter(task => task.text.includes(op.target)) : tasks.filter(task => !task.done);
        card.append(node('p', '', matches.length ? matches.map(task => `${task.done ? '✓' : '○'} ${task.text} · ${formatDate(task)}`).join('\n') : '没有匹配到任务。'));
        return;
      }
      let selectedSummary;
      if (op.action !== 'create') {
        const matches = Domain.matchTasks(op.target, tasks, recentIds);
        if (!matches.length) { card.append(node('p', '', '没有找到对应的未完成任务，请补充名称后重新输入。')); return; }
        if (matches.length === 1) op.selected = matches[0];
        else {
          const label = node('label', '', '请选择要处理的任务 '); const select = node('select');
          select.setAttribute('aria-label', '选择匹配任务');
          select.append(new Option('请选择…', ''));
          matches.forEach(task => select.append(new Option(`${task.text} · ${formatDate(task)}`, task.id)));
          select.addEventListener('change', () => {
            op.selected = matches.find(task => task.id === select.value);
            action.disabled = !op.selected;
            action.textContent = needsSchedule() ? '检查日历并选时间' : '确认执行';
            if (selectedSummary) selectedSummary.textContent = operationSummary(op);
          });
          label.append(select); card.append(label);
        }
        if (op.selected) card.append(node('p', '', `当前任务「${op.selected.text}」 · ${formatDate(op.selected)}`));
      }
      selectedSummary = node('p', '', operationSummary(op));
      card.append(selectedSummary);
      const actions = node('div', 'voice-op-actions');
      const needsSchedule = () => op.needsSlot || (op.action === 'update' && op.selected?.durationMinutes && op.date);
      const action = button(needsSchedule() ? '检查日历并选时间' : '确认执行', () => {
        if (needsSchedule()) {
          op.durationMinutes = op.durationMinutes || op.selected?.durationMinutes || 60;
          checkSlots(op, card, actions);
        } else applyCard(op, card);
      }, 'voice-primary-button');
      if (op.action !== 'create' && !op.selected) action.disabled = true;
      if (needsSchedule() && !op.durationMinutes) op.durationMinutes = op.selected?.durationMinutes || 60;
      if (op.action === 'create' && tasks.some(task => !task.done && task.text === op.text)) { action.disabled = true; card.append(node('p', '', '已有同名待办，请到待办页检查，避免重复创建。')); }
      actions.append(action); card.append(actions);
    });
  }
  async function understand(event) {
    event?.preventDefault();
    const text = $('voice-input').value.trim();
    if (!text || busy) return;
    busy = true; $('voice-submit').disabled = true;
    status('正在理解这句话…');
    try {
      if (!api?.planTasks) throw new Error('请从桌面应用打开此功能');
      const result = await api.planTasks({ text, tasks: Tasks.list(), recentIds });
      if (!result?.ok) throw new Error(result?.error || '理解失败');
      plan = result.operations;
      renderPlan(); showView('plan');
      $('voice-mode').textContent = result.mode === 'model' ? '模型理解' : '基础解析';
      status(result.message || '请检查下面的操作后执行');
    } catch (error) { status(error.message, true); }
    finally { busy = false; $('voice-submit').disabled = false; }
  }
  async function toggleVoice(fromHold = false) {
    if (voiceStarting) return;
    if (voiceRecording) { $('voice-record').disabled = true; window.NotchWorkspace.stopRecording(); return; }
    if (window.NotchWorkspace?.isRecordingActive()) { status('已有录音正在进行，请先结束当前录音', true); return; }
    voiceStarting = true; voiceStopRequested = false;
    try {
      const settings = await api.getTranscriptionConfig();
      if (!settings.configured) { status('语音转写需要百炼 API Key，可先输入文字或使用系统听写', true); window.NotchWorkspace.openTranscriptionSettings(); return; }
      if (voiceStopRequested || (fromHold && !holdRequested)) return;
      voiceSource = fromHold ? 'hold' : 'button';
      voiceRecording = true;
      await window.NotchWorkspace.startRecording();
      if (voiceStopRequested || (fromHold && !holdRequested)) window.NotchWorkspace.stopRecording();
      clearTimeout(voiceLimit);
      if (voiceRecording && window.NotchWorkspace.isRecordingActive()) voiceLimit = setTimeout(() => { holdRequested = false; window.NotchWorkspace.stopRecording(); status('单次语音已到 2 分钟，正在结束识别'); }, 120000);
      if (!window.NotchWorkspace.isRecordingActive()) { clearTimeout(voiceLimit); voiceSource = null; voiceRecording = false; status('录音未开始，请检查麦克风权限', true); }
    } catch (error) { clearTimeout(voiceLimit); voiceSource = null; voiceRecording = false; status(error.message, true); }
    finally { voiceStarting = false; updateVoiceButton(); }
  }
  function updateVoiceButton() {
    $('voice-record').textContent = voiceRecording ? '结束并识别' : '说一句';
    $('voice-record').dataset.recording = String(voiceRecording);
    $('voice-record').disabled = false;
  }
  document.addEventListener('notch:recording-state-changed', event => {
    if (!voiceRecording) return;
    if (event.detail.transcript) $('voice-input').value = event.detail.transcript;
    status(event.detail.feedback || '正在录音，结束后检查转写文字');
    if (!event.detail.active && !voiceStarting) { clearTimeout(voiceLimit); voiceSource = null; voiceRecording = false; updateVoiceButton(); }
  });
  document.addEventListener('notch:recording-saved', event => {
    if (!voiceRecording) return;
    event.detail.voiceTask = true;
    clearTimeout(voiceLimit); voiceSource = null;
    voiceRecording = false; updateVoiceButton();
    if (event.detail.transcript) { $('voice-input').value = event.detail.transcript; understand(); }
    else status('录音已保存，暂无转写。请检查转写 API 或输入文字', true);
  });
  async function recognize(source) {
    if (ocrBusy) return;
    let recognized = false;
    setOcrBusy(true); status(source === 'screen' ? '请框选文字区域，按 Esc 可取消' : '正在本地识别图片…', false, 'ocr-status');
    try {
      const result = await api.recognizeImage({ source });
      if (result.cancelled) { status('已取消，原有结果保留', false, 'ocr-status'); return; }
      if (!result.ok) throw new Error(result.error || '识字失败');
      recognized = true;
      $('ocr-source').value = result.text; $('ocr-translation').value = '';
      status(`已识别 ${result.text.length} 字，可编辑后复制或翻译`, false, 'ocr-status');
    } catch (error) { status(error.message, true, 'ocr-status'); }
    finally { setOcrBusy(false); }
    if (recognized && $('ocr-auto-translate').checked && $('ocr-source').value) await translate();
  }
  function setOcrBusy(value) {
    ocrBusy = value;
    ['ocr-capture', 'ocr-clipboard', 'ocr-file', 'ocr-translate'].forEach(id => { $(id).disabled = value; });
  }
  async function translate() {
    const text = $('ocr-source').value.trim();
    if (!text || ocrBusy) return;
    setOcrBusy(true); status('正在翻译为中文…', false, 'ocr-status');
    try {
      const result = await api.translateText(text);
      if (!result.ok) throw new Error(result.error || '翻译失败');
      if ($('ocr-source').value.trim() !== text) throw new Error('原文已修改，请重新翻译');
      $('ocr-translation').value = result.text;
      status('翻译完成，可以复制译文', false, 'ocr-status');
    } catch (error) { status(error.message, true, 'ocr-status'); }
    finally { setOcrBusy(false); }
  }
  async function copy(id) {
    const text = $(id).value;
    if (!text) { status('还没有可复制的文字', true, 'ocr-status'); return; }
    try { const result = await api.copyText(text); status(result.ok ? '已复制，可在其他应用粘贴' : '复制失败，请重试', !result.ok, 'ocr-status'); }
    catch (error) { status(error.message, true, 'ocr-status'); }
  }
  function extract(text) {
    if (!text?.trim()) { Tasks.toast('当前内容为空'); return; }
    Tasks.open('home'); $('voice-input').value = text.slice(0, 8000); understand();
  }
  document.addEventListener('voice:extract', event => extract(event.detail?.text));
  $('voice-form').addEventListener('submit', understand);
  $('voice-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) understand(event); });
  $('voice-record').addEventListener('click', () => toggleVoice(false));
  $('voice-configure').addEventListener('click', () => window.NotchWorkspace.openTranscriptionSettings());
  $('ocr-configure').addEventListener('click', () => window.NotchWorkspace.openTranscriptionSettings());
  $('voice-all-tasks').addEventListener('click', () => Tasks.open('todo'));
  $('voice-ocr-shortcut').addEventListener('click', () => Tasks.open('ocr'));
  document.querySelectorAll('[data-voice-view]').forEach(element => element.addEventListener('click', () => showView(element.dataset.voiceView)));
  document.addEventListener('notch:todos-changed', () => queueMicrotask(renderTasks));
  $('voice-calendar-connect').addEventListener('click', async () => {
    const control = $('voice-calendar-connect'); control.disabled = true;
    $('voice-calendar-status').textContent = '正在读取日历，请留意系统授权提示…';
    try {
      const start = Date.now(); const events = await loadCalendar(start, start + 7 * 86400000);
      $('voice-calendar-status').textContent = `未来 7 天 ${events.length} 项日程 · 检查时间段时会重新读取`;
      $('voice-calendar-events').replaceChildren(...events.slice(0, 3).map(event => node('div', 'voice-calendar-event', `${new Date(event.start).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}  ${event.title}`)));
      control.textContent = '刷新日历';
    } catch (error) { $('voice-calendar-status').textContent = error.message; }
    finally { control.disabled = false; }
  });
  $('ocr-capture').addEventListener('click', () => recognize('screen'));
  $('ocr-clipboard').addEventListener('click', () => recognize('clipboard'));
  $('ocr-file').addEventListener('click', () => recognize('file'));
  $('ocr-translate').addEventListener('click', translate);
  $('ocr-copy-source').addEventListener('click', () => copy('ocr-source'));
  $('ocr-copy-translation').addEventListener('click', () => copy('ocr-translation'));
  $('ocr-source').addEventListener('input', () => {
    if ($('ocr-translation').value) {
      $('ocr-translation').value = '';
      status('原文已修改，请重新翻译', false, 'ocr-status');
    }
  });
  $('ocr-to-task').addEventListener('click', () => extract($('ocr-source').value));
  $('ocr-to-note').addEventListener('click', () => {
    const text = $('ocr-source').value.trim(); if (!text) return;
    const note = $('home-note');
    if (note.value.trim() && note.value.trim() !== text) { status('随笔记已有内容，请先保存当前笔记后重试', true, 'ocr-status'); return; }
    localStorage.removeItem('notch-note-active-archive-v1');
    note.value = text; note.dispatchEvent(new Event('input', { bubbles: true }));
    $('note-save-btn').click(); Tasks.toast('已保存到笔记，可在笔记页查看');
  });
  document.addEventListener('paste', event => {
    if (!$('tab-ocr').classList.contains('active')) return;
    if (Array.from(event.clipboardData?.items || []).some(item => item.type.startsWith('image/'))) { event.preventDefault(); recognize('clipboard'); }
  });
  // Existing note detail remains intact, with one contextual extraction action.
  const noteDetail = $('notes-detail');
  if (noteDetail) {
    const observer = new MutationObserver(() => {
      const toolbar = noteDetail.querySelector('.notes-detail-head');
      if (toolbar && !toolbar.querySelector('[data-extract-note]')) {
        const control = button('提取待办', () => extract(noteDetail.querySelector('#notes-editor')?.value || noteDetail.innerText), 'workspace-button compact');
        control.dataset.extractNote = 'true'; toolbar.append(control);
      }
    });
    observer.observe(noteDetail, { childList: true, subtree: true });
  }
  $('voice-today').textContent = new Intl.DateTimeFormat('zh-CN', {month:'long',day:'numeric',weekday:'long'}).format(new Date());
  api?.getTranscriptionConfig?.().then(settings => { $('voice-mode').textContent = settings.llmConfigured ? '模型理解已配置' : '基础解析可直接试用'; }).catch(() => {});
  renderTasks(); renderHistory(); renderPlan();
  window.VoiceAssistant = {
    understand, extract, recognize, translate, showView, execute,
    isVoiceActive: () => voiceRecording || voiceStarting,
    async holdStart() {
      if (voiceRecording || voiceStarting || window.NotchWorkspace.isRecordingActive()) { status('已有录音正在进行，请先结束当前录音', true); return; }
      holdRequested = true; Tasks.open('home'); await toggleVoice(true);
    },
    holdStop() { holdRequested = false; if (voiceSource === 'hold' && voiceRecording && !voiceStarting) window.NotchWorkspace.stopRecording(); },
    stop() { voiceStopRequested = true; holdRequested = false; if (voiceRecording && !voiceStarting) window.NotchWorkspace.stopRecording(); },
  };
})();
