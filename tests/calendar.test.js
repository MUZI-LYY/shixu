const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCalendarService, registerCalendar, validateSave } = require('../main/calendar');
const start = new Date('2026-11-13T09:00:00+08:00').getTime();
const request = { confirmed: true, taskId: 'task-1', title: '写方案', start, end: start + 3600000, allDay: false, calendarId: '' };
async function setup(t, native) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shixu-calendar-test-'));
  t.after(() => fs.rm(storageDir, { recursive: true, force: true }));
  return { storageDir, service: createCalendarService({ storageDir, native }) };
}
test('calendar save requires explicit confirmation and valid event timing', () => {
  assert.deepEqual(validateSave(request), { taskId: 'task-1', title: '写方案', start, end: start + 3600000, allDay: false, calendarId: '' });
  for (const override of [{confirmed:false},{taskId:''},{title:''},{start:NaN},{end:start},{end:start+367*86400000},{allDay:'true'},{calendarId:42}]) assert.throws(() => validateSave({...request,...override}));
});
test('first save records stable association; restart and reschedule update same event', async t => {
  const calls=[];
  const native = async payload => {calls.push(payload); return {ok:true,eventId:'event-1',calendarId:'cal-1',calendarTitle:'拾序',start:payload.start,end:payload.end,updated:!!payload.eventId};};
  const {storageDir,service}=await setup(t,native);
  assert.equal((await service.save(request)).updated,false);
  const restarted = createCalendarService({storageDir,native});
  assert.equal((await restarted.save({...request,start:start+86400000,end:start+90000000})).updated,true);
  assert.equal(calls[0].marker,calls[1].marker);
  assert.equal(calls[1].eventId,'event-1');
  assert.deepEqual(calls[1].lookupStarts,[start,start+86400000]);
  assert.equal(calls[1].calendarId,'');
  assert.equal((await restarted.save({...request,calendarId:'work-calendar'})).ok,true);
  assert.equal(calls[2].calendarId,'work-calendar');
});
test('crash after EventKit write retains marker and attempted date for safe retry', async t => {
  const calls=[];
  const {storageDir,service}=await setup(t,async payload=>{calls.push(payload);throw new Error('lost response');});
  await assert.rejects(service.save(request),/lost response/);
  const restarted=createCalendarService({storageDir,native:async payload=>{calls.push(payload);return {ok:true,eventId:'recovered',calendarId:'cal-1'};}});
  await restarted.save({...request,start:start+86400000,end:start+90000000});
  assert.equal(calls[0].marker,calls[1].marker);
  assert.deepEqual(calls[1].lookupStarts,[start,start+86400000]);
});
test('concurrent saves serialize, so repeated clicks do not create independent events', async t => {
  const calls=[];
  const {service}=await setup(t,async payload=>{calls.push(payload);await new Promise(r=>setTimeout(r,15));return {ok:true,eventId:'one-event',calendarId:'cal-1'};});
  await Promise.all([service.save(request),service.save(request)]);
  assert.equal(calls[0].eventId,'');assert.equal(calls[1].eventId,'one-event');
});
test('corrupt link storage blocks writes instead of forgetting ownership', async t => {
  let called=false;
  const {storageDir,service}=await setup(t,async()=>{called=true;});
  await fs.writeFile(path.join(storageDir,'shixu-calendar-links.json'),'broken');
  await assert.rejects(service.save(request),/避免重复创建/);
  assert.equal(called,false);
});
test('native permission and missing-event errors stay explicit, without creating a substitute', async t => {
  const {service}=await setup(t,async payload=>({ok:false,error:payload.action==='list'?'calendar_permission_denied':'calendar_event_missing'}));
  assert.match((await service.list()).error,/允许拾序/);
  const result=await service.save(request);assert.equal(result.ok,false);assert.match(result.error,/未自动重建/);
});
test('calendar IPC rejects foreign renderer and does not invoke tools without confirmation', async t => {
  const handlers=new Map(),sender={};let calls=0,begin=0,end=0;
  const {storageDir}=await setup(t,async()=>{});
  registerCalendar({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},getWindow:()=>({webContents:sender}),storageDir,native:async()=>{calls++;return {ok:true,calendars:[]};},beginInteraction:()=>begin++,endInteraction:()=>end++});
  assert.equal((await handlers.get('calendar:list')({sender:{}},{})).error,'invalid_sender');
  assert.equal((await handlers.get('calendar:save')({sender},{...request,confirmed:false})).ok,false);
  assert.equal(calls,0);assert.equal(begin,end);
  assert.equal((await handlers.get('calendar:list')({sender})).ok,true);assert.equal(calls,1);assert.equal(begin,end);
});
test('calendar authorization is visible above the panel and restores floating state after concurrent requests', async t => {
  const handlers=new Map(),sender={},changes=[],resolvers=[];
  const {storageDir}=await setup(t,async()=>{});
  registerCalendar({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},getWindow:()=>({webContents:sender,isAlwaysOnTop:()=>true,isDestroyed:()=>false,setAlwaysOnTop:value=>changes.push(value)}),storageDir,native:()=>new Promise(resolve=>resolvers.push(resolve))});
  const first=handlers.get('calendar:list')({sender});
  const second=handlers.get('calendar:list')({sender});
  assert.deepEqual(changes,[false]);
  resolvers[0]({ok:true,calendars:[]});await first;assert.deepEqual(changes,[false]);
  resolvers[1]({ok:true,calendars:[]});await second;assert.deepEqual(changes,[false,true]);
});
