const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron');
const profile = process.env.TODO_TEST_USER_DATA;
const phase = process.env.VOICE_CHECK_PHASE;
app.commandLine.appendSwitch('user-data-dir', profile);
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
for (const name of ['welcome-shown', 'permission-prompt-skipped']) fs.writeFileSync(path.join(profile, name), 'test');
fs.writeFileSync(path.join(profile, 'app-settings.json'), JSON.stringify({agentMonitor:false, features:{clip:false}}));
const evidence = process.env.VOICE_CHECK_EVIDENCE || path.join(__dirname, '..', 'dist.noindex', 'assistant-check');
fs.mkdirSync(evidence, { recursive: true });
const errors = [];
let started = false;
const timeout = setTimeout(() => { console.error('Assistant check timeout', errors); app.exit(1); }, 80000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  contents.on('did-finish-load', () => {
    if (started || !contents.getURL().endsWith('/renderer/index.html')) return;
    // Portable workspace recovery may reload once. Wait until initialization settles.
    setTimeout(async () => {
      if (started || contents.isDestroyed() || contents.isLoading()) return;
      const ready = await contents.executeJavaScript('Boolean(window.VoiceAssistant && window.VoiceTasks)').catch(() => false);
      if (!ready) return;
      started = true;
      try {
        const run = code => contents.executeJavaScript(code);
        const window = BrowserWindow.fromWebContents(contents);
        await run("VoiceTasks.open('home')"); await pause(1100);
        if (phase === 'restart') {
          const tasks = await run('VoiceTasks.list()');
          assert.ok(tasks.some(task => task.text === '交房租' && !task.done));
          assert.ok(tasks.some(task => task.text === '健身' && task.datePrecision === 'none'));
          assert.ok((await run("JSON.parse(localStorage.getItem('voice-operation-history-v1'))")).length >= 4);
          console.log('PASS restart persistence, task dates and operation history');
        } else {
          const nav = await run("[...document.querySelectorAll('.tab')].map(tab => tab.dataset.tab)");
          for (const tab of ['home','todo','notes','links','recordings','ocr','credentials','settings']) assert.ok(nav.includes(tab));
          assert.ok(await run('Boolean(window.NotchHome && window.NotchWorkspace)'));
          fs.writeFileSync(path.join(evidence, 'home-empty.png'), (await contents.capturePage()).toPNG());
          await run("document.getElementById('voice-input').value='明天交房租；健身'; VoiceAssistant.understand()");
          assert.equal(await run("document.querySelectorAll('#voice-plan .voice-op').length"), 2);
          await run("document.querySelectorAll('#voice-plan .voice-primary-button').forEach(button => button.click())");
          await pause(400);
          let tasks = await run('VoiceTasks.list()');
          assert.equal(tasks.length, 2); assert.equal(tasks.find(task => task.text === '交房租').datePrecision,'day');
          assert.equal(tasks.find(task => task.text === '健身').deadline,'');
          await run("document.getElementById('voice-input').value='健身改到后天，房租已经交了'; VoiceAssistant.understand()");
          fs.writeFileSync(path.join(evidence, 'task-preview.png'), (await contents.capturePage()).toPNG());
          await run("document.querySelectorAll('#voice-plan .voice-primary-button').forEach(button => button.click())");
          await pause(350);
          tasks = await run('VoiceTasks.list()');
          assert.equal(tasks.find(task => task.text === '交房租').done,true);
          assert.equal(tasks.find(task => task.text === '健身').datePrecision,'day');
          // Idempotent card execution and undo preserve unrelated task changes.
          assert.equal(await run("document.querySelectorAll('#voice-plan .voice-primary-button').length"), 0);
          await run("VoiceAssistant.showView('history'); document.querySelector('#voice-history button').click()"); await pause(250);
          await run("document.querySelector('#voice-history button').click()"); await pause(250);
          tasks = await run('VoiceTasks.list()');
          assert.equal(tasks.find(task => task.text === '交房租').done,false);
          assert.equal(tasks.find(task => task.text === '健身').deadline,'');
          await run("document.getElementById('voice-input').value='明天交房租'; VoiceAssistant.understand()");
          assert.equal(await run("document.querySelector('#voice-plan .voice-primary-button').disabled"),true);
          // A matching operation must stop if the task changes after preview.
          await run("document.getElementById('voice-input').value='健身改到明天'; VoiceAssistant.understand()");
          await run("(() => {const data=VoiceTasks.snapshot();const item=data.P3.find(t=>t.text==='健身');item.text='健身新版';VoiceTasks.commit(data);document.querySelector('#voice-plan .voice-primary-button').click()})()");
          await pause(200);
          assert.match(await run("document.getElementById('voice-status').textContent"), /发生变化/);
          await run("(() => {const data=VoiceTasks.snapshot();data.P3.find(t=>t.text==='健身新版').text='健身';VoiceTasks.commit(data)})()");
          // True macOS Vision OCR via the production IPC bridge, using a fixture image.
          const previousClipboard = await Promise.all((await clipboard.read()).map(async item => { const values={}; for(const type of item.types) values[type]=await item.getType(type); return new ClipboardItem(values); }));
          try {
            await clipboard.write([new ClipboardItem({'image/png':new Blob([fs.readFileSync(path.join(__dirname,'fixtures','ocr.png'))],{type:'image/png'})})]);
            await run("VoiceTasks.open('ocr')"); await pause(700);
            await run("VoiceAssistant.recognize('clipboard')");
            const recognized = await run("document.getElementById('ocr-source').value");
            assert.match(recognized,/Hello world/, await run("document.getElementById('ocr-status').textContent")); assert.match(recognized,/Friday/);
            await run("document.getElementById('ocr-copy-source').click()"); await pause(100);
            assert.equal(await clipboard.readText(),recognized);
            await run("VoiceAssistant.translate()");
            assert.match(await run("document.getElementById('ocr-status').textContent"),/配置模型/);
            await pause(150);
            fs.writeFileSync(path.join(evidence,'ocr-recognized.png'),(await contents.capturePage()).toPNG());
          } finally { await clipboard.write(previousClipboard); }
          await run("VoiceTasks.open('home'); VoiceAssistant.showView('tasks'); document.getElementById('voice-input').value=''; document.getElementById('voice-status').textContent='任务保存在本机工作区'; document.getElementById('voice-status').dataset.error='false'"); await pause(650);
          fs.writeFileSync(path.join(evidence,'home-tasks.png'),(await contents.capturePage()).toPNG());
          window.setSize(1000,576); await pause(200);
          fs.writeFileSync(path.join(evidence,'home-narrow.png'),(await contents.capturePage()).toPNG());
          window.setSize(1240,616); await pause(100);
          const geometry = await run(`(() => {const ids=['voice-input','voice-tasks','home-recorder','home-note','home-music','home-pomodoro']; return ids.map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return {id,x:r.x,y:r.y,width:r.width,height:r.height,display:getComputedStyle(e).display}})})()`);
          fs.writeFileSync(path.join(evidence,'geometry.json'),JSON.stringify(geometry,null,2));
          assert.ok(geometry.every(item=>item.width>0 && item.height>0));
          await run('VoiceTasks.flush()');
          // Empty and existing content remain available on each preserved page.
          for (const tab of ['todo','notes','links','recordings','credentials','settings']) { await run(`VoiceTasks.open('${tab}')`); await pause(100); }
          assert.deepEqual(errors,[]);
          console.log('PASS production IPC, task create/update/complete, stale previews, undo, duplicate prevention, retained navigation, native OCR, clipboard copy, missing model feedback');
        }
        clearTimeout(timeout); app.quit();
      } catch (error) { clearTimeout(timeout); console.error(error, errors); app.exit(1); }
    }, 1600);
  });
});
require('../main.js');
