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
  assert.equal(scheduler.queryTypeOf(''), 'continuation', '没新内容多半是在往下做');
  assert.equal(scheduler.queryTypeOf('今天几点开会'), 'general');
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
