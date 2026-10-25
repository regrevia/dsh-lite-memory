/**
 * 三个视频使用场景 + 一组新会话对照。
 * 只验证确定性边界：规则是否按条件出现、样例/检查点是否有限、关闭后是否停止。
 * 这里不调用模型，因此不产出“更聪明”的效果结论。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-scenario-'));
const store = await import('../store.js');
const learning = await import('../learning.js');
const anchor = await import('../anchor.js');
const view = await import('../view.js');

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

const fresh = (label) => {
  const dir = path.join(os.tmpdir(), `lite-memory-scenario-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return store.scopeOf(dir);
};
const ruleRows = (scope) => store.loadIndex(scope).entries.filter((row) => row.origin === 'project_evolution');
const ruleOf = (scope, id) => ruleRows(scope).find((row) => row.id === id);
const enable = (scope, label) => {
  const result = store.setEvolution(scope, true, { operationId: `on_${label}` });
  assert.equal(result.ok, true, result.reason);
};

function seedEpisode(scope, { sessionId, messageIds, query, defaults }) {
  const routed = anchor.routeTask(store.taskState(scope), {
    sessionId,
    projectId: 'proj',
    query,
    messageIds,
    batchKey: anchor.requestBatchKey(messageIds),
    defaults,
    now: Date.now(),
  });
  const saved = store.saveTaskState(scope, routed.tasks, { operationId: `tasks_${sessionId}_${Date.now()}` });
  assert.equal(saved.ok, true, saved.reason);
  return { episode: routed.episode, sessionId, messageIds };
}

function begin(scope, grown) {
  const result = store.beginLearningAttempt(scope, { episodeId: grown.episode.episodeId, operationId: `start_${Math.random().toString(16).slice(2, 10)}` });
  assert.equal(result.ok, true, result.reason);
  return result;
}

const RANGES = { taskKinds: ['video'], series: ['口播', '剪辑', '字幕'] };

function parse(change, rules = []) {
  const refs = { feedback: { u0: 'm1' }, rules: Object.fromEntries(rules.map((rule) => [rule.ref, rule.id])) };
  return learning.parseOutput(JSON.stringify({ changes: [change] }), { finish: { kind: 'stop' }, refs, rules, ranges: RANGES });
}

function commitNew(scope, grown, started, change) {
  const check = parse(change);
  assert.equal(check.ok, true, check.reason);
  return store.commitLearning(scope, {
    operationId: `learn_${Math.random().toString(16).slice(2, 10)}`,
    epoch: started.epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    changes: check.changes,
    preparedTargets: [],
  });
}

function commitExisting(scope, grown, started, id, change, feedbackText = '') {
  const flat = ruleOf(scope, id);
  const rules = [{ ref: 'r0', id, revision: flat.revision, conditions: flat.conditions }];
  const check = parse(change, rules);
  assert.equal(check.ok, true, check.reason);
  return store.commitLearning(scope, {
    operationId: `learn_${Math.random().toString(16).slice(2, 10)}`,
    epoch: started.epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    feedbackText: feedbackText || change.currentText || '',
    changes: check.changes,
    preparedTargets: [{ id, revision: flat.revision, specDigest: flat.learning.specDigest }],
  });
}

const NEW_VIDEO_RULE = (topicKey, text, seriesId) => ({
  target: 'new',
  feedbackType: 'spec_change',
  topicKey,
  currentText: text,
  applicability: 'conditional',
  conditions: [{ key: 'seriesId', value: seriesId }],
  evidence: ['u0'],
  persistence: 'project_candidate',
});

test('S1 口播：规范生效，执行漏掉只补检查点，新会话仍读当前正文', () => {
  const scope = fresh('koubo');
  enable(scope, 'koubo');
  const grown = seedEpisode(scope, { sessionId: 's-koubo', messageIds: ['m1'], query: '以后口播开头都先给结论', defaults: { taskKind: 'video', seriesId: '口播' } });
  assert.equal(commitNew(scope, grown, begin(scope, grown), NEW_VIDEO_RULE('口播开头', '开头三句内给结论。', '口播')).ok, true);
  const id = ruleRows(scope)[0].id;
  const before = ruleOf(scope, id);
  const miss = { target: 'r0', feedbackType: 'execution_miss', currentText: '交付前先核对开头三句内有没有结论。', evidence: ['u0'], persistence: 'project_candidate' };
  assert.equal(commitExisting(scope, grown, begin(scope, grown), id, miss).ok, true);
  const after = ruleOf(scope, id);
  assert.equal(after.body, before.body);
  assert.equal(after.learning.state, 'trial');
  assert.equal(after.learning.checkpoints.length, 1);
  assert.equal((after.learning.samples || []).length, 0);
  assert.equal(view.evaluate(after, { taskKind: 'video', seriesId: '口播' }).state, 'match');
  assert.equal(view.evaluate(after, { taskKind: 'video', seriesId: '字幕' }).state, 'mismatch');
});

test('S2 剪辑：认可只留一条带版本和维度的样例，不改正文也不抬状态', () => {
  const scope = fresh('jianji');
  enable(scope, 'jianji');
  const grown = seedEpisode(scope, { sessionId: 's-jianji', messageIds: ['m1'], query: '以后剪辑都先铺节奏再切', defaults: { taskKind: 'video', seriesId: '剪辑' } });
  assert.equal(commitNew(scope, grown, begin(scope, grown), NEW_VIDEO_RULE('剪辑节奏', '先铺节奏，再切镜头。', '剪辑')).ok, true);
  const id = ruleRows(scope)[0].id;
  const before = ruleOf(scope, id);
  const accept = { target: 'r0', feedbackType: 'artifact_accept', evidence: ['u0'], persistence: 'project_candidate' };
  assert.equal(commitExisting(scope, grown, begin(scope, grown), id, accept, '这版剪辑的节奏可以').ok, true);
  const after = ruleOf(scope, id);
  assert.equal(after.body, before.body);
  assert.equal(after.learning.state, before.learning.state);
  assert.equal((after.learning.samples || []).length, 1);
  assert.equal(after.learning.samples[0].dimension, '节奏');
  assert.equal(after.learning.samples[0].verified, false);
  assert.ok(after.learning.samples[0].artifactVersion);
  assert.equal(view.evaluate(after, { taskKind: 'video', seriesId: '剪辑' }).state, 'match');
});

test('S3 字幕：一次性例外不写成规范，也不把口播规则带进来', () => {
  const scope = fresh('zimu');
  enable(scope, 'zimu');
  const grown = seedEpisode(scope, { sessionId: 's-zimu', messageIds: ['m1'], query: '以后口播开头都先给结论', defaults: { taskKind: 'video', seriesId: '口播' } });
  assert.equal(commitNew(scope, grown, begin(scope, grown), NEW_VIDEO_RULE('口播开头', '开头三句内给结论。', '口播')).ok, true);
  const exception = { target: 'new', feedbackType: 'task_exception', topicKey: '字幕例外', currentText: '这期字幕晚一点出现。', evidence: ['u0'], persistence: 'project_candidate' };
  const check = parse(exception);
  assert.equal(check.ok, false);
  assert.match(check.reason, /不直接形成长期规则/);
  assert.equal(ruleRows(scope).length, 1);
  assert.equal(view.evaluate(ruleRows(scope)[0], { taskKind: 'video', seriesId: '字幕' }).state, 'mismatch');
});

test('S4 新会话对照：有规则才命中；关闭后不再读，未知用量保持未知', () => {
  const learned = fresh('contrast-on');
  const blank = fresh('contrast-off');
  enable(learned, 'contrast');
  const grown = seedEpisode(learned, { sessionId: 's-on', messageIds: ['m1'], query: '以后口播开头都先给结论', defaults: { taskKind: 'video', seriesId: '口播' } });
  assert.equal(commitNew(learned, grown, begin(learned, grown), NEW_VIDEO_RULE('口播开头', '开头三句内给结论。', '口播')).ok, true);
  const context = { taskKind: 'video', seriesId: '口播' };
  assert.equal(ruleRows(learned).filter((row) => view.canAutoRecall(row, context)).length, 1);
  assert.equal(ruleRows(blank).filter((row) => view.canAutoRecall(row, context)).length, 0);
  const onView = view.toModelView(ruleRows(learned)[0], 'read', { context });
  assert.equal(onView.body, '开头三句内给结论。');
  assert.ok(Buffer.byteLength(JSON.stringify(onView)) <= 1024);
  store.setEvolution(learned, false, { operationId: 'off_contrast' });
  const snapshot = store.learningSnapshot(learned);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.rules[0].state, 'paused');
  assert.equal(snapshot.effect.inputTokens, null);
  assert.equal(store.beginLearningAttempt(learned, { episodeId: grown.episode.episodeId, operationId: 'start_off' }).ok, false);
});

console.log(`scenario.test.mjs: ${passed} passed`);
