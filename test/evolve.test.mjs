/**
 * 受限自进化的回放与采纳规则。全部离线：不调模型、不写用户记忆。
 * 用例风格跟现有测试一致：test(name, fn) 立即执行，最后汇总。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-evolve-'));

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
  body: '正文',
  kind: 'note',
  status: 'active',
  aliases: [],
  tags: [],
  triggers: [],
  conditions: [],
  applicability: 'all_in_scope',
  ...extra,
});

/**
 * 一条真漏报：只在摘要里出现的记忆，默认权重下够不到阈值（1.5 < 2.4），
 * 权重升一档到 2.5 才进前三。这就是「该想起却没想起」，不是靠造分造出来的。
 */
const cases = [{
  id: 'case-summary',
  query: '口播',
  expectIds: ['a'],
  forbidIds: [],
  records: [
    mk('a', { summary: '口播' }),
    mk('b', { when: '口播' }),
  ],
}];

await test('参数只接受白名单档位，非法值回落默认', () => {
  assert.deepEqual(evolve.normalizeParams({ floor: 2.7, summaryWeight: 9 }), { floor: 2.4, summaryWeight: 1.5 });
  assert.deepEqual(evolve.normalizeParams({ floor: 2.6, summaryWeight: 2.5 }), { floor: 2.6, summaryWeight: 2.5 });
});

await test('阈值参数真的生效：2.5 分在 2.6 下被挡、2.4 下保留', () => {
  const records = [mk('d', { summary: '口播', when: '口播' })];
  const strict = view.rank(records, '口播', { limit: 4, params: { floor: 2.6 } });
  const loose = view.rank(records, '口播', { limit: 4, params: { floor: 2.4 } });
  assert.equal(strict.length, 0);
  assert.equal(loose.length, 1);
});

await test('回放摘要只认答题卡：期望顺序不影响，查询变了就变', () => {
  const a = evolve.replayDigestOf([{ ...cases[0], expectIds: ['a', 'b'] }]);
  const b = evolve.replayDigestOf([{ ...cases[0], expectIds: ['b', 'a'] }]);
  assert.equal(a, b);
  assert.notEqual(a, evolve.replayDigestOf([{ ...cases[0], query: '封面' }]));
});

await test('回放给出命中数、位置分与误报数', () => {
  const base = evolve.replay(cases, { summaryWeight: 1.5 });
  assert.equal(base.cases, 1);
  assert.equal(base.hit, 0);
  assert.equal(base.position, 4);
  const better = evolve.replay(cases, { summaryWeight: 2.5 });
  assert.equal(better.hit, 1);
  assert.equal(better.position, 1);
});

await test('一次只提一个参数、只走一档，且必须整体不变差', () => {
  const { proposal } = evolve.proposeChange(cases, { floor: 2.4, summaryWeight: 1.5 });
  assert.ok(proposal, '应该找到摘要权重这一档');
  assert.equal(proposal.key, 'summaryWeight');
  assert.equal(proposal.from, 1.5);
  assert.equal(proposal.to, 2.5);
  const changed = Object.keys(proposal.params).filter((key) => proposal.params[key] !== evolve.DEFAULT_PARAMS[key]);
  assert.deepEqual(changed, ['summaryWeight']);
});

await test('没有任何一条变好时不提改动', () => {
  const flat = [{ ...cases[0], expectIds: ['b'], forbidIds: [] }];
  const { proposal } = evolve.proposeChange(flat, { floor: 2.4, summaryWeight: 1.5 });
  assert.equal(proposal, null);
});

await test('有一条变差就整批否决', () => {
  const before = { rows: [{ id: 'x', hit: 1, falseHit: 0, position: 1 }] };
  const after = { rows: [{ id: 'x', hit: 0, falseHit: 0, position: 4 }] };
  assert.equal(evolve.compareReplay(before, after).ok, false);
  const same = { rows: [{ id: 'x', hit: 1, falseHit: 0, position: 1 }] };
  assert.equal(evolve.compareReplay(before, same).ok, false, '平手也不算进步');
});

const scope = state.scopeOf(fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-evolve-project-')));

await test('冻结回放集落盘，摘要稳定', () => {
  const first = evolveStore.freezeReplay(scope, cases);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  const again = evolveStore.freezeReplay(scope, cases);
  assert.equal(again.changed, false);
  const described = evolveStore.describeEvolve(scope);
  assert.equal(described.replayCases, 1);
  assert.equal(described.params.summaryWeight, 1.5);
});

await test('摘要对不上就拒绝采纳', () => {
  const { proposal } = evolve.proposeChange(cases, { summaryWeight: 1.5 });
  const result = evolveStore.applyProposal(scope, proposal, { cases: [{ ...cases[0], query: '别的' }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'replay_changed');
});

await test('采纳后写进历史，回滚取回上一组参数', () => {
  const { proposal } = evolve.proposeChange(cases, { summaryWeight: 1.5 });
  const applied = evolveStore.applyProposal(scope, proposal, { cases });
  assert.equal(applied.ok, true);
  assert.equal(applied.lab.params.summaryWeight, 2.5);
  const described = evolveStore.describeEvolve(scope);
  assert.equal(described.canRollback, true);
  assert.equal(described.lastChange.key, 'summaryWeight');
  assert.equal(described.lastChange.from, 1.5);
  assert.equal(described.lastChange.to, 2.5);
  const back = evolveStore.rollbackParams(scope);
  assert.equal(back.ok, true);
  assert.equal(evolveStore.describeEvolve(scope).params.summaryWeight, 1.5);
});

await test('重复采纳同一组参数返回 no_change，不刷历史', () => {
  const before = evolveStore.readEvolve(scope).lab;
  const { proposal } = evolve.proposeChange(cases, { summaryWeight: 1.5 });
  const first = evolveStore.applyProposal(scope, proposal, { cases });
  assert.equal(first.ok, true);
  const second = evolveStore.applyProposal(scope, proposal, { cases });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'no_change');
  assert.equal(evolveStore.readEvolve(scope).lab.history.length, before.history.length + 1);
});

await test('换了回放集就重置参数与历史，不拿旧成绩背书', () => {
  const next = [{ ...cases[0], query: '封面' }];
  const result = evolveStore.freezeReplay(scope, next);
  assert.equal(result.changed, true);
  assert.deepEqual(result.lab.params, evolve.DEFAULT_PARAMS);
  assert.equal(result.lab.history.length, 0);
});

await test('历史有上限，不会无限增长', () => {
  let now = Date.now();
  for (let i = 0; i < evolveStore.MAX_HISTORY + 4; i += 1) {
    const params = { ...evolve.DEFAULT_PARAMS, summaryWeight: i % 2 === 0 ? 1.0 : 2.5 };
    now += 1000;
    evolveStore.applyProposal(scope, { key: 'summaryWeight', params, metrics: null }, { cases: [{ ...cases[0], query: '封面' }], now });
  }
  assert.equal(evolveStore.readEvolve(scope).lab.history.length, evolveStore.MAX_HISTORY);
});

await test('损坏的实验室文件当没做过实验，不抛异常', () => {
  fs.mkdirSync(scope.dir, { recursive: true });
  fs.writeFileSync(path.join(scope.dir, 'evolve.json'), '{坏掉的', 'utf8');
  const { lab, corrupt } = evolveStore.readEvolve(scope);
  assert.equal(corrupt, true);
  assert.deepEqual(lab.params, evolve.DEFAULT_PARAMS);
  const described = evolveStore.describeEvolve(scope);
  assert.equal(described.corrupt, true);
  assert.equal(described.canRollback, false);
});

console.log(failed ? `evolve.test.mjs: ${failed} failed, ${passed} passed` : `evolve.test.mjs: ${passed} passed`);
if (failed) process.exitCode = 1;
