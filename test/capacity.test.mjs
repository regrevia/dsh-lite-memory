/**
 * 容量按真实字节算：写盘前量体积，超限按固定顺序让路，压不下去整笔拒绝并保住旧状态。
 * 目标不是「永远写得进去」，而是「写不进去也说清楚，并且读回来一定不是坏文件」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-capacity-'));
process.env.DSH_HOME = home;
const personaStore = await import('../persona-store.js');
const evolveStore = await import('../evolve-store.js');
const evolve = await import('../evolve.js');

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
const root = path.join(home, 'lite-memory');
const reset = () => fs.rmSync(root, { recursive: true, force: true });
const personaFile = () => path.join(root, 'persona.json');

const evidenceRows = (count) => Array.from({ length: count }, (_, index) => ({
  id: `ev-${index}`,
  at: at(index),
  dimension: 'answer_order',
  value: 'conclusion_first',
  polarity: 'support',
  basis: 'repeat_choice',
  sessionId: `s${index}`,
  taskId: `t${index}`,
  projectId: 'p1',
  date: at(index).slice(0, 10),
  dedupeKey: `k-${index}-${'x'.repeat(170)}`,
}));

/** 造一份接近上限、但读回来仍然合法的画像：从多到少找第一条不超限的。 */
const seedNearCap = () => {
  const state = personaStore.readPersona({ userId: 'u1' }).persona;
  state.control.enabled = true;
  const sizeOf = (count) => Buffer.byteLength(JSON.stringify(personaStore.normalizePersona({ ...state, evidence: evidenceRows(count) })));
  let chosen = 0;
  for (let count = personaStore.MAX_EVIDENCE; count > 100; count -= 1) {
    if (sizeOf(count) <= personaStore.MAX_FILE_BYTES - 64) { chosen = count; break; }
  }
  assert.ok(chosen > 100, '应能造出接近上限、且高于压缩线的画像');
  state.evidence = evidenceRows(chosen);
  const written = personaStore.writePersona(state, { userId: 'u1', revision: state.revision });
  assert.equal(written.ok, true);
  assert.equal(written.persona.evidence.length, chosen, '前置状态不应触发压缩');
  return written.persona;
};

const seedSnippet = (index) => ({
  text: `以后先给结论，别铺垫，第 ${index} 次`,
  sessionId: `s${index}`, taskId: `t${index}`, projectId: 'p1',
});

test('证据挤满 64KB 时仍能继续收片段：先丢最老的证据，文件读回来还是好的', () => {
  reset();
  personaStore.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  const seeded = seedNearCap();
  const before = fs.statSync(personaFile()).size;
  assert.ok(before > 50 * 1024, `前置状态应接近上限，实际 ${before}`);
  let last = null;
  for (let index = 0; index < 6; index += 1) {
    last = personaStore.queuePersonaPending({ userId: 'u1', now: at(20 + index), snippet: seedSnippet(index) });
    assert.equal(last.ok, true, `第 ${index + 1} 条片段应写得进去：${last.reason || ''}`);
  }
  const read = personaStore.readPersona({ userId: 'u1' });
  assert.equal(read.corrupt, false);
  assert.equal(read.persona.pending.length, 6);
  assert.ok(read.persona.evidence.length < seeded.evidence.length, '证据按策略让了路');
  assert.ok(fs.statSync(personaFile()).size <= personaStore.MAX_FILE_BYTES);
});

test('容量吃紧时关闭开关仍然写得进去，不会把用户卡在关不掉的状态', () => {
  reset();
  personaStore.setPersonaEnabled({ enabled: true, userId: 'u1', now: at(0) });
  seedNearCap();
  const off = personaStore.setPersonaEnabled({ enabled: false, userId: 'u1', now: at(30) });
  assert.equal(off.ok, true);
  assert.equal(off.persona.control.enabled, false);
  assert.equal(personaStore.readPersona({ userId: 'u1' }).corrupt, false);
});

const bigRecord = (index, bytes) => ({
  id: `r${index}`, title: 'x'.repeat(bytes), summary: '', when: '', aliases: [],
});
const caseOf = (index) => ({
  id: `case-${index}`, query: `第 ${index} 个查询`, expectIds: ['r1'], forbidIds: [], context: { taskKind: 'coding' },
});

test('60 道大回放题共用一份快照：文件留在上限内，读回来不判损坏', () => {
  reset();
  const scope = { dir: path.join(root, 'global'), key: 'global' };
  const records = Array.from({ length: 60 }, (_, index) => bigRecord(index, 3000));
  const cases = [];
  for (let index = 0; index < 60; index += 1) {
    cases.push(caseOf(index));
    const frozen = evolveStore.freezeReplay(scope, cases.slice(-evolve.LIMITS.maxCases), { records });
    assert.equal(frozen.ok, true, `第 ${index + 1} 题应冻结成功：${frozen.reason || ''}`);
  }
  const size = fs.statSync(path.join(scope.dir, 'evolve.json')).size;
  assert.ok(size <= evolveStore.MAX_FILE_BYTES, `文件应留在上限内，实际 ${size}`);
  const read = evolveStore.readEvolve(scope);
  assert.equal(read.corrupt, false);
  assert.equal(read.lab.replay.cases.length, evolve.LIMITS.maxCases);
  assert.equal(read.lab.replay.records.length, 60);
  const hydrated = evolveStore.materializeCases(read.lab);
  assert.equal(hydrated[0].records.length, 60, '每道题都能拿到共用快照');
  assert.ok(evolve.replay(hydrated, read.lab.params).cases > 0);
});

test('题目大到压不下去就整笔拒绝，磁盘上仍是上一份能读的状态', () => {
  reset();
  const scope = { dir: path.join(root, 'global'), key: 'global' };
  const small = evolveStore.freezeReplay(scope, [caseOf(1)], { records: [bigRecord(1, 100)] });
  assert.equal(small.ok, true);
  const digest = small.lab.replay.digest;
  const huge = [bigRecord(1, 400 * 1024)];
  const frozen = evolveStore.freezeReplay(scope, [caseOf(2)], { records: huge });
  assert.equal(frozen.ok, false);
  assert.equal(frozen.reason, 'too_large');
  const read = evolveStore.readEvolve(scope);
  assert.equal(read.corrupt, false);
  assert.equal(read.lab.replay.digest, digest, '拒绝时不动上一份冻结集');
});

test('旧版把整份快照当摘要：读到时自动换成定长哈希，冻结集不用重建', () => {
  reset();
  const scope = { dir: path.join(root, 'global'), key: 'global' };
  const records = [bigRecord(0, 400)];
  const frozen = evolveStore.freezeReplay(scope, [caseOf(0)], { records });
  assert.equal(frozen.ok, true);
  const file = path.join(scope.dir, 'evolve.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.replay.digest = JSON.stringify([{ id: 'legacy' }]);
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  const read = evolveStore.readEvolve(scope);
  assert.equal(read.corrupt, false);
  assert.equal(read.lab.replay.digest.length, 64, '摘要应是 sha256 十六进制');
  assert.ok(evolve.replay(evolveStore.materializeCases(read.lab), read.lab.params).cases > 0);
});

console.log('test/capacity.test.mjs: %d passed', passed);
