import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,freshMemory} from '../core.js';
import {DEFAULT_SUMMARY_PROMPT,DEFAULT_CHAPTER_PROMPT,DEFAULT_RESUMMARY2_PROMPT,
  DEFAULT_OVERVIEW_PROMPT,composeL0Prompt,buildSummaryMessages,buildChapterMessages,
  l0OutputProtocol} from '../api.js';

// The same source cases exercise all levels. These assertions verify the
// instructions and input coverage, not the accuracy of an external LLM.
const stories=[
  ['旧约定已完成后被回忆','上一章已归还钥匙。','这次只是回忆曾经的约定，没有提出新要求。'],
  ['同名不同人物','旧城守卫名叫林，另一个商人也叫林。','商人林没有参加守卫的行动。'],
  ['旁白揭露但人物不知情','玩家只向医生讲了病情。','旁白透露医生的朋友隐瞒了真相，医生并未听到。'],
  ['旧物品换主人','之前铜钥匙由管家保管。','管家把同一把铜钥匙交给旅人。'],
  ['长期伏笔最终解决','三个章节一直调查钟楼密道。','本轮找到入口并确认谜题已解开。'],
  ['最后一段反转','前面的章节都说约定继续。','最后一段明确宣布约定取消，双方各自离开。']
];

test('all four optimized default prompts retain complete sources and distinguish levels',()=>{
  const config=defaultSettings();
  const prompt0=composeL0Prompt(config);
  assert.ok(prompt0.includes('固定输出协议'));
  for(const [label,user,ai] of stories){
    const chat=[{is_user:true,mes:user},{is_user:false,mes:ai}];
    const req=buildSummaryMessages(1,chat,freshMemory(),config);
    assert.ok(req[1].content.includes(user),label+' L0 user source');
    assert.ok(req[1].content.includes(ai),label+' L0 AI source');
    for(const level of ['chapter','resummary2','overview']){
      const chapter=buildChapterMessages([{summary:user},{summary:ai}],config,level);
      assert.ok(chapter[1].content.includes(user),label+' '+level+' input start');
      assert.ok(chapter[1].content.includes(ai),label+' '+level+' input end');
    }
  }
  assert.match(prompt0,/只是回忆|回忆或复述/);
  assert.match(prompt0,/同名不必然|同名不/);
  assert.match(prompt0,/未听见|未在场/);
  assert.match(prompt0,/同一物品换主人|换主人/);
  assert.match(prompt0,/已完成任务|已完成的任务/);
  assert.match(DEFAULT_CHAPTER_PROMPT,/保留优先级/);
  assert.match(DEFAULT_CHAPTER_PROMPT,/关键转折和最后一段/);
  assert.match(DEFAULT_RESUMMARY2_PROMPT,/此前状态.*当前状态/);
  assert.match(DEFAULT_RESUMMARY2_PROMPT,/已完成.*取消/);
  assert.match(DEFAULT_OVERVIEW_PROMPT,/已解决线索不再写成待办/);
  assert.match(DEFAULT_OVERVIEW_PROMPT,/长期.*伏笔/);
  assert.match(DEFAULT_OVERVIEW_PROMPT,/不能因久未出现/);
});

test('new L0 output skeleton contains no fictitious entities and respects extraction flags',()=>{
  const config=defaultSettings();
  for(let mask=0;mask<16;mask++){
    for(const [i,kind] of ['items','scenes','characters','plans'].entries())
      config.extraction[kind]=Boolean(mask&(1<<i));
    const protocol=l0OutputProtocol(config);
    const skeleton=JSON.parse(protocol.slice(protocol.indexOf('{\n')));
    assert.equal(skeleton.summary,'','blank schema is never a fabricated fact');
    assert.equal(skeleton.time,'');assert.equal(skeleton.location,'');
    for(const kind of ['items','scenes','characters','plans']){
      assert.equal(Object.hasOwn(skeleton,kind),config.extraction[kind],kind);
      if(config.extraction[kind])assert.deepEqual(skeleton[kind],[]);
    }
    assert.equal(protocol.includes('物品名称'),false);
    assert.equal(protocol.includes('人物名称'),false);
    assert.match(protocol,/summary 必须是真实的非空剧情摘要/);
  }
});

test('custom user prompts at all levels stay unchanged after default tuning',()=>{
  const config=defaultSettings();
  const custom={
    summaryFull:'我的 L0 要求：只概括事实。内含 { JSON } 示例。',
    chapter:'我的 L1 章节说明。',
    resummary2:'我的 L2 二次总结要求。',
    overview:'我的 L3 长期剧情要求。'
  };
  Object.assign(config.prompts,custom);
  assert.ok(composeL0Prompt(config).startsWith(custom.summaryFull+'\n\n'));
  for(const [kind,key] of [['chapter','chapter'],['resummary2','resummary2'],['overview','overview']])
    assert.equal(buildChapterMessages([{summary:'已有章节'}],config,kind)[0].content,custom[key]);
  assert.deepEqual(Object.fromEntries(Object.entries(custom).map(([k])=>[k,config.prompts[k]])),custom);
});

test('default prompt lengths keep a bounded request budget while enforcing better rules',()=>{
  const config=defaultSettings();
  const lengths={
    l0:composeL0Prompt(config).length,
    l1:DEFAULT_CHAPTER_PROMPT.length,
    l2:DEFAULT_RESUMMARY2_PROMPT.length,
    l3:DEFAULT_OVERVIEW_PROMPT.length
  };
  // Approximate prompt character budget from the prior release (not model tokens).
  assert.ok(lengths.l0<=2614,'L0 should not grow past the previous default request');
  assert.ok(lengths.l1<=420,'L1 must stay concise');
  assert.ok(lengths.l2<=420,'L2 must stay concise');
  assert.ok(lengths.l3<=420,'L3 must stay concise');
  const noExtraction=defaultSettings();
  for(const k of ['items','scenes','characters','plans'])noExtraction.extraction[k]=false;
  assert.ok(composeL0Prompt(noExtraction).length<=858);
  // Original built-in authoring text remains editable, while its output section
  // is replaced with the protected, switch-dependent runtime schema.
  assert.match(DEFAULT_SUMMARY_PROMPT,/【输出】/);
});
