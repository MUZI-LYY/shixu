(() => {
  'use strict';
  const api = window.notchAPI, Tasks = window.VoiceTasks, Assistant = window.VoiceAssistant;
  if (!api || !Tasks || !Assistant) return;
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const btn = (text, action, cls) => { const n = el('button', text, cls); n.type = 'button'; n.addEventListener('click', action); return n; };
  const body = $('shixu-dialog-body');
  const keys = { inbox: 'shixu-inbox-v1', schedules: 'shixu-schedules-v1' };
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  let inbox = read(keys.inbox, []), schedules = read(keys.schedules, {});
  if (!Array.isArray(inbox)) inbox = [];
  if (!schedules || Array.isArray(schedules) || typeof schedules !== 'object') schedules = {};
  let dialog = '', opener, generation = 0, meetingStarting = false, meetingStopRequested = false;
  const msg = (text, error = false) => { $('shixu-dialog-status').textContent = text; $('shixu-dialog-status').dataset.error = String(error); };
  const write = async (key, data) => { localStorage.setItem(key, JSON.stringify(data)); const result = await Tasks.flush(); if (result === false || result?.ok === false) Tasks.toast('内容已保存在本机，工作区备份暂未成功'); };
  const calendarError = value => value === 'calendar_permission_denied' ? '请在系统设置 → 隐私与安全性 → 日历中允许拾序访问后重试' : value || '日历读取失败';
  const dateString = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const localTime = ms => { const d = new Date(ms); return `${dateString(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
  function input(type, value, label) { const n = document.createElement('input'); n.type = type; n.value = value || ''; n.setAttribute('aria-label', label); return n; }
  function field(title, control) { const label = el('label', title); label.append(control); return label; }
  function open(name, title) {
    generation++; dialog = name; opener = document.activeElement;
    $('shixu-dialog-title').textContent = title; body.replaceChildren(); msg('');
    $('shixu-overlay').hidden = false; $('shixu-dialog-close').focus();
    return generation;
  }
  function close() { generation++; dialog = ''; $('shixu-overlay').hidden = true; if (opener?.isConnected) opener.focus(); }
  $('shixu-dialog-close').addEventListener('click', close);
  $('shixu-overlay').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...$('shixu-overlay').querySelectorAll('button,input,textarea,select')].filter(n => !n.disabled && n.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  function countInbox() { $('shixu-inbox-count').textContent = inbox.length; }
  async function addInbox(item) {
    if (inbox.length >= 300) throw new Error('待整理已达到 300 条，请先整理后继续保存');
    const added = { id: crypto.randomUUID(), createdAt: Date.now(), ...item };
    const next = [added, ...inbox];
    localStorage.setItem(keys.inbox,JSON.stringify(next)); inbox = next; countInbox(); await Tasks.flush(); return added;
  }
  async function removeInbox(id) { const next = inbox.filter(item => item.id !== id); localStorage.setItem(keys.inbox,JSON.stringify(next)); inbox = next; countInbox(); await Tasks.flush(); }
  async function capture() {
    const text = $('voice-input').value.trim(); if (!text) { Tasks.toast('先输入想法或资料，再存到待整理'); return; }
    try { await addInbox({kind:'thought',text}); $('voice-input').value = ''; Tasks.toast('已存到待整理'); }
    catch (error) { Tasks.toast(error.message); }
  }
  function openInbox() {
    open('inbox', '待整理'); body.append(el('p', '临时想法、资料和会议结果先放在这里，确认后再转为待办或笔记。'));
    if (!inbox.length) body.append(el('p', '暂时没有待整理内容。可以在首页输入后选择「存到待整理」。'));
    inbox.forEach(item => {
      const row = el('article', null, 'shixu-row'); row.append(el('strong', {meeting:'会议整理结果',recording:'会议录音',thought:'临时记录'}[item.kind] || '待整理'), el('p', item.text.slice(0,180)));
      const actions = el('div', null, 'actions');
      if (item.kind === 'meeting') actions.append(btn('查看并整理', () => showMeetingResult(item.result, item)));
      else if (item.kind === 'recording') actions.append(btn('会议整理', () => openMeeting({text:item.text,sourceId:item.sourceId,sourceType:'recording'})));
      else actions.append(btn('提取待办', () => { close(); Assistant.extract(item.text); }));
      actions.append(btn('存为笔记', async () => {
        try { Tasks.addNote(item.text, item.kind === 'meeting' ? '会议整理' : '待整理笔记'); await Tasks.flush(); await removeInbox(item.id); openInbox(); Tasks.toast('已保存到笔记'); } catch(error) { msg(error.message,true); }
      }));
      if (item.sourceId && item.sourceType === 'recording') actions.append(btn('查看原录音', () => { close(); window.NotchWorkspace.openRecording(item.sourceId); }));
      actions.append(btn('移出待整理', async () => {
        try { await removeInbox(item.id); openInbox(); } catch(error) { msg(error.message,true); }
      })); row.append(actions); body.append(row);
    });
  }
  const meetingText = result => [result.summary, '\n决定', ...result.decisions, '\n待确认', ...result.questions, '\n行动项', ...result.actionItems.map(a => `${a.text} · ${a.owner || '负责人待确认'} · ${a.date || '日期待确认'}\n原文：${a.evidence}`)].join('\n');
  function openMeeting(source = {}) {
    const gen = open('meeting', '会议整理');
    body.append(el('p', '粘贴会议转写，或从「录制」页打开。主助手提取摘要、决定和行动项，确认后才创建待办。内容将发送至你配置的模型服务。'));
    const text = document.createElement('textarea'); text.setAttribute('aria-label','会议转写内容'); text.placeholder = '粘贴会议记录或录音转写…'; text.value = source.text || ''; text.maxLength = 60000;
    const run = btn('整理会议', async () => {
      if (!text.value.trim()) { msg('请先填写会议内容', true); return; }
      run.disabled = true; msg('正在整理会议并核对行动项依据…');
      try {
        const result = await api.runWorkflow({workflow:'meeting',text:text.value,...{sourceId:source.sourceId || '',sourceType:source.sourceType || 'text'},tasks:Tasks.list()});
        if (!result.ok) throw new Error(result.error);
        // Persist even when the dialog was closed while the request was in flight.
        const item = {kind:'meeting',text:meetingText(result),result,sourceId:source.sourceId,sourceType:source.sourceType};
        const added = await addInbox(item);
        if (generation === gen) showMeetingResult(result, added);
        else Tasks.toast('会议整理完成，已保存到待整理');
      } catch(error) { if (generation === gen) msg(error.message,true); else Tasks.toast(error.message); }
      finally { run.disabled = false; }
    },'primary'); body.append(text, run);
  }
  function showMeetingResult(result, sourceItem) {
    open('meeting-result', '会议整理 · 确认行动项');
    body.append(el('h3','摘要'),el('p',result.summary),el('h3','已明确的决定'),el('p',result.decisions.join('\n') || '暂无明确决定'),el('h3','待确认问题'),el('p',result.questions.join('\n') || '暂无'));
    const savedIds = sourceItem.applied || {};
    body.append(btn('摘要存为笔记', async () => { try { Tasks.addNote(meetingText(result),'会议整理'); await Tasks.flush(); msg('已保存到笔记'); } catch(error) { msg(error.message,true); } }));
    result.actionItems.forEach((item,index) => {
      const row = el('article',null,'shixu-row');
      const title = input('text',item.text,'行动项标题'); title.maxLength = 80;
      const date = input(item.date?.length > 10 ? 'datetime-local' : 'date',item.date || '', '截止日期，可留空');
      const owner = input('text',item.owner || '', '负责人');
      row.append(field('待办',title),field('负责人',owner),field('截止日期',date),el('p',`原文：${item.evidence}`));
      const existing = Tasks.list().filter(t => !t.done && t.text === item.text);
      if (existing.length) row.append(el('p','已有同名待办，先查看已有任务，避免重复创建。'));
      const control = btn(savedIds[index] ? '已加入待办' : '确认由我跟进，加入待办', async () => {
        if (!title.value.trim()) { msg('请填写待办标题',true); return; }
        control.disabled = true;
        try {
          const entry = await Assistant.execute({action:'create',text:title.value.trim(),date:date.value || null,category:'P3',durationMinutes:item.durationMinutes || 0});
          sourceItem.applied = {...sourceItem.applied,[index]:entry.id};
          // Store origin separately so task import/normalization cannot erase evidence.
          const origins = read('shixu-task-origins-v1',{}); origins[entry.id] = {sourceId:sourceItem.sourceId,sourceType:sourceItem.sourceType,evidence:item.evidence,owner:owner.value};
          await write('shixu-task-origins-v1',origins); await write(keys.inbox,inbox);
          control.textContent = '已加入待办'; row.append(btn('加入日历',() => openCalendar({...entry.after,category:entry.category}))); msg('已加入待办，可继续确认其他行动项');
        } catch(error) { msg(error.message,true); control.disabled = false; }
      },'primary'); control.disabled = Boolean(savedIds[index]) || existing.length > 0; row.append(control); body.append(row);
    });
    if (!result.actionItems.length) body.append(el('p','没有可确认的行动项。'));
  }
  async function loadCalendars(select, gen) {
    select.append(new Option('拾序（默认，首次保存时创建）',''));
    const result = await api.listCalendars();
    if (!result.ok) throw new Error(result.error);
    if (gen !== generation) return;
    result.calendars.forEach(c => select.append(new Option(`${c.title} · ${c.source}`,c.id)));
  }
  function currentTask(id) { const task = Tasks.list().find(t => t.id === id); if (!task || task.done) throw new Error('任务已删除或已完成，请重新选择'); return task; }
  async function saveEvent(task, range, selectId) {
    const fresh = currentTask(task.id);
    if (fresh.text !== task.text || fresh.deadline !== task.deadline) throw new Error('待办已修改，请重新打开安排');
    const result = await api.saveCalendarEvent({confirmed:true,taskId:task.id,title:fresh.text,start:range.start,end:range.end,allDay:range.allDay === true,calendarId:selectId || ''});
    if (!result.ok) throw new Error(result.error);
    schedules[task.id] = {start:result.start,end:result.end,allDay:result.allDay,eventId:result.eventId,calendarId:result.calendarId};
    await write(keys.schedules,schedules);
    return result;
  }
  function openCalendar(task, proposal) {
    const gen = open('calendar','加入 Mac 日历 / 调整安排');
    body.append(el('strong',task.text),el('p','这里设置实际执行时间，不改变任务的截止日期。同一任务再次保存会更新原日历事件。'));
    const old = schedules[task.id];
    const candidate = proposal?.start || old?.start || (task.deadline && task.datePrecision !== 'day' ? Date.parse(task.deadline) : 0);
    const start = input('datetime-local',candidate ? localTime(candidate) : '', '安排开始时间');
    const end = input('datetime-local',proposal?.end || old?.end ? localTime(proposal?.end || old.end) : '', '安排结束时间');
    const day = input('date',old?.start ? dateString(new Date(old.start)) : task.deadline ? (task.datePrecision === 'day' ? task.deadline.slice(0,10) : dateString(new Date(task.deadline))) : dateString(new Date()), '全天事项日期');
    const allDay = input('checkbox','','作为全天事项'); allDay.checked = old?.allDay === true;
    const dayField = field('日期',day), startField = field('开始',start), endField = field('结束',end);
    const refresh = () => { dayField.hidden = !allDay.checked; startField.hidden = endField.hidden = allDay.checked; }; allDay.addEventListener('change',refresh); refresh();
    const select = document.createElement('select'); select.setAttribute('aria-label','目标日历');
    body.append(field('作为全天事项',allDay),dayField,startField,endField,field('日历',select));
    const save = btn('确认写入日历',async () => {
      let range;
      if (allDay.checked) { const d = new Date(`${day.value}T00:00:00`), e = new Date(d); e.setDate(e.getDate()+1); range = {start:d.getTime(),end:e.getTime(),allDay:true}; }
      else range = {start:Date.parse(start.value),end:Date.parse(end.value),allDay:false};
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) { msg('请选择有效的开始和结束时间',true); return; }
      save.disabled = true; msg('正在保存到 Mac 日历…');
      try { const result = await saveEvent(task,range,select.value); if (generation === gen) { msg(`已${result.updated ? '更新' : '加入'}「${result.calendarTitle}」日历，可以在 Mac 日历中查看`); save.textContent = '已保存'; } }
      catch(error) { if (generation === gen) { msg(error.message,true); save.disabled = false; } }
    },'primary');
    save.disabled = true; body.append(save);
    loadCalendars(select,gen).then(() => { if (generation === gen) { select.value = old?.calendarId || ''; save.disabled = false; } }).catch(error => { if(generation === gen) msg(error.message,true); });
  }
  function openDaily() {
    const gen = open('daily','每日安排');
    body.append(el('p','选择任务并填写预计耗时。主助手会读取日历、避开已有安排，并遵守截止日期；预览后逐条确认写入日历。'));
    const date = input('date',dateString(new Date()),'安排日期'), from = input('time','09:00','工作开始时间'), to = input('time','18:00','工作结束时间');
    body.append(field('安排日期',date),field('工作开始',from),field('工作结束',to));
    const choices = Tasks.list().filter(t => !t.done).slice(0,100).map(task => {
      const row = el('div',null,'shixu-row'), check = input('checkbox','','安排 '+task.text); check.checked = !schedules[task.id];
      const duration = input('number',String(task.durationMinutes || ''),'预计分钟：'+task.text); duration.min = '1'; duration.max = '480'; duration.placeholder = '填写分钟';
      row.append(field(task.text,check),field('预计耗时（分钟）',duration)); body.append(row); return {task,check,duration};
    });
    const output = el('section');
    const run = btn('读取日历并生成安排',async () => {
      run.disabled = true; output.replaceChildren(); msg('正在读取日历并安排任务…');
      try {
        const d = new Date(`${date.value}T00:00:00`), e = new Date(d); e.setDate(e.getDate()+1);
        const calendar = await api.readCalendar({start:d.getTime(),end:e.getTime()}); if (!calendar.ok) throw new Error(calendarError(calendar.error));
        const tasks = choices.filter(c => c.check.checked).map(c => ({...currentTask(c.task.id),durationMinutes:c.duration.value ? Number(c.duration.value) : 0}));
        if (!tasks.length) throw new Error('请至少选择一个待办');
        const result = await api.runWorkflow({workflow:'daily',date:date.value,workingStart:from.value,workingEnd:to.value,tasks,events:calendar.events});
        if (!result.ok) throw new Error(result.error);
        if (generation !== gen) return;
        msg(`已提出 ${result.proposals.length} 项安排；确认后写入「拾序」日历。`);
        result.proposals.forEach(proposal => {
          const task = tasks.find(t => t.id === proposal.taskId), row = el('div',null,'shixu-row');
          row.append(el('strong',proposal.text),el('p',`${localTime(proposal.start).replace('T',' ')} — ${localTime(proposal.end).slice(11)} · ${proposal.durationMinutes} 分钟`));
          const save = btn('确认加入日历',async () => {
            save.disabled = true;
            try {
              if (proposal.start <= Date.now()) throw new Error('这个时段已经开始，请重新生成安排');
              const fresh = await api.readCalendar({start:proposal.start,end:proposal.end}); if (!fresh.ok) throw new Error(calendarError(fresh.error));
              if (fresh.events.some(event => event.start < proposal.end && event.end > proposal.start && event.id !== schedules[task.id]?.eventId)) throw new Error('日历发生变化，这个时间已被占用，请重新生成安排');
              await saveEvent(task,proposal,''); save.textContent = '已加入日历'; msg('已保存安排，任务截止日期保持不变');
            } catch(error) { msg(error.message,true); save.disabled = false; }
          },'primary'); row.append(save,btn('调整时间 / 选择日历',()=>openCalendar(task,proposal))); output.append(row);
        });
        result.unscheduled.forEach(item => output.append(el('p',`${item.text}：${item.reason}`)));
      } catch(error) { if (generation === gen) msg(error.message,true); }
      finally { run.disabled = false; }
    },'primary'); body.append(run,output);
  }
  function showShortcutState(state) {
    if (!state?.config) return;
    ['voice','meeting'].forEach(name => { $(`shixu-${name}-enabled`).checked = state.config[name].enabled; $(`shixu-${name}-key`).value = state.config[name].accelerator; });
    $('shixu-hotkeys-status').textContent = ['voice','meeting'].map(name => `${name === 'voice' ? '语音待办' : '会议录音'}：${state.status?.[name]?.error || ({ready:'已启用',disabled:'未启用',starting:'正在启用'}[state.status?.[name]?.state] || state.status?.[name]?.state || '未启用')}`).join('；');
  }
  ['voice','meeting'].forEach(name => $(`shixu-${name}-key`).addEventListener('keydown',event => {
    if (event.key === 'Tab') return;
    event.preventDefault(); event.stopPropagation();
    const mods = [event.ctrlKey && 'Control',event.altKey && 'Alt',event.metaKey && 'Command',event.shiftKey && 'Shift'].filter(Boolean);
    const code = event.code;
    const key = code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : /^F([1-9]|1[0-2])$/.test(code) ? code : '';
    if (key && mods.some(m => m !== 'Shift')) event.target.value = [...mods,key].join('+');
  }));
  $('shixu-hotkeys-save').addEventListener('click',async () => {
    const control = $('shixu-hotkeys-save'); control.disabled = true;
    try {
      const config = Object.fromEntries(['voice','meeting'].map(name => [name,{enabled:$(`shixu-${name}-enabled`).checked,accelerator:$(`shixu-${name}-key`).value}]));
      const result = await api.setVoiceShortcuts(config);
      if (!result.ok) throw new Error(result.error || '快捷键保存失败'); showShortcutState(result);
    } catch(error) { $('shixu-hotkeys-status').textContent = error.message; $('shixu-hotkeys-status').dataset.error = 'true'; }
    finally { control.disabled = false; }
  });
  api.getVoiceShortcuts?.().then(showShortcutState).catch(()=>{}); api.onVoiceShortcutsChanged?.(showShortcutState);
  api.onVoiceShortcut?.(async ({action}) => {
    if (action === 'voice-stop') { Assistant.holdStop(); return; }
    if (action === 'stop-all') { Assistant.stop(); meetingStopRequested = true; if (!meetingStarting) window.NotchWorkspace.stopRecording(); return; }
    if (action === 'meeting-toggle' && !Assistant.isVoiceActive()) {
      if (meetingStarting) { meetingStopRequested = true; return; }
      if (window.NotchWorkspace.isRecordingActive()) { window.NotchWorkspace.stopRecording(); return; }
    }
    // Never record shortcut configuration keystrokes or interfere with a foreground dialog.
    if (!$('shixu-overlay').hidden || !$('transcription-settings-backdrop').hidden || document.activeElement?.closest('.shixu-hotkeys')) return;
    if (action === 'voice-start') { if (!meetingStarting) await Assistant.holdStart(); return; }
    if (action === 'meeting-toggle') {
      if (Assistant.isVoiceActive()) { Tasks.toast('语音待办正在录音，请先结束'); return; }
      if (meetingStarting) { meetingStopRequested = true; return; }
      if (window.NotchWorkspace.isRecordingActive()) { window.NotchWorkspace.stopRecording(); return; }
      meetingStarting = true; meetingStopRequested = false; Tasks.open('recordings');
      try { await window.NotchWorkspace.startRecording(); if (meetingStopRequested) window.NotchWorkspace.stopRecording(); }
      finally { meetingStarting = false; }
    }
  });
  document.addEventListener('notch:recording-saved',event => {
    if (event.detail.voiceTask) return;
    addInbox({kind:'recording',text:event.detail.transcript || '录音已保存，暂无转写。可打开原录音查看或补充文字。',sourceType:'recording',sourceId:event.detail.id}).catch(error=>Tasks.toast(error.message));
  });
  document.addEventListener('shixu:meeting',event => openMeeting(event.detail));
  $('shixu-capture').addEventListener('click',capture); $('shixu-inbox-open').addEventListener('click',openInbox);
  $('shixu-meeting-open').addEventListener('click',()=>openMeeting()); $('shixu-daily-open').addEventListener('click',openDaily);
  countInbox();
  window.Shixu = {openCalendar,openInbox,openMeeting,openDaily,addInbox,
    async prepareQuit() {
      Assistant.stop(); meetingStopRequested = true;
      const deadline = Date.now() + 12000;
      while ((meetingStarting || Assistant.isVoiceActive() || window.NotchWorkspace.isRecordingActive()) && Date.now() < deadline) {
        if (!meetingStarting) window.NotchWorkspace.stopRecording();
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      await Tasks.flush();
    },
  };
})();
