const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const Workflow = require('../renderer/workflow-domain');
const profile = process.env.TODO_TEST_USER_DATA;
if (!profile) throw new Error('An isolated TODO_TEST_USER_DATA profile is required');
const phase = process.env.SHIXU_CHECK_PHASE || 'actions';
app.commandLine.appendSwitch('user-data-dir', profile);
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
for (const name of ['welcome-shown', 'permission-prompt-skipped']) fs.writeFileSync(path.join(profile, name), 'test');
fs.writeFileSync(path.join(profile, 'app-settings.json'), JSON.stringify({ agentMonitor: false, features: { clip: false } }));
const evidence = process.env.SHIXU_CHECK_EVIDENCE || path.join(__dirname, '..', 'dist.noindex', 'shixu-check');
fs.mkdirSync(evidence, { recursive: true });
const errors = [], calls = { meeting: [], daily: [], calendarList: 0, calendarRead: [], calendarSave: [] };
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
const date = Workflow.dayString(tomorrow);
let started = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Shixu check timeout', errors); app.exit(1); }, 80000);
const until = async check => { for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await pause(50); } throw new Error('Timed out waiting for UI state'); };
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  contents.on('did-finish-load', () => {
    if (started || !contents.getURL().endsWith('/renderer/index.html')) return;
    setTimeout(async () => {
      if (started || contents.isDestroyed() || contents.isLoading()) return;
      if (!await contents.executeJavaScript('Boolean(window.Shixu && window.VoiceAssistant && window.VoiceTasks)').catch(() => false)) return;
      started = true;
      const run = code => contents.executeJavaScript(code);
      const capture = async name => { await pause(800); fs.writeFileSync(path.join(evidence, `${name}.png`), (await contents.capturePage()).toPNG()); };
      const click = label => run(`(() => { const button=[...document.querySelectorAll('#shixu-dialog-body button')].find(b=>b.textContent===${JSON.stringify(label)}); if(!button)throw new Error('Missing button: '+${JSON.stringify(label)});button.click();})()`);
      const close = () => run("document.getElementById('shixu-dialog-close').click()");
      try {
        const window = BrowserWindow.fromWebContents(contents);
        await run("VoiceTasks.open('home')"); await pause(900);
        if (phase === 'restart') {
          const inbox = await run("JSON.parse(localStorage.getItem('shixu-inbox-v1'))");
          assert.ok(inbox.some(item => item.kind === 'thought' && item.text === '测试：把竞品资料整理到项目笔记'));
          const meeting = inbox.find(item => item.kind === 'meeting'); assert.ok(meeting); assert.ok(meeting.applied['0']);
          const tasks = await run('VoiceTasks.list()');
          assert.equal(tasks.filter(task => task.text === '整理本周访谈').length, 1);
          const schedules = await run("JSON.parse(localStorage.getItem('shixu-schedules-v1'))"); assert.ok(schedules[meeting.applied['0']]);
          await run('Shixu.openInbox()');
          await click('查看并整理');
          assert.equal(await run("[...document.querySelectorAll('#shixu-dialog-body button')].find(b=>b.textContent==='已加入待办').disabled"), true);
          console.log('PASS restart: inbox, meeting confirmations, tasks and calendar associations persist');
        } else {
          assert.equal(await run('document.title'), '拾序');
          assert.equal(await run("document.querySelector('.mirror-photo').getAttribute('src').includes('portrait')"), false);
          await run("document.getElementById('voice-input').value='测试：把竞品资料整理到项目笔记';document.getElementById('shixu-capture').click()");
          await until(() => run("document.getElementById('shixu-inbox-count').textContent==='1'"));
          assert.equal(await run("document.getElementById('voice-input').value"), '');
          await capture('home');
          await run("VoiceTasks.open('settings')"); await pause(200);
          assert.ok(await run("document.getElementById('shixu-voice-key').getClientRects().length>0"));
          await capture('settings');
          await run("VoiceTasks.open('home');Shixu.openMeeting()");
          await run("document.querySelector('[aria-label=\"会议转写内容\"]').value='小李负责整理本周访谈，预计三十分钟。保留暗色风格。'");
          assert.equal((await run('VoiceTasks.list()')).length, 0);
          await click('整理会议');
          await until(() => run("document.getElementById('shixu-dialog-title').textContent==='会议整理 · 确认行动项'"));
          assert.equal(calls.meeting.length, 1);
          assert.equal((await run('VoiceTasks.list()')).length, 0, 'preview must not create tasks');
          await capture('meeting-preview');
          await click('确认由我跟进，加入待办');
          await until(() => run("[...document.querySelectorAll('#shixu-dialog-body button')].some(b=>b.textContent==='已加入待办'&&b.disabled)"));
          assert.equal((await run('VoiceTasks.list()')).filter(task => task.text === '整理本周访谈').length, 1);
          await close(); await run('Shixu.openInbox()'); await click('查看并整理');
          assert.equal(await run("[...document.querySelectorAll('#shixu-dialog-body button')].find(b=>b.textContent==='已加入待办').disabled"), true);
          assert.equal(calls.calendarSave.length, 0);
          await close();
          await run("Shixu.openCalendar(VoiceTasks.list().find(t=>t.text==='整理本周访谈'))");
          await until(() => run("[...document.querySelectorAll('#shixu-dialog-body button')].some(b=>b.textContent==='确认写入日历'&&!b.disabled)"));
          assert.ok(calls.calendarList > 0);
          assert.equal(calls.calendarSave.length, 0, 'opening calendar dialog is read only');
          await run(`document.querySelector('[aria-label="安排开始时间"]').value='${date}T14:00';document.querySelector('[aria-label="安排结束时间"]').value='${date}T14:30'`);
          await click('确认写入日历');
          await until(() => run("document.getElementById('shixu-dialog-status').textContent.includes('可以在 Mac 日历中查看')"));
          assert.equal(calls.calendarSave.length, 1); assert.equal(calls.calendarSave[0].confirmed, true);
          assert.equal(calls.calendarSave[0].calendarId, '');
          const firstTaskId = calls.calendarSave[0].taskId;
          await close();
          await run("VoiceAssistant.execute({action:'create',text:'完成界面检查',date:null,category:'P3',durationMinutes:45})");
          await run('Shixu.openDaily()');
          await run(`document.querySelector('[aria-label="安排日期"]').value='${date}'`);
          await click('读取日历并生成安排');
          await until(() => run("document.getElementById('shixu-dialog-status').textContent.includes('已提出 1 项安排')"));
          assert.equal(calls.daily.length, 1); assert.equal(calls.calendarSave.length, 1);
          await capture('daily-preview');
          await click('确认加入日历');
          await until(() => run("document.getElementById('shixu-dialog-status').textContent.includes('已保存安排')"));
          assert.equal(calls.calendarSave.length, 2); assert.notEqual(calls.calendarSave[1].taskId, firstTaskId);
          assert.ok(calls.calendarRead.length >= 2, 'daily commit rechecks current calendar events');
          await close();
          // A real production IPC event reaches the renderer; only the audio device is replaced.
          await run(`window.__realWorkspace=window.NotchWorkspace;window.__recordingMock={active:false,starts:0,stops:0,release:null};window.NotchWorkspace={...window.__realWorkspace,isRecordingActive:()=>__recordingMock.active,startRecording:()=>{__recordingMock.starts++;return new Promise(resolve=>{__recordingMock.release=()=>{__recordingMock.active=true;document.dispatchEvent(new CustomEvent('notch:recording-state-changed',{detail:{active:true,status:'recording',feedback:'测试录音'}}));resolve();};});},stopRecording:()=>{if(!__recordingMock.active)return;__recordingMock.stops++;__recordingMock.active=false;document.dispatchEvent(new CustomEvent('notch:recording-saved',{detail:{id:'mock-recording-'+__recordingMock.stops,transcript:''}}));document.dispatchEvent(new CustomEvent('notch:recording-state-changed',{detail:{active:false,status:'idle'}}));}};document.getElementById('voice-input').focus()`);
          contents.send('voice-shortcuts:action', { action: 'voice-start' });
          await until(() => run('__recordingMock.starts===1'));
          contents.send('voice-shortcuts:action', { action: 'voice-stop' }); await pause(100);
          assert.equal(await run('__recordingMock.stops'), 0);
          await run('__recordingMock.release()');
          await until(() => run('__recordingMock.stops===1 && !VoiceAssistant.isVoiceActive()'));
          assert.equal(await run("JSON.parse(localStorage.getItem('shixu-inbox-v1')).filter(i=>i.kind==='recording').length"), 0, 'voice task audio must not become a meeting inbox item');
          // Toggle again during asynchronous microphone initialization must stop once ready.
          contents.send('voice-shortcuts:action', { action: 'meeting-toggle' });
          await until(() => run('__recordingMock.starts===2'));
          contents.send('voice-shortcuts:action', { action: 'meeting-toggle' }); await pause(80);
          await run('__recordingMock.release()');
          await until(() => run('__recordingMock.stops===2'));
          await until(() => run("JSON.parse(localStorage.getItem('shixu-inbox-v1')).filter(i=>i.kind==='recording').length===1"));
          assert.equal(await run("document.getElementById('tab-recordings').classList.contains('active')"), true);
          // Normal toggle-start and stop-all on sleep/service shutdown releases capture.
          contents.send('voice-shortcuts:action', { action: 'meeting-toggle' });
          await until(() => run('__recordingMock.starts===3'));
          await run('__recordingMock.release()'); await pause(50);
          contents.send('voice-shortcuts:action', { action: 'stop-all' });
          await until(() => run('__recordingMock.stops===3&&!__recordingMock.active'));
          await until(() => run("JSON.parse(localStorage.getItem('shixu-inbox-v1')).filter(i=>i.kind==='recording').length===2"));
          await run('window.NotchWorkspace=window.__realWorkspace;VoiceTasks.flush()');
          assert.deepEqual(errors, []);
          fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks: ['inbox capture', 'meeting preview and confirmation', 'duplicate prevention', 'mock calendar list/save', 'daily preview and confirmed write', 'voice release during startup', 'meeting toggle during startup', 'stop-all releases capture'], calls }, null, 2));
          console.log('PASS Shixu production UI/IPC: inbox, meeting, calendar, daily arrangement and shortcut startup races (audio/calendar/model mocked)');
        }
        clearTimeout(timeout); app.quit();
      } catch (error) { clearTimeout(timeout); console.error(error, errors); app.exit(1); }
    }, 1600);
  });
});
require('../main.js');
function mock(channel, handler) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
mock('workflow:run', (_event, payload) => {
  if (payload.workflow === 'daily') { calls.daily.push(payload); return { ok: true, workflow: 'daily', ...Workflow.planDay(payload) }; }
  calls.meeting.push(payload);
  return { ok: true, workflow: 'meeting', summary: '本次会议确认了界面方向，并提出访谈整理行动。', decisions: ['保留暗色风格'], questions: ['请确认由谁跟进行动项'], sourceId: payload.sourceId, sourceType: payload.sourceType, actionItems: [{ text: '整理本周访谈', date: null, durationMinutes: 30, owner: '小李', evidence: '小李负责整理本周访谈，预计三十分钟。', existingTaskIds: [], requiresReview: true }] };
});
mock('calendar:list', () => { calls.calendarList++; return { ok: true, calendars: [{ id: 'test-work', title: '工作', source: '测试账户' }] }; });
mock('calendar:save', (_event, payload) => { calls.calendarSave.push(payload); return { ok: true, eventId: 'test-event-' + payload.taskId, calendarId: payload.calendarId || 'test-shixu', calendarTitle: '拾序', start: payload.start, end: payload.end, allDay: payload.allDay, updated: false }; });
mock('assistant:calendar', (_event, payload) => { calls.calendarRead.push(payload); return { ok: true, events: [] }; });
mock('transcription:get-config', () => ({ configured: true, llmConfigured: false }));
