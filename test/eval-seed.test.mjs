/**
 * 39 条固定样本的召回基线：14 该召回、15 该拒绝、10 该等条件确认。
 * 只断言行为（召回率 / 误触发 / 边界外泄），措辞取用户原话视角。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-eval-'));
const view = await import('../view.js');

import { MEM, RECALL, REJECT, AWAIT } from './recall-eval-fixtures.mjs';

const titleOf = (row) => row.record.title;
const rank = (query, context = {}) => view.rank(MEM, query, { limit: 3, requireApplicable: true, context });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`eval: ${name}`);
};

test(`该召回的 ${RECALL.length} 条都进前三`, () => {
  const missed = RECALL.filter(([query, want]) => !rank(query).slice(0, 3).some((row) => titleOf(row) === want));
  const recallAt3 = (RECALL.length - missed.length) / RECALL.length;
  assert.ok(recallAt3 >= 0.9, `Recall@3 ${recallAt3}；漏了：${missed.map((row) => row[0]).join('、')}`);
});

test(`该拒绝的 ${REJECT.length} 条一条都不出现`, () => {
  const leaked = REJECT.filter((query) => rank(query).length > 0);
  assert.equal(leaked.length, 0, `误触发：${leaked.join('、')}`);
});

test(`条件未确认的 ${AWAIT.length} 条不会当作已适用出现`, () => {
  const exposed = AWAIT.filter(([query, want]) => rank(query).some((row) => titleOf(row) === want));
  assert.equal(exposed.length, 0, `条件未知却进了上下文：${exposed.map((row) => row[0]).join('、')}`);
});

test('条件确认之后同一条就能用', () => {
  const rows = rank('这台机器部署前要确认什么？', { taskKind: 'deploy' });
  assert.ok(rows.some((row) => titleOf(row) === '部署前确认目标机器'));
});

test('措辞不同也能召回（同义说法不依赖逐字重合）', () => {
  assert.ok(rank('热刷新不生效是不是要重启').some((row) => titleOf(row) === '插件改完先试热刷新'));
});

console.log(`eval: ${passed} passed`);
