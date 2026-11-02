import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHeaders,normalizeChannelUrl,makeBody,extractJSONObject,ApiFault,buildSummaryMessages} from '../api.js';
import {defaultSettings,freshMemory} from '../core.js';
test('custom headers and body parameters pass through ST Custom route',()=>{
 const api={...defaultSettings().api,url:'https://example.invalid/v1',model:'sample',
   exclude:['temperature','chat_completion_source','messages'],
   headers:{'X-Project':'private-test','Connection':'drop-me'},include:{reasoning_effort:'low'}};
 const body=makeBody(api,[{role:'user',content:'hello'}]);
 assert.equal(body.chat_completion_source,'custom');
 assert.equal(body.custom_url,'https://example.invalid/v1');
 assert.equal(body.temperature,undefined);
 assert.equal(body.tool_choice,'none');
 assert.equal(body.messages.length,1);
 assert.equal(JSON.parse(body.custom_include_headers)['X-Project'],'private-test');
 assert.equal(JSON.parse(body.custom_include_headers).Connection,undefined);
 assert.equal(JSON.parse(body.custom_include_body).reasoning_effort,'low');
});
test('invalid headers and URL credentials are rejected',()=>{
 assert.deepEqual(normalizeHeaders({'Bad\r\nHeader':'x','Authorization':'Bearer demo','Cookie':'hi','x-opencode-session':'manual-session'}),{'x-opencode-session':'manual-session'});
 assert.throws(()=>normalizeChannelUrl('https://person:pass@some.invalid/v1'),ApiFault);
 assert.throws(()=>normalizeChannelUrl('javascript:alert(1)'),ApiFault);
});
test('extract JSON from wrapped response',()=>{
 const fenced=String.fromCharCode(96).repeat(3);
 assert.deepEqual(extractJSONObject('<thinking>checked</thinking>\n'+fenced+'json\n{"summary":"抵达小镇"}\n'+fenced),{summary:'抵达小镇'});
 assert.throws(()=>extractJSONObject('no json'),ApiFault);
});
test('summary payload is small, tool-free, independent from RP preset',()=>{
 const c=[{is_user:true,mes:'打开门'},{is_user:false,mes:'打开门后发现地图'}];
 const msgs=buildSummaryMessages(1,c,freshMemory(),defaultSettings());
 assert.deepEqual(msgs.map(x=>x.role),['system','user']);
 assert.ok(msgs[0].content.includes('JSON'));
 assert.ok(msgs[1].content.includes('地图'));
 assert.ok(!msgs[0].content.includes('NVWA'));
});
