import test from 'node:test';
import assert from 'node:assert/strict';
import * as scheduler from '../scheduler.js';

test('按这一轮的话判定检索类型：具体任务压过宽泛词', () => {
  assert.equal(scheduler.queryTypeOf('这个报错是什么原因，为什么一直超时'), 'troubleshooting');
  assert.equal(scheduler.queryTypeOf('帮我发版，npm publish 之前要做什么'), 'procedure');
  assert.equal(scheduler.queryTypeOf('上次那个 unlag 端口是哪个'), 'exact_lookup');
  assert.equal(scheduler.queryTypeOf('继续做刚才那一步'), 'continuation');
  assert.equal(scheduler.queryTypeOf('下一版的重构方案怎么取舍'), 'planning');
  assert.equal(scheduler.queryTypeOf('写一段发版说明'), 'generation');
  assert.equal(scheduler.queryTypeOf(''), 'general', '空输入不自行推断成续接');
  assert.equal(scheduler.queryTypeOf('今天几点开会'), 'general');
});

test('续接只在没有更具体目标时成立，词形与纯续句分开判', () => {
  assert.equal(scheduler.queryTypeOf('继续评估重构方案'), 'planning', '带明确目标的「继续」不是接着上文');
  assert.equal(scheduler.queryTypeOf('解释为什么要写发布说明'), 'procedure', '「为什么」不该把解释请求判成排障');
  assert.equal(scheduler.queryTypeOf('summarize this'), 'generation', '英文词形要看整词前缀，不能只认原形');
  assert.equal(scheduler.queryTypeOf('继续'), 'continuation');
});

test('档位只影响候选深度与卡片数，字节不超过 1200', () => {
  const low = scheduler.retrievalPlanOf('端口是哪个');
  assert.deepEqual([low.tier, low.candidates, low.cards], ['low', 4, 1]);
  const mid = scheduler.retrievalPlanOf('帮我发版');
  assert.deepEqual([mid.tier, mid.candidates, mid.cards], ['mid', 8, 2]);
  const high = scheduler.retrievalPlanOf('这个崩溃怎么排查');
  assert.deepEqual([high.tier, high.candidates, high.cards], ['high', 12, 3]);
  for (const query of ['端口是哪个', '帮我发版', '这个崩溃怎么排查', '随便聊聊']) {
    const plan = scheduler.retrievalPlanOf(query);
    assert.ok(plan.bytes <= 1200, '字节预算不能超过硬上限');
    assert.ok(plan.cards <= 3, '卡片数不能超过投递端上限');
    assert.ok(plan.candidates <= 12);
  }
});

test('卡片上限由投递端封住：低档也不会超过调用方给的上限', () => {
  const plan = scheduler.retrievalPlanOf('这个崩溃怎么排查', { cardMax: 2 });
  assert.equal(plan.cards, 2);
  assert.equal(scheduler.planSummaryOf(plan), 'troubleshooting · high · 候选 12 · 卡片 2');
});

test('50 条分类回归：词形、否定与新任务边界都钉住', () => {
  const cases = [
  ['这个崩溃怎么排查', 'troubleshooting'],
  ['报错日志怎么看', 'troubleshooting'],
  ['npm install 报错 EACCES 怎么办', 'troubleshooting'],
  ['页面白屏了怎么回事', 'troubleshooting'],
  ['接口超时不生效', 'troubleshooting'],
  ['test failed 怎么定位', 'troubleshooting'],
  ['exception thrown on boot', 'troubleshooting'],
  ['app crashes on start', 'troubleshooting'],
  ['build broken after upgrade', 'troubleshooting'],
  ['上次那个端口是哪个', 'exact_lookup'],
  ['配置文件在哪', 'exact_lookup'],
  ['版本号是多少', 'exact_lookup'],
  ['还记得我说的路径吗', 'exact_lookup'],
  ['where is the config', 'exact_lookup'],
  ['which file has the token', 'exact_lookup'],
  ['what version shipped', 'exact_lookup'],
  ['下一版重构方案怎么取舍', 'planning'],
  ['规划一下下一阶段路线', 'planning'],
  ['架构设计如何评估', 'planning'],
  ['planning next release', 'planning'],
  ['refactoring the scheduler', 'planning'],
  ['trade-off 怎么选', 'planning'],
  ['写一段发版说明', 'generation'],
  ['生成一份总结', 'generation'],
  ['翻译这段', 'generation'],
  ['起草文案', 'generation'],
  ['summarize this', 'generation'],
  ['write a draft', 'generation'],
  ['draft the release note', 'generation'],
  ['改写这段文案', 'generation'],
  ['继续', 'continuation'],
  ['接着做', 'continuation'],
  ['然后呢', 'continuation'],
  ['继续做刚才那一步', 'continuation'],
  ['', 'general'],
  ['今天几点开会', 'general'],
  ['copyright 声明怎么写', 'general'],
  ['随便聊聊', 'general'],
  ['天气怎么样', 'general'],
  ['帮我发版', 'procedure'],
  ['部署到测试环境', 'procedure'],
  ['安装依赖', 'procedure'],
  ['回滚到上一个版本', 'procedure'],
  ['接入流程是什么', 'procedure'],
  ['deploy to staging', 'procedure'],
  ['这个 bug 什么时候修', 'troubleshooting'],
  ['端口是哪个', 'exact_lookup'],
  ['怎么选型', 'planning'],
  ['回滚', 'procedure'],
  ['写个说明', 'generation'],
  ];
  for (const [query, want] of cases) {
    assert.equal(scheduler.queryTypeOf(query), want, `分类不符：${JSON.stringify(query)}`);
  }
});
