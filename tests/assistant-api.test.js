const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAssistant } = require('../main/assistant');
function setup(settings) {
  const handlers = new Map();
  const sender = {};
  registerAssistant({
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: {}, clipboard: {}, getWindow: () => ({ webContents: sender }),
    config: () => settings, validateUrl: async url => url,
    beginInteraction() {}, endInteraction() {},
  });
  return (name, payload) => handlers.get(name)({ sender }, payload);
}
test('model transport plans structured task changes and translates with the selected settings', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const requests = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({url, body});
    const content = body.response_format
      ? JSON.stringify({operations:[{action:'complete',target:'known-id',text:'',date:null}],message:'完成已有任务'})
      : '请在周五提交报告。';
    return {ok:true,json:async()=>({choices:[{message:{content}}]})};
  };
  const call = setup({apiKey:'test-only',baseUrl:'https://example.com/v1',model:'test-model'});
  const plan = await call('assistant:plan',{text:'报告交了',tasks:[{id:'known-id',text:'提交报告',done:false}]});
  assert.equal(plan.ok,true); assert.equal(plan.mode,'model');
  assert.equal(plan.operations[0].action,'complete'); assert.equal(plan.operations[0].target,'known-id');
  assert.equal(requests[0].url,'https://example.com/v1/chat/completions');
  assert.match(requests[0].body.messages[0].content,/当前时间/);
  assert.equal(requests[0].body.model,'test-model');
  const translated = await call('assistant:translate','Please submit the report on Friday.');
  assert.deepEqual(translated,{ok:true,text:'请在周五提交报告。'});
  assert.equal(requests[1].body.response_format,undefined);
});
test('model errors remain errors and never switch silently to a different execution plan', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({ok:false,status:429});
  const call = setup({apiKey:'test-only',baseUrl:'https://example.com/v1',model:'test-model'});
  const result = await call('assistant:plan',{text:'新增任务'});
  assert.equal(result.ok,false); assert.match(result.error,/429/); assert.equal(result.operations,undefined);
  global.fetch = async () => ({ok:true,json:async()=>({choices:[{message:{content:'{"operations":[{"action":"delete"}]}'}}]})});
  assert.equal((await call('assistant:plan',{text:'test'})).ok,false);
});
