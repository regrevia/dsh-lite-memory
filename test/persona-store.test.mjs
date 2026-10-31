/**
 * 「记住我」落盘：默认关、代次核验、预算、去重、人工优先、删除不复活。
 * 时间直接喂给参数，不 mock 时钟；每个用例一份独立 DSH_HOME。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-persona-'));
process.env.DSH_HOME = home;
const store = await import('../persona-store.js');

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

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (hours) => new Date(T0 + hours * 3600000).toISOString();
const reset = () => {
  fs.rmSync(path.join(home, 'lite-memory'), { recursive: true, force: true });
};

const seedPending = (count, startHour = 0) => {
  for (let index = 0; index < count; index += 1) {
    store.queuePersonaPending({
      now: at(startHour + index), snippet: {
        text: '以后先给结论，别铺垫', sessionId: `s${index}`, taskId: `t${index}`, projectId: 'p1',
      },
    });
  }
};

const OBS = { dimension: 'answer_order', value: 'conclusion_first', polarity: 'support', basis: 'explicit_feedback' };
/** 观察必须顶着真正展示过的片段编号，提交门禁才认。 */
const obsOn = (id) => ({ ...OBS, snippetId: id });

test('默认关闭：没开过就没有画像，也不因为读了一次就变成开着', () => {
  reset();
  const read = store.readPersona({ userId: 'u1' });
  assert.equal(read.persona.control.enabled, false);
  assert.equal(read.corrupt, false);
  assert.equal(read.reason, 'missing');
  assert.equal(store.describePersona({ userId: 'u1' }).formed.length, 0);
});

test('打开与关闭都轮换同意代次，关掉时丢掉在途任务与未确认片段', () => {
  reset();
  const on = store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  assert.equal(on.ok, true);
  assert.equal(on.persona.control.enabled, true);
  const epoch = on.persona.control.consentEpoch;
  seedPending(6);
  assert.equal(store.readPersona({ userId: 'u1' }).persona.pending.length, 6);
  const off = store.setPersonaEnabled({ enabled: false, userId: 'u1', now: at(2) });
  assert.notEqual(off.persona.control.consentEpoch, epoch);
  assert.equal(off.persona.pending.length, 0);
  assert.equal(off.persona.learning.attempts.length, 0);
  assert.equal(off.persona.control.enabled, false);
});

test('只收表达偏好：项目内容与别人的话不入队', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  for (const text of ['这个函数改成纯函数', '「先给结论」是文档里的写法', '他说以后先给结论', '测试用例要覆盖回滚']) {
    assert.equal(store.queuePersonaPending({ now: at(1), snippet: { text } }).ok, false);
  }
  assert.equal(store.readPersona({ userId: 'u1' }).persona.pending.length, 0);
});

test('不足 6 条不开始，开始一次后 24 小时内不再开始', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(4);
  assert.equal(store.beginPersonaAttempt({ userId: 'u1', now: at(5) }).reason, 'not_enough');
  seedPending(2, 4);
  const first = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  assert.equal(first.ok, true);
  assert.equal(first.attempt.snippets.length >= 6, true);
  seedPending(6, 10);
  assert.equal(store.beginPersonaAttempt({ userId: 'u1', now: at(20) }).reason, 'budget');
});

test('提交落地一条只够观察，面板说的是真实次数', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  const done = store.commitPersonaObservation({ userId: 'u1', now: at(10), attempt: begun.attempt, snippetId: begun.attempt.shownIds[0], observations: [obsOn(begun.attempt.shownIds[0])] });
  assert.equal(done.ok, true);
  assert.equal(done.reason, 'committed');
  assert.equal(done.verdict.state, 'observing');
  const panel = store.describePersona({ userId: 'u1' });
  assert.equal(panel.formed.length, 0);
  assert.equal(panel.observing[0].dimension, 'answer_order');
  assert.equal(panel.observing[0].text, '已观察到 1 次，仍不足以判断是否长期');
});

test('关掉开关后迟到的结果不写入', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  store.setPersonaEnabled({ enabled: false, userId: 'u1', now: at(9.5) });
  assert.equal(store.commitPersonaObservation({ userId: 'u1', now: at(10), attempt: begun.attempt, snippetId: begun.attempt.shownIds[0], observations: [obsOn(begun.attempt.shownIds[0])] }).reason, 'off');
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(11) });
  assert.equal(store.commitPersonaObservation({ userId: 'u1', now: at(12), attempt: begun.attempt, snippetId: begun.attempt.shownIds[0], observations: [obsOn(begun.attempt.shownIds[0])] }).reason, 'consent_changed');
  assert.equal(store.readPersona({ userId: 'u1' }).persona.evidence.length, 0);
});

test('面板改过版本就作废旧结果；同一事件不能提交两次', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  store.editPersonaPreference({ userId: 'u1', dimension: 'tone', value: 'direct', now: at(9.2) });
  assert.equal(store.commitPersonaObservation({ userId: 'u1', now: at(10), attempt: begun.attempt, snippetId: begun.attempt.shownIds[0], observations: [obsOn(begun.attempt.shownIds[0])] }).reason, 'revision_changed');

  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const again = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  const first = store.commitPersonaObservation({ userId: 'u1', now: at(10), attempt: again.attempt, snippetId: again.attempt.shownIds[0], observations: [obsOn(again.attempt.shownIds[0])] });
  assert.equal(first.ok, true);
  seedPending(6, 11);
  assert.equal(store.commitPersonaObservation({ userId: 'u1', now: at(30), attempt: again.attempt, snippetId: again.attempt.shownIds[0], observations: [obsOn(again.attempt.shownIds[0])] }).reason, 'replayed');
});

test('同一任务里重复催同一句只算一份证据，不涨计数', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  for (let index = 0; index < 6; index += 1) {
    store.queuePersonaPending({ now: at(1), snippet: { text: '以后先给结论', sessionId: 's1', taskId: 't1', projectId: 'p1' } });
  }
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(5) });
  const one = store.commitPersonaObservation({ userId: 'u1', now: at(6), attempt: begun.attempt, snippetId: begun.attempt.shownIds[0], observations: [obsOn(begun.attempt.shownIds[0])] });
  assert.equal(one.ok, true);
  const support = store.readPersona({ userId: 'u1' }).persona.preferences.answer_order.support;
  assert.equal(support, 1);
  for (let index = 0; index < 6; index += 1) {
    store.queuePersonaPending({ now: at(20 + index), snippet: { text: '以后先给结论', sessionId: 's1', taskId: 't1', projectId: 'p1' } });
  }
  const next = store.beginPersonaAttempt({ userId: 'u1', now: at(30) });
  const twice = store.commitPersonaObservation({ userId: 'u1', now: at(31), attempt: next.attempt, snippetId: next.attempt.shownIds[0], observations: [obsOn(next.attempt.shownIds[0])] });
  assert.equal(twice.reason, 'duplicate');
  assert.equal(store.readPersona({ userId: 'u1' }).persona.preferences.answer_order.support, 1);
});

test('人工修改立即形成并锁定，推断不再覆盖', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  const edited = store.editPersonaPreference({ userId: 'u1', dimension: 'explanation_depth', value: 'brief', now: at(1) });
  assert.equal(edited.ok, true);
  const panel = store.describePersona({ userId: 'u1' });
  assert.equal(panel.formed[0].source, 'manual');
  assert.equal(panel.formed[0].lockedByUser, true);
  assert.equal(store.editPersonaPreference({ userId: 'u1', dimension: 'explanation_depth', value: 'essay' }).reason, 'value_not_in_dimension');
  assert.equal(store.editPersonaPreference({ userId: 'u1', dimension: 'personality', value: 'warm' }).reason, 'unknown_dimension');
});

test('不符合我之后，这一维不会被新证据复活', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  store.editPersonaPreference({ userId: 'u1', dimension: 'answer_order', value: 'conclusion_first', now: at(1) });
  const rejected = store.rejectPersonaPreference({ userId: 'u1', dimension: 'answer_order', now: at(2) });
  assert.equal(rejected.persona.preferences.answer_order.state, 'paused');
  assert.equal(store.describePersona({ userId: 'u1' }).formed.length, 0);
  seedPending(6, 3);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(20) });
  assert.equal(store.commitPersonaObservation({ userId: 'u1', now: at(21), attempt: begun.attempt, snippetId: begun.attempt.shownIds[0], observations: [obsOn(begun.attempt.shownIds[0])] }).reason, 'dimension_blocked');
  assert.equal(store.readPersona({ userId: 'u1' }).persona.preferences.answer_order.state, 'paused');
});

test('删掉一条证据后，在跑的抽取结果立即失效', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  store.commitPersonaObservation({ userId: 'u1', now: at(10), attempt: begun.attempt, snippetId: begun.attempt.shownIds[0], observations: [obsOn(begun.attempt.shownIds[0])] });
  const row = store.readPersona({ userId: 'u1' }).persona.evidence[0];
  assert.equal(store.retractPersonaEvidence({ userId: 'u1', eventId: row.eventId }).ok, true);
  seedPending(6, 11);
  const next = store.beginPersonaAttempt({ userId: 'u1', now: at(40) });
  assert.equal(next.ok, true);
  store.retractPersonaEvidence({ userId: 'u1', dimension: 'answer_order' });
  assert.equal(store.commitPersonaObservation({ userId: 'u1', now: at(41), attempt: next.attempt, snippetId: next.attempt.shownIds[0], observations: [obsOn(next.attempt.shownIds[0])] }).reason, 'evidence_changed');
});

test('删除画像清空全部内容，但保持开关；坏文件不覆盖', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  store.editPersonaPreference({ userId: 'u1', dimension: 'tone', value: 'direct', now: at(1) });
  store.recordPersonaOutcome({ userId: 'u1', outcome: 'invalid', reason: 'bad_json', at: at(1) });
  const cleared = store.clearPersona({ userId: 'u1', now: at(2) });
  assert.equal(cleared.persona.control.enabled, true);
  assert.equal(Object.keys(cleared.persona.preferences).length, 0);
  assert.equal(cleared.persona.learning.lastResult, null, '删掉画像后不该还挂着上一轮的结果');
  assert.equal(store.describePersona({ userId: 'u1' }).lastResult, null);

  const file = path.join(home, 'lite-memory', 'persona.json');
  fs.writeFileSync(file, '{not json');
  const broken = store.readPersona({ userId: 'u1' });
  assert.equal(broken.corrupt, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});

test('删掉支撑证据后计数跟着重算，清零就退回观察中', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  const read = store.readPersona({ userId: 'u1' });
  const data = read.persona;
  data.preferences.answer_order = {
    value: 'conclusion_first', state: 'formed', source: 'inferred', support: 2, opposition: 0,
    distinctDays: 2, contexts: 2, firstSeenAt: at(1), lastSupportedAt: at(30),
    lockedByUser: false, pausedByUser: false,
  };
  data.evidence = [
    { dedupeKey: 'k1', dimension: 'answer_order', polarity: 'support', value: 'conclusion_first', sessionId: 's1', taskId: 't1', projectId: 'p1', date: '2026-01-01', at: at(1), eventId: 'ev1', basis: 'explicit_feedback' },
    { dedupeKey: 'k2', dimension: 'answer_order', polarity: 'support', value: 'conclusion_first', sessionId: 's2', taskId: 't2', projectId: 'p1', date: '2026-01-02', at: at(30), eventId: 'ev2', basis: 'repeat_choice' },
  ];
  store.writePersona(data, { userId: 'u1', revision: data.revision });
  const seeded = store.describePersona({ userId: 'u1' });
  assert.equal(seeded.evidence.length, 2);
  assert.equal(seeded.evidence[0].eventId, 'ev1');
  store.retractPersonaEvidence({ userId: 'u1', eventId: 'ev1' });
  /** 只剩一条证据就不再满足门槛：计数重算，状态也一起退回观察中。 */
  const mid = store.readPersona({ userId: 'u1' }).persona.preferences.answer_order;
  assert.equal(mid.support, 1);
  assert.equal(mid.state, 'observing');
  store.retractPersonaEvidence({ userId: 'u1', eventId: 'ev2' });
  const after = store.describePersona({ userId: 'u1' });
  assert.equal(after.formed.length, 0);
  assert.equal(after.observing.length, 1);
  assert.equal(store.readPersona({ userId: 'u1' }).persona.preferences.answer_order.state, 'observing');
});

test('过期片段不再占着待查队列', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  assert.equal(store.readPersona({ userId: 'u1' }).persona.pending.length, 6);
  store.queuePersonaPending({
    now: at(20 * 24), snippet: { text: '以后先给结论，别铺垫', sessionId: 's9', taskId: 't9', projectId: 'p1' },
  });
  const pending = store.readPersona({ userId: 'u1' }).persona.pending;
  assert.equal(pending.length, 1, '两周前的片段直接丢，不和新的混在一起');
  assert.equal(pending[0].taskId, 't9');
  assert.equal(store.beginPersonaAttempt({ userId: 'u1', now: at(20 * 24 + 1) }).reason, 'not_enough');
});


test('批量整理整批结算，来源按点名的片段落账', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  const snippets = begun.attempt.snippets;
  assert.equal(snippets.length, 6);
  const cited = snippets[2];
  const done = store.commitPersonaObservation({
    userId: 'u1', now: at(10), attempt: begun.attempt, snippetId: cited.id, observations: [obsOn(cited.id)],
  });
  assert.equal(done.ok, true);
  const after = store.readPersona({ userId: 'u1' }).persona;
  assert.equal(after.evidence.length, 1);
  assert.equal(after.evidence[0].taskId, cited.taskId);
  assert.equal(after.pending.length, 0, '模型看过的整批一次结算，不会隔天重复抽');
  assert.equal(after.pending.some((row) => row.id === cited.id), false);
});

test('模型自己编的片段编号整条作废，不写证据也不吃掉片段', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  const rejected = store.commitPersonaObservation({
    userId: 'u1', now: at(10), attempt: begun.attempt, snippetId: 'made-up-id', observations: [obsOn('made-up-id')],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'citation_invalid');
  const after = store.readPersona({ userId: 'u1' }).persona;
  assert.equal(after.evidence.length, 0);
  assert.equal(after.pending.length, 6);
});

test('有效但没发现偏好：整批算处理完，明天不再重复抽同一批', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  const none = store.commitPersonaObservation({
    userId: 'u1', now: at(10), attempt: begun.attempt, outcome: 'no_change', observations: [],
  });
  assert.equal(none.ok, true);
  assert.equal(none.reason, 'no_change');
  const after = store.readPersona({ userId: 'u1' }).persona;
  assert.equal(after.evidence.length, 0);
  assert.equal(after.pending.length, 0);
  assert.equal(store.beginPersonaAttempt({ userId: 'u1', now: at(11) }).reason, 'not_enough');
});

test('抽取期间又攒了新片段不作废已经跑完的结果', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedPending(6);
  const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(9) });
  seedPending(2, 10);
  const done = store.commitPersonaObservation({
    userId: 'u1', now: at(11), attempt: begun.attempt, snippetId: begun.attempt.snippets[0].id, observations: [obsOn(begun.attempt.snippets[0].id)],
  });
  assert.equal(done.ok, true);
  assert.equal(done.reason, 'committed');
  assert.equal(store.readPersona({ userId: 'u1' }).persona.pending.length, 2, '新攒的 2 条不在这次展示名单里，留着下一批');
});

test('跨磁盘累计：八批独立反馈后仍是 8 次，日志文件里也带着取值计数', () => {
  reset();
  store.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  for (let batch = 0; batch < 8; batch += 1) {
    const startHour = batch * 48;
    for (let index = 0; index < 6; index += 1) {
      store.queuePersonaPending({
        now: at(startHour + index),
        snippet: {
          text: '以后先给结论，别铺垫', sessionId: `b${batch}s${index}`, taskId: `b${batch}t${index}`, projectId: 'p1',
        },
      });
    }
    const begun = store.beginPersonaAttempt({ userId: 'u1', now: at(startHour + 7) });
    assert.equal(begun.ok, true, `第 ${batch + 1} 批应当能开始`);
    const cited = begun.attempt.shownIds[0];
    const done = store.commitPersonaObservation({
      userId: 'u1', now: at(startHour + 8), attempt: begun.attempt, snippetId: cited, observations: [obsOn(cited)],
    });
    assert.equal(done.ok, true);
    assert.equal(done.reason, 'committed');
    /** 每批都重新从磁盘读：累计值不能掉回 1。 */
    const reread = store.readPersona({ userId: 'u1' }).persona;
    assert.equal(reread.preferences.answer_order.support, batch + 1, `第 ${batch + 1} 批读回应当是 ${batch + 1} 次`);
    assert.equal(reread.preferences.answer_order.valueTallies.conclusion_first.support, batch + 1);
  }
  const panel = store.describePersona({ userId: 'u1' });
  assert.equal(panel.formed.length, 1, '跨 14 天、8 个任务的支持应当够形成偏好');
  assert.equal(panel.observing.length, 0);
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'lite-memory', 'persona.json'), 'utf8'));
  const persisted = onDisk.preferences.answer_order;
  assert.equal(persisted.valueTallies.conclusion_first.support, 8);
  assert.equal(persisted.valueTallies.conclusion_first.dayKeys.length, 8);
  assert.equal(panel.lastResult.outcome, 'added');
});

test('旧画像文件读进来仍保留人工设定，重新落盘不丢', () => {
  reset();
  const file = path.join(home, 'lite-memory', 'persona.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /** 0.18.66 之前的形状：没有 valueTallies / shownIds / lastResult，偏好来源是人工确认。 */
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    control: { enabled: true, consentEpoch: 'old-epoch', updatedAt: '2026-09-01T00:00:00.000Z' },
    preferences: { tone: { value: 'direct', state: 'formed', source: 'manual', lockedByUser: true, support: 3 } },
    evidence: [{ eventId: 'old-e1', dimension: 'tone', polarity: 'support', value: 'direct', at: '2026-09-01T00:00:00.000Z', date: '2026-09-01' }],
    pending: [],
    learning: { lastPassAt: '', attempts: [{ eventId: 'old-attempt', snippetIds: ['a', 'b'], at: '2026-09-02T00:00:00.000Z' }] },
    recentChanges: [], blockedDimensions: [],
  }));
  const migrated = store.readPersona();
  assert.equal(migrated.corrupt, false, migrated.reason);
  assert.equal(migrated.persona.preferences.tone.value, 'direct');
  assert.equal(migrated.persona.preferences.tone.lockedByUser, true, '人工确认不能被规范化抹掉');
  assert.equal(migrated.persona.learning.lastResult, null, '旧文件没有上一轮结果');
  assert.equal(migrated.persona.learning.attempts[0].shownIds.length, 0, '旧在途记录没有点名名单');
  assert.deepEqual(migrated.persona.learning.attempts[0].snippetIds, ['a', 'b'], '旧名单还在，提交时按它兜底');

  /** 随便一次写入都要把人工设定原样带回盘上。 */
  assert.equal(store.recordPersonaOutcome({ outcome: 'invalid', reason: 'bad_json' }).ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.preferences.tone.value, 'direct');
  assert.equal(after.preferences.tone.source, 'manual');
  assert.equal(after.preferences.tone.lockedByUser, true);
  const panel = store.describePersona();
  assert.equal(panel.formed.length, 1);
  assert.equal(panel.formed[0].dimension, 'tone');
});

test('证据超上限自动裁剪后，人工取值原样保留、推断计数按剩下的证据重算', () => {
  reset();
  const file = path.join(home, 'lite-memory', 'persona.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const evidence = [];
  /** 前 192 条是人工那一维的旧支持：裁剪会先丢掉最老的这些。 */
  for (let index = 0; index < 192; index += 1) {
    evidence.push({
      eventId: `tone-${index}`, dimension: 'tone', polarity: 'support', value: 'direct',
      taskId: `tt${index}`, sessionId: `ts${index}`, projectId: 'p1',
      date: at(index).slice(0, 10), at: at(index),
    });
  }
  /** 后 8 条是推断维度的支持：跨一个多月、8 个任务，够形成偏好。 */
  const baseMs = Date.parse('2026-01-05T00:00:00.000Z');
  for (let index = 0; index < 8; index += 1) {
    const day = new Date(baseMs + index * 4 * 86400000).toISOString();
    evidence.push({
      eventId: `ao-${index}`, dimension: 'answer_order', polarity: 'support', value: 'conclusion_first',
      taskId: `at${index}`, sessionId: `as${index}`, projectId: 'p1',
      date: day.slice(0, 10), at: day,
    });
  }
  fs.writeFileSync(file, JSON.stringify({
    control: { enabled: true, consentEpoch: 'epoch', updatedAt: at(0) },
    preferences: {
      tone: { value: 'direct', state: 'formed', source: 'manual', lockedByUser: true, support: 192 },
      answer_order: { value: 'conclusion_first', state: 'observing', source: 'inferred', support: 8 },
    },
    evidence, pending: [], recentChanges: [], blockedDimensions: [],
    learning: { lastPassAt: '', attempts: [] },
  }));

  /** 从「已满 200 条」再提交一条：写盘路径自己触发裁剪，裁剪后计数必须跟着重算。 */
  seedPending(6, 2000);
  const attempt = store.beginPersonaAttempt({ now: at(2000) });
  assert.equal(attempt.ok, true, attempt.reason);
  const committed = store.commitPersonaObservation({
    now: at(2001), attempt: attempt.attempt, snippetId: attempt.attempt.shownIds[0],
    observations: [{
      snippetId: attempt.attempt.shownIds[0], dimension: 'answer_order', polarity: 'support',
      value: 'conclusion_first', basis: 'explicit_feedback',
    }],
  });
  assert.equal(committed.ok, true, committed.reason);
  assert.equal(committed.reason, 'committed');
  assert.equal(committed.persona.evidence.length, store.MAX_EVIDENCE, '超了就该裁到上限');
  const tone = committed.persona.preferences.tone;
  assert.equal(tone.value, 'direct', '人工设定不被推断覆盖');
  assert.equal(tone.source, 'manual');
  assert.equal(tone.lockedByUser, true);
  assert.equal(tone.support, 191, '人工那一维的关联条数按剩下的证据重算，不沿用旧数');
  const order = committed.persona.preferences.answer_order;
  assert.equal(order.support, 9, '新一条加上旧 8 条，按剩下的证据重算');
  assert.equal(order.state, 'formed');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.evidence.length, store.MAX_EVIDENCE);
  assert.equal(onDisk.preferences.answer_order.support, 9, '盘上的计数和内存一致');
  assert.equal(onDisk.preferences.tone.value, 'direct');
  assert.equal(onDisk.preferences.tone.support, 191);
  assert.equal(onDisk.learning.lastResult.outcome, 'added');
});

test('项目关掉记忆后，它没整理完的片段不会再被别的项目送进模型', () => {
  reset();
  const enabled = store.setPersonaEnabled({ enabled: true, now: at(0) });
  assert.equal(enabled.ok, true);
  const queue = (projectId, index) => store.queuePersonaPending({
    now: at(1 + index),
    snippet: { text: '以后先给结论', sessionId: `s-${projectId}-${index}`, taskId: `t-${projectId}-${index}`, projectId },
  });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(queue('alpha-1', index).ok, true);
    assert.equal(queue('beta-2', index).ok, true);
  }
  assert.equal(store.readPersona().persona.pending.length, 6);

  const dropped = store.dropPersonaPendingForProject({ projectId: 'alpha-1', now: at(20) });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.changed, true);
  assert.equal(dropped.dropped, 3);
  assert.equal(dropped.persona.pending.length, 3);
  assert.ok(dropped.persona.pending.every((row) => row.projectId === 'beta-2'), '只撤掉这个项目的片段');
  /** 盘上也要撤干净，否则下次读回又混进去。 */
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'lite-memory', 'persona.json'), 'utf8'));
  assert.equal(onDisk.pending.length, 3);
  assert.ok(onDisk.pending.every((row) => row.projectId === 'beta-2'));
  /** 只剩 3 条，凑不够一次整理，就不会在别的项目里替关掉的项目学。 */
  assert.equal(store.beginPersonaAttempt({ now: at(30) }).reason, 'not_enough');
  /** 没有这个项目的片段就是纯无操作，不白写一次盘。 */
  const again = store.dropPersonaPendingForProject({ projectId: 'alpha-1', now: at(31) });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.dropped, 0);
  assert.equal(again.persona.revision, dropped.persona.revision, '没变化就不升版本');
});

console.log(`persona-store.test.mjs: ${passed} passed`);
