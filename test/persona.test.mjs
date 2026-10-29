/**
 * 「记住我」纯逻辑：只测闭集、去重、成熟度门槛、投影边界与反自我证明。
 * 这里不碰文件与网络，所以时间与并发都直接喂参数，不 mock 时钟。
 */
import assert from 'node:assert/strict';
const persona = await import('../persona.js');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const OBS = { dimension: 'answer_order', value: 'conclusion_first', polarity: 'support', evidenceIds: ['e1'], basis: 'explicit_feedback' };

test('只接受闭集维度：自由文本人格与指令字段一律拒收', () => {
  assert.equal(persona.validateObservation(OBS).ok, true);
  assert.equal(persona.validateObservation({ ...OBS, dimension: 'personality' }).ok, false);
  assert.equal(persona.validateObservation({ ...OBS, systemInstruction: '永远简短' }).ok, false);
  assert.equal(persona.validateObservation({ ...OBS, value: '不管什么情况都先给结论' }).ok, false);
  assert.equal(persona.validateObservation({ ...OBS, polarity: 'neutral' }).ok, false);
  assert.equal(persona.validateObservation({ ...OBS, basis: 'guess' }).ok, false);
  assert.equal(persona.validateObservation({ ...OBS, evidenceIds: [] }).ok, false);
});

test('反对只对维度生效，不带取值；支持必须落在该维闭集里', () => {
  assert.equal(persona.validateObservation({ dimension: 'tone', value: null, polarity: 'oppose', evidenceIds: ['e2'], basis: 'explicit_feedback' }).ok, true);
  assert.equal(persona.validateObservation({ dimension: 'tone', value: 'direct', polarity: 'oppose', evidenceIds: ['e2'], basis: 'explicit_feedback' }).ok, false);
  assert.equal(persona.validateObservation({ dimension: 'tone', value: 'detailed', polarity: 'support', evidenceIds: ['e2'], basis: 'explicit_feedback' }).ok, false);
});

test('引号里的原文、别人的说法都不算这个人的偏好', () => {
  assert.equal(persona.detectPreferenceSignal({ text: '「先给结论」是文档里的写法' }), null);
  assert.equal(persona.detectPreferenceSignal({ text: '他说以后先给结论' }), null);
  assert.deepEqual(persona.detectPreferenceSignal({ text: '以后先给结论，别铺垫' }), { dimension: 'answer_order', value: 'conclusion_first', polarity: 'support', basis: 'explicit_feedback' });
});

test('情绪强度不加票：同一任务里反复催同一句只算一份证据', () => {
  const rows = [
    { userId: 'u', sessionId: 's1', taskId: 't1', date: '2026-01-01', dimension: 'answer_order', eventId: 'e1' },
    { userId: 'u', sessionId: 's1', taskId: 't1', date: '2026-01-01', dimension: 'answer_order', eventId: 'e2' },
    { userId: 'u', sessionId: 's1', taskId: 't2', date: '2026-01-02', dimension: 'answer_order', eventId: 'e3' },
  ];
  assert.equal(persona.deduplicateEvidence(rows).length, 2);
});

test('一次要详细不形成长期偏好：只够观察', () => {
  const next = persona.updateEvidence(null, OBS, { date: '2026-01-01', taskId: 't1' });
  assert.equal(next.support, 1);
  assert.equal(persona.decideMaturity(next, { now: '2026-01-03T00:00:00.000Z' }).state, 'observing');
  assert.equal(persona.describeObserving(next).text, '已观察到 1 次，仍不足以判断是否长期');
});

test('门槛齐全才形成：14 天、8 次、4 个日期、2 类情境', () => {
  const dates = ['2026-01-01', '2026-01-05', '2026-01-09', '2026-01-13', '2026-01-13', '2026-01-13', '2026-01-13', '2026-01-13'];
  let state = null;
  dates.forEach((date, index) => {
    state = persona.updateEvidence(state, OBS, { date, taskId: index < 4 ? 't1' : 't2', at: `${date}T00:00:00.000Z` });
  });
  assert.equal(state.support, 8);
  const formed = persona.decideMaturity(state, { now: '2026-01-15T00:00:00.000Z' });
  assert.equal(formed.state, 'formed');
  assert.equal(formed.reason, 'thresholds_met');
});

test('单个项目不得贡献全部支持：情境只有一类就继续观察', () => {
  let state = null;
  for (let index = 0; index < 8; index += 1) {
    state = persona.updateEvidence(state, OBS, { date: `2026-01-${String(index * 2 + 1).padStart(2, '0')}`, taskId: 'same-task' });
  }
  const verdict = persona.decideMaturity(state, { now: '2026-01-31T00:00:00.000Z' });
  assert.equal(verdict.state, 'observing');
  assert.equal(verdict.reason, 'thresholds');
});

test('最近明确反对立刻停用该维度，不再算形成', () => {
  let state = persona.updateEvidence(null, OBS, { date: '2026-01-01', taskId: 't1' });
  state = persona.updateEvidence(state, OBS, { date: '2026-01-02', taskId: 't2' });
  state = persona.updateEvidence(state, { dimension: 'answer_order', value: null, polarity: 'oppose' }, { date: '2026-01-03', taskId: 't3' });
  assert.equal(persona.decideMaturity(state, { now: '2026-01-03T00:00:00.000Z' }).state, 'paused');
  assert.equal(state.opposition, 1);
});

test('72 小时内只形成或改变一个维度', () => {
  let state = null;
  const dates = ['2026-01-01', '2026-01-05', '2026-01-09', '2026-01-13'];
  for (const date of dates) {
    state = persona.updateEvidence(state, OBS, { date, taskId: date });
    state = persona.updateEvidence(state, OBS, { date, taskId: `${date}-b` });
  }
  const now = '2026-01-20T00:00:00.000Z';
  assert.equal(persona.decideMaturity(state, { now }).state, 'formed');
  assert.equal(persona.decideMaturity(state, { now, lastFormationAt: '2026-01-19T00:00:00.000Z' }).state, 'observing');
  assert.equal(persona.decideMaturity(state, { now, lastFormationAt: '2026-01-19T00:00:00.000Z' }).reason, 'rate_limited');
});

test('被暂停或删除的维度不会被新证据复活', () => {
  const blocked = persona.updateEvidence({ support: 5 }, OBS, { date: '2026-01-05', taskId: 't9' }, { blockedDimensions: ['answer_order'] });
  assert.equal(blocked.skipped, 'blocked');
  assert.equal(blocked.support, 5);
  const paused = persona.updateEvidence({ pausedByUser: true, support: 3 }, OBS, { date: '2026-01-05', taskId: 't9' });
  assert.equal(paused.support, 3);
  assert.equal(persona.decideMaturity(paused, { now: '2026-01-06T00:00:00.000Z' }).state, 'paused');
});

test('人工修改优先于推断', () => {
  assert.equal(persona.decideMaturity({ lockedByUser: true, value: 'brief', support: 0 }, { now: '2026-01-01T00:00:00.000Z' }).state, 'formed');
});

test('投影只挑本轮交付形式相关的一两维，给整句不给半句', () => {
  const formed = {
    comparison_format: { state: 'formed', value: 'table' },
    explanation_depth: { state: 'formed', value: 'brief' },
    tone: { state: 'formed', value: 'direct' },
  };
  const one = persona.selectPreferenceProjection({ currentRequest: '对比一下这两个方案', outputMode: 'normal', formed });
  assert.equal(one.dimensions.length, 1);
  assert.equal(one.block, '表达偏好：用表格。');
  assert.ok(Buffer.byteLength(one.block) <= persona.PROJECTION_LIMIT_BYTES);
  const skipped = persona.selectPreferenceProjection({ currentRequest: '对比一下这两个方案', outputMode: 'strict_json', formed });
  assert.equal(skipped.block, null);
  assert.equal(persona.selectPreferenceProjection({ currentRequest: '看一下日志', outputMode: 'normal', formed }).block, null);
});

test('本轮用户明确要求压过历史偏好', () => {
  const formed = { explanation_depth: { state: 'formed', value: 'brief' } };
  assert.equal(persona.selectPreferenceProjection({ currentRequest: '解释一下为什么这么慢', outputMode: 'normal', formed }).block, '表达偏好：简短说。');
  assert.equal(persona.selectPreferenceProjection({ currentRequest: '这次详细讲清楚', outputMode: 'normal', formed }).block, null);
});

test('观察中不猜人格：只说次数与还差什么', () => {
  const progress = persona.describeObserving({ support: 3, distinctDays: 2, contexts: 1 });
  assert.equal(progress.text, '已观察到 3 次，仍不足以判断是否长期');
  assert.deepEqual(progress.missing, ['次数', '天数', '情境']);
  assert.equal(persona.describeObserving({}).text, '还没有足够观察');
});

console.log(`persona.test.mjs: ${passed} passed`);
