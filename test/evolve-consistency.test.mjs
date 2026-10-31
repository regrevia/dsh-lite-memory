/**
 * 排序调参（evolve）的一致性回归：容量裁剪、摘要覆盖、证据/策略版本、单调回滚。
 * 全部离线：只碰临时目录，不读写用户记忆。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-evolve-consistency-'));

const evolve = await import('../evolve.js');
const evolveStore = await import('../evolve-store.js');
const state = await import('../state.js');
const view = await import('../view.js');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.message ? error.message : error}`);
  }
};

const mk = (id, extra = {}) => ({
  id,
  title: '',
  summary: '',
  when: '',
  body: '',
  kind: 'note',
  status: 'active',
  aliases: [],
  tags: [],
  triggers: [],
  conditions: [],
  applicability: 'all_in_scope',
  ...extra,
});

const newScope = () => state.scopeOf(fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-evolve-consistency-project-')));
const bytesOf = (scope) => Buffer.byteLength(fs.readFileSync(path.join(scope.dir, 'evolve.json'), 'utf8'));
const fileIds = (lab) => new Set(lab.replay.records.map((row) => String(row.id)));
const assertNoDanglingRefs = (lab, label) => {
  const ids = fileIds(lab);
  for (const item of lab.replay.cases) {
    for (const id of [...item.expectIds, ...item.forbidIds]) {
      assert.ok(ids.has(id), `${label}：题 ${item.id} 引用了不存在的记录 ${id}`);
    }
  }
};
const assertDigestMatches = (lab, label) => {
  const hydrated = evolveStore.materializeCases(lab);
  assert.equal(lab.replay.digest, evolve.replayDigestOf(hydrated, lab.params), `${label}：落盘摘要必须与最终数据一致`);
};

const smallCases = [{
  id: 'case-summary',
  query: '口播',
  expectIds: ['a'],
  forbidIds: [],
  records: [mk('a', { summary: '口播' }), mk('b', { when: '口播' })],
}];

/* ---------------- 摘要覆盖全部影响评测的输入 ---------------- */

await test('摘要覆盖正文/条件/触发词/标签/适用性，任一处变摘要就变', () => {
  const digestWith = (patch) => evolve.replayDigestOf([{ ...smallCases[0], records: [{ ...smallCases[0].records[0], ...patch }, smallCases[0].records[1]] }]);
  const base = evolve.replayDigestOf(smallCases);
  assert.equal(base, evolve.replayDigestOf(smallCases), '摘要必须稳定');
  assert.notEqual(base, digestWith({ body: '换了一段正文' }), '正文必须进摘要');
  assert.notEqual(base, digestWith({ when: '换个场合' }), 'when 必须进摘要');
  assert.notEqual(base, digestWith({ conditions: [{ key: 'taskKind', value: 'coding' }] }), '条件必须进摘要');
  assert.notEqual(base, digestWith({ triggers: ['口播'] }), '触发词必须进摘要');
  assert.notEqual(base, digestWith({ tags: ['口播'] }), '标签必须进摘要');
  assert.notEqual(base, digestWith({ applicability: 'conditional', conditions: [{ key: 'taskKind', value: 'coding' }] }), '适用性必须进摘要');
  assert.notEqual(base, digestWith({ status: 'archived' }), '状态必须进摘要');
  assert.notEqual(base, digestWith({ aliases: ['口播稿'] }), '别名必须进摘要');
});

await test('摘要覆盖答题卡与当前参数，参数变了摘要就变', () => {
  const base = evolve.replayDigestOf(smallCases);
  assert.notEqual(base, evolve.replayDigestOf([{ ...smallCases[0], expectIds: ['b'] }]), '期望 id 必须进摘要');
  assert.notEqual(base, evolve.replayDigestOf([{ ...smallCases[0], forbidIds: ['b'] }]), '禁止 id 必须进摘要');
  assert.notEqual(base, evolve.replayDigestOf(smallCases, { floor: 2.4, summaryWeight: 2.5 }), '策略参数必须进摘要');
  assert.notEqual(base, evolve.replayDigestOf(smallCases, { floor: 2.6, summaryWeight: 1.5 }), '阈值参数必须进摘要');
  assert.equal(evolve.replayDigestOf(smallCases).length, 64);
});

/* ---------------- 容量裁剪：不丢被标注的记录，不留悬空引用 ---------------- */

await test('60 条大记忆下裁剪优先保住刚标注的记录，且不留悬空引用', () => {
  const scope = newScope();
  const records = Array.from({ length: 60 }, (_, i) => mk(`r${i}`, { body: 'x'.repeat(5000) }));
  const marked = { id: 'case-marked', query: '第 56 个查询', expectIds: ['r55'], forbidIds: [] };
  const older = { id: 'case-old', query: '第一个查询', expectIds: ['r0'], forbidIds: [] };
  const frozen = evolveStore.freezeReplay(scope, [older, marked], { records });
  assert.equal(frozen.ok, true, `冻结应成功：${frozen.reason}`);
  const lab = evolveStore.readEvolve(scope).lab;
  assert.ok(lab.replay.records.length < 60, '必须真的裁剪了，才谈得上回归保护');
  assert.ok(fileIds(lab).has('r55'), '刚标注的目标记录必须留在落盘快照里');
  const markedOnDisk = lab.replay.cases.find((row) => row.id === 'case-marked');
  assert.ok(markedOnDisk, '刚标注的题必须留在快照里');
  assert.deepEqual(markedOnDisk.expectIds, ['r55']);
  assertNoDanglingRefs(lab, '裁剪后');
  assertDigestMatches(lab, '裁剪后');
  assert.equal(lab.replay.needsReeval, true, '容量整理改动了已评测样本，必须显式标记需要重评');
  assert.ok(bytesOf(scope) <= evolveStore.MAX_FILE_BYTES);
  assert.ok(evolve.replay(evolveStore.materializeCases(lab), lab.params).cases > 0, '裁剪后回放集不能是空的');
});

await test('裁剪后仍可直接采纳：摘要与最终数据一致，不受旧摘要干扰', () => {
  const scope = newScope();
  const records = Array.from({ length: 60 }, (_, i) => mk(`r${i}`, { body: 'x'.repeat(5000) }));
  const marked = { id: 'case-marked', query: '第 56 个查询', expectIds: ['r55'], forbidIds: [] };
  assert.equal(evolveStore.freezeReplay(scope, [marked], { records }).ok, true);
  const lab = evolveStore.readEvolve(scope).lab;
  const hydrated = evolveStore.materializeCases(lab);
  assert.ok(hydrated[0].records.some((row) => String(row.id) === 'r55'));
  const applied = evolveStore.applyProposal(scope, {
    key: 'summaryWeight',
    params: { ...evolve.DEFAULT_PARAMS, summaryWeight: 2.5 },
    metrics: null,
  }, { cases: hydrated });
  assert.equal(applied.ok, true, `裁剪后采纳不应报 replay_changed：${applied.reason}`);
  assert.equal(applied.lab.params.summaryWeight, 2.5);
  assert.equal(applied.lab.replay.needsReeval, false, '按最终数据采纳后不再需要重评');
  assertDigestMatches(applied.lab, '采纳后');
});

await test('容量再紧时减少题量并同步删除其引用，不写坏文件', () => {
  const scope = newScope();
  const records = Array.from({ length: 60 }, (_, i) => mk(`w${i}`, { body: 'y'.repeat(15000) }));
  const many = Array.from({ length: 24 }, (_, i) => ({
    id: `big-${i}`,
    query: `第 ${i} 个查询`,
    expectIds: [`w${i}`],
    forbidIds: [],
  }));
  const frozen = evolveStore.freezeReplay(scope, many, { records });
  assert.equal(frozen.ok, true, `冻结应成功：${frozen.reason}`);
  const lab = evolveStore.readEvolve(scope).lab;
  assert.ok(lab.replay.cases.length > 0, '至少保留一道题');
  assert.ok(lab.replay.cases.length < 24, '容量不够时必须减少题量，而不是写出坏引用');
  assert.ok(bytesOf(scope) <= evolveStore.MAX_FILE_BYTES);
  assertNoDanglingRefs(lab, '减题后');
  assertDigestMatches(lab, '减题后');
  assert.equal(lab.replay.needsReeval, true);
});

/* ---------------- 新反馈只更新证据，不动生效参数 ---------------- */

await test('新反馈只推进证据集版本，不重置生效参数与历史', () => {
  const scope = newScope();
  assert.equal(evolveStore.freezeReplay(scope, smallCases).ok, true);
  const firstPolicy = evolveStore.readEvolve(scope).lab;
  const adopted = evolveStore.applyProposal(scope, {
    key: 'summaryWeight',
    params: { ...evolve.DEFAULT_PARAMS, summaryWeight: 2.5 },
    metrics: null,
  }, { cases: smallCases });
  assert.equal(adopted.ok, true);
  const active = evolveStore.readEvolve(scope).lab;
  assert.equal(active.params.summaryWeight, 2.5);
  assert.equal(active.policy.revision, firstPolicy.policy.revision + 1);
  const evidenceBefore = active.replay.evidenceRevision;
  const policyBefore = active.policy.revision;

  // 新反馈：同一批题、但一条记录内容变了（真实用户又补了一条记忆内容）
  const next = [{ ...smallCases[0], records: [{ ...smallCases[0].records[0], body: '补了一段正文' }, smallCases[0].records[1]] }];
  const refrozen = evolveStore.freezeReplay(scope, next);
  assert.equal(refrozen.ok, true);
  assert.equal(refrozen.changed, true);
  const after = evolveStore.readEvolve(scope).lab;
  assert.equal(after.params.summaryWeight, 2.5, '新反馈绝不能把生效参数重置回默认');
  assert.equal(after.policy.revision, policyBefore, '只有采纳才推进策略版本');
  assert.equal(after.replay.evidenceRevision, evidenceBefore + 1, '新反馈必须推进证据集版本');
  assert.equal(after.replay.needsReeval, true, '证据变了，旧评测结果作废');
  assert.equal(after.history.length, active.history.length, '历史不能被新反馈清空');
  assert.equal(evolveStore.describeEvolve(scope).canRollback, true);
});

/* ---------------- 回滚单向推进，不在两档之间来回跳 ---------------- */

await test('采纳→回滚→再回滚：单向走回默认，不会弹回刚回滚掉的档位', () => {
  const scope = newScope();
  assert.equal(evolveStore.freezeReplay(scope, smallCases).ok, true);
  const step = (params) => evolveStore.applyProposal(scope, { key: 'summaryWeight', params, metrics: null }, { cases: smallCases });
  const sw = () => evolveStore.readEvolve(scope).lab.params.summaryWeight;

  assert.equal(step({ ...evolve.DEFAULT_PARAMS, summaryWeight: 2.5 }).ok, true);
  assert.equal(sw(), 2.5);
  const first = evolveStore.rollbackParams(scope);
  assert.equal(first.ok, true);
  assert.equal(sw(), 1.5);
  const second = evolveStore.rollbackParams(scope);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'nothing_to_rollback');
  assert.equal(sw(), 1.5, '第二次回滚不能把 2.5 又装回来');
  assert.equal(evolveStore.describeEvolve(scope).canRollback, false);
});

await test('8 步采纳＋回滚单调推进，参数不被新反馈重置', () => {
  const scope = newScope();
  assert.equal(evolveStore.freezeReplay(scope, smallCases).ok, true);
  /** 采纳时拿盘上当前冻结的那批题来核摘要：第 5 步换过反馈，不能再用旧的 smallCases。 */
  const apply = (params) => evolveStore.applyProposal(
    scope,
    { key: 'policy', params, metrics: null },
    { cases: evolveStore.materializeCases(evolveStore.readEvolve(scope).lab) },
  );
  const sw = () => evolveStore.readEvolve(scope).lab.params.summaryWeight;
  const floor = () => evolveStore.readEvolve(scope).lab.params.floor;
  const seen = [];
  const snap = (label) => {
    const lab = evolveStore.readEvolve(scope).lab;
    seen.push(`${label}:${lab.params.floor.toFixed(1)}/${lab.params.summaryWeight.toFixed(1)}`);
  };

  // 1 冻结；2 采纳 2.5；3 回滚 1.5；4 再回滚必须无路可退
  assert.equal(evolveStore.freezeReplay(scope, smallCases).ok, true);
  snap('freeze');
  assert.equal(apply({ ...evolve.DEFAULT_PARAMS, summaryWeight: 2.5 }).ok, true);
  snap('adopt-2.5');
  assert.equal(evolveStore.rollbackParams(scope).ok, true);
  snap('rollback-1.5');
  assert.equal(evolveStore.rollbackParams(scope).ok, false);
  snap('rollback-end');
  assert.equal(sw(), 1.5);

  // 5 新反馈（证据变了）不能重置参数；6 从当前档位再采纳一档
  const feedback = [{ ...smallCases[0], records: [{ ...smallCases[0].records[0], when: '新增场合' }, smallCases[0].records[1]] }];
  assert.equal(evolveStore.freezeReplay(scope, feedback).ok, true);
  snap('feedback');
  assert.equal(sw(), 1.5);
  assert.equal(floor(), 2.4);

  // 7 采纳 2.0；8 回滚回 2.4，再回滚不能再往前跳
  assert.equal(apply({ floor: 2.0, summaryWeight: 1.5 }).ok, true);
  snap('adopt-2.0');
  const back = evolveStore.rollbackParams(scope);
  assert.equal(back.ok, true);
  snap('rollback-2.4');
  assert.equal(floor(), 2.4);
  assert.equal(evolveStore.rollbackParams(scope).ok, false);
  snap('rollback-end-2');

  assert.deepEqual(seen, [
    'freeze:2.4/1.5',
    'adopt-2.5:2.4/2.5',
    'rollback-1.5:2.4/1.5',
    'rollback-end:2.4/1.5',
    'feedback:2.4/1.5',
    'adopt-2.0:2.0/1.5',
    'rollback-2.4:2.4/1.5',
    'rollback-end-2:2.4/1.5',
  ], '回滚必须单调往回走：2.4/1.5 → 2.4/2.5 → 2.4/1.5 → 2.0/1.5 → 2.4/1.5');
});

await test('回滚不动历史（只有采纳写策略历史），历史有上限', () => {
  const scope = newScope();
  assert.equal(evolveStore.freezeReplay(scope, smallCases).ok, true);
  for (let i = 0; i < evolveStore.MAX_HISTORY + 4; i += 1) {
    const params = { ...evolve.DEFAULT_PARAMS, summaryWeight: i % 2 === 0 ? 1.0 : 2.5 };
    evolveStore.applyProposal(scope, { key: 'summaryWeight', params, metrics: null }, { cases: smallCases });
  }
  const lab = evolveStore.readEvolve(scope).lab;
  assert.equal(lab.history.length, evolveStore.MAX_HISTORY);
  const before = lab.history.length;
  evolveStore.rollbackParams(scope);
  assert.equal(evolveStore.readEvolve(scope).lab.history.length, before, '回滚不是一次采纳，不能往历史里写新行');
  assert.ok(evolveStore.describeEvolve(scope).canRollback, '历史里还有更早的档位，应继续可回滚');
});

await test('摘要里带上参数后，回滚写回的策略摘要仍自洽', () => {
  const scope = newScope();
  assert.equal(evolveStore.freezeReplay(scope, smallCases).ok, true);
  assert.equal(evolveStore.applyProposal(scope, {
    key: 'summaryWeight',
    params: { ...evolve.DEFAULT_PARAMS, summaryWeight: 2.5 },
    metrics: null,
  }, { cases: smallCases }).ok, true);
  const rolled = evolveStore.rollbackParams(scope);
  assert.equal(rolled.ok, true);
  const lab = evolveStore.readEvolve(scope).lab;
  assertDigestMatches(lab, '回滚后');
  const hydrated = evolveStore.materializeCases(lab);
  assert.equal(evolveStore.applyProposal(scope, {
    key: 'floor',
    params: { floor: 2.0, summaryWeight: 1.5 },
    metrics: null,
  }, { cases: hydrated }).ok, true, '回滚后按最终参数重算的摘要应允许继续采纳');
});

/* ---------------- 显示层拿到版本信息 ---------------- */

await test('面板同时给出证据集版本、策略版本与是否待重评', () => {
  const scope = newScope();
  assert.equal(evolveStore.freezeReplay(scope, smallCases).ok, true);
  const described = evolveStore.describeEvolve(scope);
  assert.equal(typeof described.evidenceRevision, 'number');
  assert.equal(typeof described.policyRevision, 'number');
  assert.equal(described.needsReeval, true);
  assert.equal(described.evidenceRevision, 1);
  assert.equal(described.policyRevision, 0);
});

console.log(failed ? `evolve-consistency.test.mjs: ${failed} failed, ${passed} passed` : `evolve-consistency.test.mjs: ${passed} passed`);
if (failed) process.exitCode = 1;
