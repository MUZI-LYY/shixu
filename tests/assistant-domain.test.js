const test = require('node:test');
const assert = require('node:assert/strict');
const Domain = require('../renderer/assistant-domain');
const { endpoint } = require('../main/assistant');
const now = new Date(2026, 10, 12, 10);
test('basic plan splits intentions and preserves date precision', () => {
  const plan = Domain.localPlan('提醒我周五交房租；后天买牛奶；研究新工具', now);
  assert.deepEqual(plan.operations.map(op => [op.text, op.date]), [['交房租', '2026-11-13'], ['买牛奶', '2026-11-14'], ['研究新工具', null]]);
});
test('existing task changes become update and complete operations', () => {
  const plan = Domain.localPlan('健身改到后天，房租已经交了', now);
  assert.deepEqual(plan.operations.map(op => [op.action, op.target]), [['update', '健身'], ['complete', '房租']]);
});
test('oral correction and unsupported recurrence request clarification', () => {
  assert.equal(Domain.localPlan('不是明天，是后天健身', now).operations.length, 0);
  assert.equal(Domain.localPlan('每周五健身', now).operations.length, 0);
});
test('ambiguous and unsupported time expressions do not silently become deadlines', () => {
  assert.ok(Domain.localPlan('明天下午交方案', now).operations[0].question);
  assert.ok(Domain.localPlan('明天25点开会', now).operations[0].question);
});
test('query never creates a task', () => {
  assert.equal(Domain.localPlan('我有哪些待办？', now).operations[0].action, 'query');
});
test('matching returns all candidates and only active recent references', () => {
  const tasks = [{id:'1',text:'交房租',done:false},{id:'2',text:'交房租押金',done:false},{id:'3',text:'交房租',done:true}];
  assert.deepEqual(Domain.matchTasks('房租', tasks).map(task => task.id), ['1', '2']);
  assert.deepEqual(Domain.matchTasks('刚才那个', tasks, ['2', '3']).map(task => task.id), ['2']);
  assert.equal(Domain.matchTasks('', tasks).length, 0);
});
test('slot selection respects overlapping calendars and scheduled local tasks', () => {
  const start = new Date(2026, 10, 13, 13).getTime();
  const events = [{start, end:start + 90 * 60000}];
  const tasks = [{deadline:new Date(2026,10,13,15).toISOString(),durationMinutes:60,done:false}];
  const slots = Domain.findSlots('2026-11-13', 60, events, tasks, 'afternoon', now.getTime());
  assert.deepEqual(slots, ['2026-11-13T16:00','2026-11-13T16:30','2026-11-13T17:00']);
});
test('schedule request preserves duration and activity title', () => {
  const op = Domain.localPlan('明天下午找一个小时去健身', now).operations[0];
  assert.equal(op.text, '健身'); assert.equal(op.durationMinutes,60); assert.equal(op.needsSlot,true);
});
test('malformed model plans are rejected at the shared boundary', () => {
  assert.throws(() => Domain.normalizePlan({operations:[{action:'delete'}]}));
  assert.throws(() => Domain.normalizePlan({operations:[{action:'create',text:'test',date:'tomorrow'}]}));
  assert.throws(() => Domain.normalizePlan({operations:[{action:'create',text:'test',date:'2026-02-30'}]}));
  assert.throws(() => Domain.normalizePlan({operations:[{action:'create',text:'x'.repeat(81)}]}));
});
test('missing date remains unscheduled and date-only retains date metadata', () => {
  assert.deepEqual(Domain.deadlineFields(null), {deadline:'',datePrecision:'none'});
  assert.equal(Domain.deadlineFields('2026-11-13').datePrecision,'day');
});
test('model endpoint accepts root, v1 and full paths', () => {
  assert.equal(endpoint('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(endpoint('https://api.deepseek.com'),'https://api.deepseek.com/chat/completions');
  assert.equal(endpoint('https://example.com/v1/'),'https://example.com/v1/chat/completions');
  assert.equal(endpoint('https://example.com/v1/chat/completions'),'https://example.com/v1/chat/completions');
});

test('the original task editor supports unscheduled tasks and explicit time changes', () => {
  const {updateTodo} = require('../renderer/domain');
  const todo = {id:'unscheduled',text:'原名',done:false,deadline:'',datePrecision:'none',createdAt:100};
  assert.equal(updateTodo(todo,'新名','').text,'新名');
  assert.equal(updateTodo(todo,'新名','').deadline,'');
  assert.equal(updateTodo(todo,'新名','2026-11-13T15:00').datePrecision,'time');
});
