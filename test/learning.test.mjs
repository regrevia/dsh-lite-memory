import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-learning-'));
const store = await import('../store.js');
const learning = await import('../learning.js');
const anchor = await import('../anchor.js');
const state = await import('../state.js');

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
  const dir = path.join(os.tmpdir(), `lite-memory-learn-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return store.scopeOf(dir);
};
const evolutionOf = (scope) => store.loadIndex(scope).__evolution;
const ruleRows = (scope) => store.loadIndex(scope).entries.filter((row) => row.origin === 'project_evolution');
const ruleOf = (scope, id) => ruleRows(scope).find((row) => row.id === id);

const enable = (scope, label = 'on') => {
  const result = store.setEvolution(scope, true, { operationId: `on_${label}_${Math.random().toString(16).slice(2, 8)}` });
  assert.equal(result.ok, true, result.reason);
  return result;
};

/** 造一个已绑定作品，返回锚点与落盘后的作品版本。 */
function seedEpisode(scope, overrides = {}) {
  const sessionId = overrides.sessionId || 's1';
  const ids = overrides.messageIds || ['m1'];
  const routed = anchor.routeTask(anchor.emptyTasks(), {
    sessionId,
    projectId: 'proj',
    query: overrides.query || '改一下这期口播开头',
    messageIds: ids,
    batchKey: anchor.requestBatchKey(ids),
    defaults: { taskKind: 'video', seriesId: '口播' },
    now: overrides.now || Date.now(),
  });
  const saved = store.saveTaskState(scope, routed.tasks, { operationId: `tasks_${sessionId}_${Math.random().toString(16).slice(2, 8)}` });
  assert.equal(saved.ok, true, saved.reason);
  return { anchor: routed.anchor, episode: routed.episode, sessionId, messageIds: ids };
}

function begin(scope, grown, overrides = {}) {
  const result = store.beginLearningAttempt(scope, {
    episodeId: grown.episode.episodeId,
    operationId: overrides.operationId || `start_${Math.random().toString(16).slice(2, 10)}`,
    now: overrides.now,
  });
  return result;
}

const NEW_CHANGE = {
  target: 'new',
  feedbackType: 'spec_change',
  topicKey: '口播开头',
  currentText: '开头三句内给结论。',
  applicability: 'conditional',
  conditions: [{ key: 'seriesId', value: '口播' }],
  evidence: ['u0'],
  persistence: 'project_candidate',
};

const RULES = [];
const REFS = { feedback: { u0: 'm1' }, rules: {} };
const RANGES = { taskKinds: ['video'], series: ['口播'] };

function parsed(change, extra = {}) {
  return learning.parseOutput(JSON.stringify({ changes: [change] }), {
    finish: { kind: 'stop' },
    refs: extra.refs || REFS,
    rules: extra.rules || RULES,
    ranges: extra.ranges || RANGES,
  });
}

function commitNew(scope, grown, started, change = NEW_CHANGE, overrides = {}) {
  const check = parsed(change, overrides);
  assert.equal(check.ok, true, check.reason);
  return store.commitLearning(scope, {
    operationId: overrides.operationId || `learn_${Math.random().toString(16).slice(2, 10)}`,
    epoch: started.epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    changes: check.changes,
    preparedTargets: [],
    usage: overrides.usage,
    explicitLongTerm: Boolean(overrides.explicitLongTerm),
    now: overrides.now,
  });
}

/** 对已有规则提交一次样例或检查点变化。 */
function commitExisting(scope, grown, started, id, change, extra = {}) {
  const flat = ruleOf(scope, id);
  const rules = [{ ref: 'r0', id, revision: flat.revision, conditions: flat.conditions }];
  const refs = { feedback: { u0: grown.messageIds[0] }, rules: { r0: id } };
  const check = parsed(change, { rules, refs, ranges: { taskKinds: ['video'], series: ['口播', '字幕'] } });
  assert.equal(check.ok, true, check.reason);
  return store.commitLearning(scope, {
    operationId: extra.operationId || `learn_${Math.random().toString(16).slice(2, 10)}`,
    epoch: started.epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    feedbackText: extra.feedbackText || '',
    dimension: extra.dimension || '',
    changes: check.changes,
    preparedTargets: [{ id, revision: flat.revision, specDigest: flat.learning.specDigest }],
    usage: extra.usage,
  });
}

test('P00 初始任务与致谢不算反馈', () => {
  assert.equal(learning.classifyFeedback('帮我做一期口播，开头要抓人').worth, false);
  assert.equal(learning.classifyFeedback('谢谢').worth, false);
  assert.equal(learning.classifyFeedback('').worth, false);
});

test('P00 明确长期要求分类为规范变化', () => {
  const cue = learning.classifyFeedback('以后口播开头都先给结论，别再铺垫');
  assert.equal(cue.worth, true);
  assert.equal(cue.type, 'spec_change');
  assert.equal(cue.explicitLongTerm, true);
  assert.equal(learning.isLongTerm('这次就先这样'), false);
});

test('P00 作品验收不直接形成长期规则', () => {
  const cue = learning.classifyFeedback('这版可以');
  assert.equal(cue.type, 'artifact_accept');
  assert.equal(parsed({ ...NEW_CHANGE, feedbackType: 'artifact_accept' }).ok, false);
});

test('P00 只有已绑定作品的人类消息进入候选', () => {
  const human = (id, text) => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const base = { episodeId: 'ep_x', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(learning.candidateFrom({ messages: [human('m1', '以后开头先给结论')], anchor: { ...base, status: 'unbound' } }), null);
  assert.equal(learning.candidateFrom({ messages: [{ id: 'a1', source: { kind: 'assistant' }, content: '收到' }], anchor: base }), null);
  const candidate = learning.candidateFrom({ messages: [human('m1', '以后开头都先给结论，别再铺垫')], anchor: base, sessionId: 's', projectId: 'p' });
  assert.equal(candidate.episodeId, 'ep_x');
  assert.equal(candidate.messageIds[0], 'm1');
  assert.equal(candidate.cue.explicitLongTerm, true);
});

test('B01 调用输入不超过 8 KiB 且只有本地引用', () => {
  const long = '口播开头先给结论，'.repeat(800);
  const input = learning.buildCallInput({
    projectId: 'p'.repeat(200),
    episodeId: 'ep',
    taskKind: 'video',
    seriesId: '口播',
    phase: 'script',
    feedback: { text: long, messageIds: ['m1'], cue: { type: 'spec_change', explicitLongTerm: false } },
    rules: Array.from({ length: 10 }, (_, index) => ({
      id: `mem_${index}`,
      revision: 3,
      title: '标题'.repeat(50),
      summary: '摘要'.repeat(80),
      body: '正文'.repeat(300),
      conditions: [{ key: 'seriesId', value: '口播' }],
      learning: { state: 'trial' },
    })),
    ranges: { taskKinds: ['video'], series: ['口播'] },
  });
  assert.ok(input.bytes <= 8192, `bytes=${input.bytes}`);
  assert.equal(input.rules.length >= 1, true);
  assert.equal(input.rules.length <= 6, true);
  assert.equal(input.prompt.includes(long), false);
  assert.equal(input.refs.feedback.u0, 'm1');
  assert.equal(input.refs.rules.r0, 'mem_0');
  assert.equal(input.messages.length, 1);
  assert.doesNotMatch(input.system, /工具调用/);
});

test('B01 截断、工具调用、额外字段整批拒绝', () => {
  assert.equal(learning.parseOutput('{"changes":[{"target":"new"', { finish: { kind: 'stop' } }).ok, false);
  assert.equal(learning.parseOutput('<tool>memory_save</tool>', { finish: { kind: 'stop' } }).ok, false);
  assert.equal(learning.parseOutput('{"changes":[],"note":"x"}', { finish: { kind: 'stop' } }).ok, false);
  assert.equal(learning.parseOutput('{"changes":[]}', { finish: { kind: 'length' } }).ok, false);
  assert.equal(learning.parseOutput('{"changes":[]}', { finish: { kind: 'stop' } }).ok, true);
});

test('B01 未知字段和越界条件整批拒绝', () => {
  assert.equal(parsed({ ...NEW_CHANGE, surprise: 1 }).ok, false);
  assert.equal(parsed({ ...NEW_CHANGE, conditions: [{ key: 'taskKind', value: 'podcast' }] }).ok, false);
  assert.equal(parsed({ ...NEW_CHANGE, conditions: [{ key: 'seriesId', value: '直播' }] }).ok, false);
  assert.equal(parsed({ ...NEW_CHANGE, conditions: [{ key: 'seriesId' }] }).ok, false);
  const good = parsed(NEW_CHANGE);
  assert.equal(good.ok, true);
  assert.equal(good.changes[0].topicKey, '口播开头');
});

test('B01 证据必须来自本次反馈且不超过三条', () => {
  assert.equal(parsed({ ...NEW_CHANGE, evidence: ['u9'] }).ok, false);
  assert.equal(parsed({ ...NEW_CHANGE, evidence: [] }).ok, false);
  const refs = { feedback: { u0: 'm1', u1: 'm2', u2: 'm3', u3: 'm4' }, rules: {} };
  assert.equal(parsed({ ...NEW_CHANGE, evidence: ['u0', 'u1', 'u2', 'u3'] }, { refs }).ok, false);
});

test('B02 真实用量与缺失用量区分', () => {
  assert.deepEqual(learning.usageOf([]), { known: false });
  assert.deepEqual(learning.usageOf([{ type: 'text-delta', text: 'x' }]), { known: false });
  const usage = learning.usageOf([{ type: 'usage', inputTokens: 120, outputTokens: 40, cachedInputTokens: 80 }]);
  assert.equal(usage.known, true);
  assert.equal(usage.inputTokens, 120);
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.cachedInputTokens, 80);
});

test('B05 频次：每作品两次、每项目 24 小时六次，失败也计数', () => {
  const scope = fresh('quota');
  enable(scope);
  const grown = seedEpisode(scope);
  const first = begin(scope, grown);
  assert.equal(first.ok, true, first.reason);
  const second = begin(scope, grown);
  assert.equal(second.ok, true, second.reason);
  const third = begin(scope, grown);
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'episode_limit');
  for (let index = 0; index < 4; index += 1) {
    const other = seedEpisode(scope, { sessionId: `s${index + 2}`, messageIds: [`m${index + 2}`] });
    assert.equal(begin(scope, other).ok, true);
  }
  const overflow = seedEpisode(scope, { sessionId: 's9', messageIds: ['m9'] });
  const blocked = begin(scope, overflow);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'project_limit');
});

test('P10 执行没做到时只补检查点，不改规范正文', () => {
  const scope = fresh('checkpoint');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  assert.equal(commitNew(scope, grown, started, NEW_CHANGE, { explicitLongTerm: true }).ok, true);
  const id = ruleRows(scope)[0].id;
  const before = ruleOf(scope, id);
  const next = begin(scope, grown);
  const result = commitExisting(scope, grown, next, id, {
    target: 'r0', feedbackType: 'execution_miss', currentText: '交付前先核对开头是否先给结论。', evidence: ['u0'],
  });
  assert.equal(result.ok, true, result.reason);
  const after = ruleOf(scope, id);
  assert.equal(after.body, before.body);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.learning.state, 'active');
  assert.equal(after.learning.checkpoints.length, 1);
  assert.match(after.learning.checkpoints[0].text, /核对/);
  assert.equal(after.learning.evidence.length, before.learning.evidence.length);
  assert.equal(after.learning.samples, undefined);
});

test('P11 认可作品只记有限样例，不抬规则证据也不改正文', () => {
  const scope = fresh('sample');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  assert.equal(commitNew(scope, grown, started, NEW_CHANGE, { explicitLongTerm: true }).ok, true);
  const id = ruleRows(scope)[0].id;
  const before = ruleOf(scope, id);
  const next = begin(scope, grown);
  const result = commitExisting(scope, grown, next, id, {
    target: 'r0', feedbackType: 'artifact_accept', evidence: ['u0'],
  }, { dimension: '开头' });
  assert.equal(result.ok, true, result.reason);
  const after = ruleOf(scope, id);
  assert.equal(after.body, before.body);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.learning.samples.length, 1);
  assert.equal(after.learning.samples[0].dimension, '开头');
  assert.equal(after.learning.samples[0].verified, false);
  assert.equal(after.learning.samples[0].artifactVersion, grown.episode.updatedAt);
  assert.equal(after.learning.evidence.length, before.learning.evidence.length);
  assert.equal(after.learning.supportedEpisodeIds.length, before.learning.supportedEpisodeIds.length);
});

test('P12 样例只能挂已有规则，临时例外仍不形成规则', () => {
  const scope = fresh('sample-new');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  const rejected = parsed({
    target: 'new', feedbackType: 'artifact_accept', currentText: '这次就这版。', evidence: ['u0'],
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /已有规则/);
  assert.equal(parsed({ target: 'new', feedbackType: 'task_exception', currentText: '这次例外。', evidence: ['u0'] }).ok, false);
  assert.equal(parsed({ target: 'new', feedbackType: 'unclear', currentText: '说不上。', evidence: ['u0'] }).ok, false);
  assert.equal(commitNew(scope, grown, started, NEW_CHANGE).ok, true);
  const id = ruleRows(scope)[0].id;
  const second = begin(scope, grown);
  const exception = parsed({ target: 'r0', feedbackType: 'task_exception', currentText: '这次例外。', evidence: ['u0'] }, {
    rules: [{ ref: 'r0', id, revision: ruleOf(scope, id).revision, conditions: ruleOf(scope, id).conditions }],
    refs: { feedback: { u0: grown.messageIds[0] }, rules: { r0: id } },
  });
  assert.equal(exception.ok, false);
  assert.equal(second.ok, true);
});

test('P13 样例与检查点按上限保留', () => {
  const scope = fresh('sample-caps');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  assert.equal(commitNew(scope, grown, started, NEW_CHANGE, { explicitLongTerm: true }).ok, true);
  const id = ruleRows(scope)[0].id;
  for (const dimension of ['开头', '字幕', '节奏', '配乐', '镜头']) {
    assert.equal(commitExisting(scope, grown, { epoch: evolutionOf(scope).epoch }, id, {
      target: 'r0', feedbackType: 'artifact_accept', evidence: ['u0'],
    }, { dimension }).ok, true);
  }
  assert.equal(ruleOf(scope, id).learning.samples.length, 4);
  for (const text of ['检查一。', '检查二。', '检查三。', '检查四。']) {
    assert.equal(commitExisting(scope, grown, { epoch: evolutionOf(scope).epoch }, id, {
      target: 'r0', feedbackType: 'execution_miss', currentText: text, evidence: ['u0'],
    }).ok, true);
  }
  assert.equal(ruleOf(scope, id).learning.checkpoints.length, 3);
});

test('P01 新规则落盘带来源、条件与待复核状态', () => {
  const scope = fresh('commit-new');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  const result = commitNew(scope, grown, started, NEW_CHANGE, { explicitLongTerm: true, usage: { known: true, inputTokens: 90, outputTokens: 20 } });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.touched, 1);
  const rows = ruleRows(scope);
  assert.equal(rows.length, 1);
  const flat = store.loadIndex(scope).entries.find((row) => row.id === rows[0].id);
  assert.equal(flat.conditions[0].value, '口播');
  assert.equal(flat.learning.state, 'active');
  assert.equal(flat.learning.evidence.at(-1).episodeId, grown.episode.episodeId);
  assert.equal(flat.learning.evidence.at(-1).sourceType, 'human_feedback');
  assert.equal(flat.learning.evidence.at(-1).evidenceRef, undefined);
  const ledger = evolutionOf(scope).learning;
  assert.equal(ledger.receipts.at(-1).status, 'applied');
  assert.equal(ledger.receipts.at(-1).usage.inputTokens, 90);
});

test('P01 同一 operationId 重放返回原回执，不重复写', () => {
  const scope = fresh('replay');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  const op = 'learn_replay_1';
  const first = commitNew(scope, grown, started, NEW_CHANGE, { operationId: op });
  assert.equal(first.ok, true, first.reason);
  const again = commitNew(scope, grown, started, NEW_CHANGE, { operationId: op });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(again.receipt.status, 'applied');
  assert.equal(ruleRows(scope).length, 1);
});

test('B06 目标规则版本变了整批拒绝', () => {
  const scope = fresh('stale-target');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  assert.equal(commitNew(scope, grown, started, NEW_CHANGE).ok, true);
  const id = ruleRows(scope)[0].id;
  const version = ruleOf(scope, id).revision;
  const rules = [{ ref: 'r0', id, revision: version, conditions: [{ key: 'seriesId', value: '口播' }] }];
  const refs = { feedback: { u0: 'm1' }, rules: { r0: id } };
  const update = { target: 'r0', feedbackType: 'spec_change', currentText: '开头两句内给结论。', evidence: ['u0'] };
  const check = parsed(update, { rules, refs });
  assert.equal(check.ok, true, check.reason);
  const second = begin(scope, grown);
  assert.equal(second.ok, true, second.reason);
  // 另一次整理先改了同一条
  const rival = parsed({ ...update, currentText: '开头一句内给结论。' }, { rules, refs });
  const applied = store.commitLearning(scope, {
    operationId: 'learn_rival',
    epoch: second.epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    changes: rival.changes,
    preparedTargets: [{ id, revision: version, specDigest: ruleOf(scope, id).learning.specDigest }],
  });
  assert.equal(applied.ok, true, applied.reason);
  const stale = store.commitLearning(scope, {
    operationId: 'learn_stale',
    epoch: second.epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    changes: check.changes,
    preparedTargets: [{ id, revision: version, specDigest: ruleOf(scope, id).learning.specDigest }],
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /版本|改过/);
  assert.match(ruleOf(scope, id).body, /一句/);
});

test('P06 作品版本变了旧整理整批作废', () => {
  const scope = fresh('stale-episode');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  const later = anchor.routeTask(store.loadIndex(scope).__tasks, {
    sessionId: grown.sessionId,
    projectId: 'proj',
    query: '这期改成另一条',
    messageIds: ['m2'],
    batchKey: anchor.requestBatchKey(['m2']),
    now: Date.now() + 1000,
  });
  store.saveTaskState(scope, later.tasks, { operationId: 'tasks_later' });
  const stale = commitNew(scope, grown, started, NEW_CHANGE, { now: Date.now() + 2000 });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /换到别的作品|改过这期|失效/);
  assert.equal(ruleRows(scope).length, 0);
});

test('P05 关闭实验后旧提案不能写入', () => {
  const scope = fresh('off-stale');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  store.setEvolution(scope, false, { operationId: 'off_1' });
  const offline = commitNew(scope, grown, started);
  assert.equal(offline.ok, false);
  assert.equal(ruleRows(scope).length, 0);
});

test('P05 epoch 变了旧提案作废', () => {
  const scope = fresh('epoch-stale');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  store.setEvolution(scope, false, { operationId: 'off_2' });
  store.setEvolution(scope, true, { operationId: 'on_2' });
  const stale = commitNew(scope, grown, started);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /重新开启|作废/);
});

test('P02 两个独立作品后升为已生效，单次只到试用', () => {
  const scope = fresh('promote');
  enable(scope);
  const one = seedEpisode(scope, { sessionId: 'a', messageIds: ['a1'] });
  const first = commitNew(scope, one, begin(scope, one), NEW_CHANGE);
  assert.equal(first.ok, true, first.reason);
  let id = ruleRows(scope)[0].id;
  assert.equal(ruleOf(scope, id).learning.state, 'trial');
  const two = seedEpisode(scope, { sessionId: 'b', messageIds: ['b1'] });
  const version = ruleOf(scope, id).revision;
  const rules = [{ ref: 'r0', id, revision: version, conditions: [{ key: 'seriesId', value: '口播' }] }];
  const refs = { feedback: { u0: 'b1' }, rules: { r0: id } };
  const check = parsed({ target: 'r0', feedbackType: 'spec_change', currentText: NEW_CHANGE.currentText, evidence: ['u0'] }, { rules, refs });
  const second = store.commitLearning(scope, {
    operationId: 'learn_promote',
    epoch: begin(scope, two).epoch,
    episodeId: two.episode.episodeId,
    episodeUpdatedAt: two.episode.updatedAt,
    projectId: 'proj',
    sessionId: two.sessionId,
    messageIds: two.messageIds,
    changes: check.changes,
    preparedTargets: [{ id, revision: version, specDigest: ruleOf(scope, id).learning.specDigest }],
  });
  assert.equal(second.ok, true, second.reason);
  id = ruleRows(scope)[0].id;
  assert.equal(ruleOf(scope, id).learning.state, 'active');
  assert.equal(ruleOf(scope, id).learning.supportedEpisodeIds.length, 2);
});

test('D01 撤回过且没有上一版时拒撤回', () => {
  const scope = fresh('undo-empty');
  enable(scope);
  const grown = seedEpisode(scope);
  assert.equal(commitNew(scope, grown, begin(scope, grown)).ok, true);
  const id = ruleRows(scope)[0].id;
  const result = store.undoLearningChange(scope, id, { expectedRevision: ruleOf(scope, id).revision, operationId: 'undo_1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /上一版/);
});

test('D02 版本对不上就拒绝撤回，旧正文不覆盖新版本', () => {
  const scope = fresh('undo-stale');
  enable(scope);
  const grown = seedEpisode(scope);
  assert.equal(commitNew(scope, grown, begin(scope, grown)).ok, true);
  const id = ruleRows(scope)[0].id;
  const version = ruleOf(scope, id).revision;
  const rules = [{ ref: 'r0', id, revision: version, conditions: [{ key: 'seriesId', value: '口播' }] }];
  const refs = { feedback: { u0: 'm1' }, rules: { r0: id } };
  const check = parsed({ target: 'r0', feedbackType: 'spec_change', currentText: '开头两句内给结论。', evidence: ['u0'] }, { rules, refs });
  const updated = store.commitLearning(scope, {
    operationId: 'learn_undo_newer',
    epoch: begin(scope, grown).epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    changes: check.changes,
    preparedTargets: [{ id, revision: version, specDigest: ruleOf(scope, id).learning.specDigest }],
  });
  assert.equal(updated.ok, true, updated.reason);
  const stale = store.undoLearningChange(scope, id, { expectedRevision: version, operationId: 'undo_stale' });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /刷新/);
  assert.match(ruleOf(scope, id).body, /两句/);
  const undo = store.undoLearningChange(scope, id, { expectedRevision: ruleOf(scope, id).revision, operationId: 'undo_ok' });
  assert.equal(undo.ok, true, undo.reason);
  assert.match(ruleOf(scope, id).body, /三句/);
  assert.equal(ruleOf(scope, id).learning.state, 'paused');
});

test('D03 负反馈先本地暂停，恢复只回到试用', () => {
  const scope = fresh('pause');
  enable(scope);
  const grown = seedEpisode(scope);
  assert.equal(commitNew(scope, grown, begin(scope, grown)).ok, true);
  const id = ruleRows(scope)[0].id;
  const paused = store.pauseLearningRules(scope, [id], { operationId: 'pause_1', by: 'feedback', reason: 'feedback_pending' });
  assert.equal(paused.ok, true);
  assert.equal(paused.changed, true);
  assert.equal(ruleOf(scope, id).learning.state, 'paused');
  const resumed = store.resumeLearningRule(scope, id, { operationId: 'resume_1' });
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(ruleOf(scope, id).learning.state, 'trial');
  assert.equal(ruleOf(scope, id).learning.blockedReason, undefined);
});

test('D05 候选缺值或未知键不写入', () => {
  assert.equal(parsed({ ...NEW_CHANGE, topicKey: undefined }).ok, false);
  assert.equal(parsed({ ...NEW_CHANGE, currentText: undefined }).ok, false);
  assert.equal(parsed({ ...NEW_CHANGE, currentText: 'x'.repeat(241) }).ok, false);
  assert.equal(parsed({ ...NEW_CHANGE, applicability: 'sometimes' }).ok, false);
  assert.equal(parsed({ ...NEW_CHANGE, persistence: 'global' }).ok, false);
});

test('D06 同名规则条件不同就各存一条', () => {
  const scope = fresh('no-merge');
  enable(scope);
  const one = seedEpisode(scope, { sessionId: 'c1', messageIds: ['c1'] });
  assert.equal(commitNew(scope, one, begin(scope, one), NEW_CHANGE).ok, true);
  const two = seedEpisode(scope, { sessionId: 'c2', messageIds: ['c2'] });
  const refs = { feedback: { u0: 'c2' }, rules: {} };
  const changed = { ...NEW_CHANGE, conditions: [{ key: 'phase', value: 'edit' }] };
  const check = learning.parseOutput(JSON.stringify({ changes: [changed] }), { finish: { kind: 'stop' }, refs, rules: [], ranges: RANGES });
  assert.equal(check.ok, true, check.reason);
  const second = store.commitLearning(scope, {
    operationId: 'learn_no_merge',
    epoch: begin(scope, two).epoch,
    episodeId: two.episode.episodeId,
    episodeUpdatedAt: two.episode.updatedAt,
    projectId: 'proj',
    sessionId: two.sessionId,
    messageIds: two.messageIds,
    changes: check.changes,
    preparedTargets: [],
  });
  assert.equal(second.ok, true, second.reason);
  assert.equal(ruleRows(scope).length, 2);
});

test('B06 待确认候选到上限后拒绝新建', () => {
  const scope = fresh('pending-cap');
  enable(scope);
  for (let index = 0; index < learning.LIMITS.pending; index += 1) {
    const grown = seedEpisode(scope, { sessionId: `p${index}`, messageIds: [`pm${index}`] });
    const change = { ...NEW_CHANGE, topicKey: `主题${index}`, applicability: 'unresolved', conditions: [] };
    const result = commitNew(scope, grown, begin(scope, grown), change);
    assert.equal(result.ok, true, `${index}:${result.reason}`);
  }
  const overflow = seedEpisode(scope, { sessionId: 'p99', messageIds: ['pm99'] });
  const blocked = commitNew(scope, overflow, begin(scope, overflow), { ...NEW_CHANGE, topicKey: '主题溢出', applicability: 'unresolved', conditions: [] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /上限/);
});

test('B06 失败调用只留回执不写正文', () => {
  const scope = fresh('failure');
  enable(scope);
  const grown = seedEpisode(scope);
  const started = begin(scope, grown);
  const result = store.recordLearningFailure(scope, {
    operationId: 'learn_fail_1',
    episodeId: grown.episode.episodeId,
    epoch: started.epoch,
    reason: '整理没有返回内容',
    usage: { known: false },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(ruleRows(scope).length, 0);
  const receipt = evolutionOf(scope).learning.receipts.at(-1);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.usage.known, false);
  assert.equal(receipt.reason, '整理没有返回内容');
});

test('P07 两条同批变化一次写入', () => {
  const scope = fresh('two-changes');
  enable(scope);
  const grown = seedEpisode(scope);
  const check = learning.parseOutput(JSON.stringify({
    changes: [NEW_CHANGE, { ...NEW_CHANGE, topicKey: '口播结尾', currentText: '结尾留一句行动提示。' }],
  }), { finish: { kind: 'stop' }, refs: REFS, rules: [], ranges: RANGES });
  assert.equal(check.ok, true, check.reason);
  const result = store.commitLearning(scope, {
    operationId: 'learn_two',
    epoch: begin(scope, grown).epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    changes: check.changes,
    preparedTargets: [],
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.touched, 2);
  assert.equal(ruleRows(scope).length, 2);
});

test('P08 超过两条变化整批拒绝', () => {
  const scope = fresh('too-many');
  enable(scope);
  const grown = seedEpisode(scope);
  const check = learning.parseOutput(JSON.stringify({
    changes: [NEW_CHANGE, { ...NEW_CHANGE, topicKey: 'b' }, { ...NEW_CHANGE, topicKey: 'c' }],
  }), { finish: { kind: 'stop' }, refs: REFS, rules: [], ranges: RANGES });
  assert.equal(check.ok, false);
  const result = store.commitLearning(scope, {
    operationId: 'learn_many',
    epoch: begin(scope, grown).epoch,
    episodeId: grown.episode.episodeId,
    episodeUpdatedAt: grown.episode.updatedAt,
    projectId: 'proj',
    sessionId: grown.sessionId,
    messageIds: grown.messageIds,
    changes: [NEW_CHANGE, NEW_CHANGE, NEW_CHANGE],
    preparedTargets: [],
  });
  assert.equal(result.ok, false);
  assert.equal(ruleRows(scope).length, 0);
});

test('P09 生命周期清理过期试用但保留固定规则', () => {
  const scope = fresh('lifecycle');
  enable(scope);
  const grown = seedEpisode(scope);
  assert.equal(commitNew(scope, grown, begin(scope, grown)).ok, true);
  const id = ruleRows(scope)[0].id;
  const now = Date.now() + learning.LIMITS.trialMs + 1000;
  const report = store.expireLearning(scope, { operationId: 'expire_1', now });
  assert.equal(report.ok, true, report.reason);
  assert.equal(ruleOf(scope, id).learning.state, 'paused');
  assert.equal(ruleOf(scope, id).learning.blockedReason, 'trial_expired');
  const later = now + learning.LIMITS.pausedMs + 1000;
  store.expireLearning(scope, { operationId: 'expire_2', now: later });
  assert.equal(ruleOf(scope, id), undefined);
});

test('D04 新状态格式不抹掉实验标记', () => {
  const scope = fresh('d04');
  enable(scope);
  const raw = fs.readFileSync(path.join(scope.dir, 'state.json'), 'utf8');
  assert.equal(JSON.parse(raw).format, 'dsh-lite-memory/state@4');
  const oldReader = (text) => {
    const data = JSON.parse(text);
    if (data.format !== 'dsh-lite-memory/state@2') throw new state.StateError('invalid', '旧版不认这个格式');
    return data.payload;
  };
  assert.throws(() => oldReader(raw), /旧版不认/);
  assert.equal(evolutionOf(scope).enabled, true);
  assert.equal(evolutionOf(scope).policyVersion, learning.POLICY_VERSION);
});

test('D07 关闭后仍可查看、固定与删除成果', () => {
  const scope = fresh('manage-off');
  enable(scope);
  const grown = seedEpisode(scope);
  assert.equal(commitNew(scope, grown, begin(scope, grown)).ok, true);
  const id = ruleRows(scope)[0].id;
  const off = store.setEvolution(scope, false, { operationId: 'off_manage' });
  assert.equal(off.ok, true, off.reason);
  const snapshot = store.learningSnapshot(scope);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.rules.some((rule) => rule.id === id), true);
  const pinned = store.pinLearningRule(scope, id, { pinned: true, expectedRevision: ruleOf(scope, id).revision, operationId: 'pin_off' });
  assert.equal(pinned.ok, true, pinned.reason);
  assert.equal(ruleOf(scope, id).learning.pinned, true);
  const removed = store.removeLearningRule(scope, id, { expectedRevision: ruleOf(scope, id).revision, operationId: 'delete_off' });
  assert.equal(removed.ok, true, removed.reason);
  assert.equal(store.loadIndex(scope).archived.some((row) => row.id === id), true);
  assert.equal(store.learningSnapshot(scope).rules.some((rule) => rule.id === id), false);
});

test('D08 删除按预期版本，旧版本不能误删', () => {
  const scope = fresh('delete-stale');
  enable(scope);
  const grown = seedEpisode(scope);
  assert.equal(commitNew(scope, grown, begin(scope, grown)).ok, true);
  const id = ruleRows(scope)[0].id;
  const before = ruleOf(scope, id).revision;
  const stale = store.removeLearningRule(scope, id, { expectedRevision: before - 1, operationId: 'delete_stale' });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /刷新/);
  const done = store.removeLearningRule(scope, id, { expectedRevision: before, operationId: 'delete_ok' });
  assert.equal(done.ok, true, done.reason);
});

test('D09 用量缺失只报未知，不补零', () => {
  const scope = fresh('economy-unknown');
  enable(scope);
  const grown = seedEpisode(scope);
  assert.equal(store.recordLearningFailure(scope, {
    operationId: 'learn_failed',
    episodeId: grown.episode.episodeId,
    reason: '模型超时',
  }).ok, true);
  const snapshot = store.learningSnapshot(scope);
  assert.equal(snapshot.economy.calls, 1);
  assert.equal(snapshot.economy.knownCalls, 0);
  assert.equal(snapshot.economy.inputTokens, null);
  assert.equal(snapshot.economy.outputTokens, null);
});

test('D10 效果摘要只算最近 64 条，未知用量不补零', () => {
  const scope = fresh('effect-window');
  enable(scope);
  const grown = seedEpisode(scope);
  assert.equal(commitNew(scope, grown, begin(scope, grown), NEW_CHANGE, {
    usage: { known: true, inputTokens: 30, outputTokens: 7 },
  }).ok, true);
  assert.equal(store.recordLearningFailure(scope, { operationId: 'effect_fail', episodeId: grown.episode.episodeId, reason: '模型超时' }).ok, true);
  const first = store.learningSnapshot(scope).effect;
  assert.equal(first.window, 2);
  assert.equal(first.applied, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.knownCalls, 1);
  assert.equal(first.inputTokens, 30);
  for (let i = 0; i < 70; i += 1) {
    assert.equal(store.recordLearningFailure(scope, { operationId: `effect_more_${i}`, episodeId: grown.episode.episodeId, reason: '超时' }).ok, true);
  }
  const after = store.learningSnapshot(scope).effect;
  assert.equal(after.window, 64);
  assert.equal(after.knownCalls, 0);
  assert.equal(after.inputTokens, null);
  assert.equal(after.outputTokens, null);
});

console.log(`learning.test.mjs: ${passed} passed`);
