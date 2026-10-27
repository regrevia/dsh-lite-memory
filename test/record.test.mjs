import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-record-'));
const store = await import('../store.js');

const { upsert, search, readEntry, loadIndex, scopeOf } = store;

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
  const dir = path.join(os.tmpdir(), `lite-memory-record-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return scopeOf(dir);
};

const stateFile = (scope) => path.join(scope.dir, 'state.json');
/** 直接改热状态里的记录字段：有效期这类时间无法靠等待制造。 */
const patchEntry = (scope, id, patch) => {
  const raw = JSON.parse(fs.readFileSync(stateFile(scope), 'utf8'));
  const entry = raw.payload.entries.find((row) => row.id === id);
  assert.ok(entry, `state 里没有 ${id}`);
  Object.assign(entry, patch);
  /** 状态带校验和：直接改字段要同步重算，否则等于伪造损坏文件。 */
  raw.checksum = `sha256:${crypto.createHash('sha256').update(JSON.stringify(raw.payload)).digest('hex')}`;
  fs.writeFileSync(stateFile(scope), `${JSON.stringify(raw, null, 2)}\n`);
};

test('supersedes 给旧记录打取代链，新记录拿到旧正文版本', () => {
  const scope = fresh('chain');
  const oldOne = upsert(scope, {
    title: '发版命令', summary: '发版用 npm run release。', body: 'npm run release 出一条版本记录。', kind: 'procedure',
  });
  const newOne = upsert(scope, {
    title: '发版流程', summary: '发版改成先跑测试再发。', body: '先 npm test，再 npm run release。', kind: 'procedure',
    supersedes: oldOne.record.id, resolution: 'distinct',
  });
  assert.equal(newOne.merged, false);
  const index = loadIndex(scope);
  const oldRecord = index.entries.find((item) => item.id === oldOne.record.id);
  assert.equal(oldRecord.supersededBy, newOne.record.id);
  assert.equal(oldRecord.supersedeReason, 'user_replaced');
  assert.ok(Date.parse(oldRecord.validUntil) > 0, '旧记录必须带失效时间');
  const newRecord = index.entries.find((item) => item.id === newOne.record.id);
  assert.ok(Array.isArray(newRecord.versions) && newRecord.versions.length >= 1);
  assert.match(newRecord.versions[0].body, /npm run release/);
  /** 取代后旧正文仍能整段读出来：历史不是只留标题。 */
  assert.match(readEntry(scope, oldOne.record.id).body, /npm run release/);
});

test('默认检索看不见被取代的，history 里看得见并带取代来源', () => {
  const scope = fresh('hidden');
  const oldOne = upsert(scope, { title: '部署目标', summary: '部署到 staging。', body: 'staging 先验。' });
  const newOne = upsert(scope, {
    title: '部署目标机', summary: '部署到 production。', body: 'production 才对外。',
    supersedes: oldOne.record.id, resolution: 'distinct',
  });
  const plain = search(scope, '部署', 4).map((item) => item.id);
  assert.ok(plain.includes(newOne.record.id));
  assert.equal(plain.includes(oldOne.record.id), false);
  const historical = search(scope, '部署', 4, { history: true }).map((item) => item.id);
  assert.ok(historical.includes(oldOne.record.id));
});

test('过了有效期的记录默认不出现，history 里还在', () => {
  const scope = fresh('expired');
  const saved = upsert(scope, { title: '临时端口', summary: '服务跑在 18080。', body: '本地调试端口。' });
  patchEntry(scope, saved.record.id, { validFrom: new Date(Date.now() - 7200_000).toISOString(), validUntil: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(search(scope, '端口', 4).some((item) => item.id === saved.record.id), false);
  assert.equal(search(scope, '端口', 4, { history: true }).some((item) => item.id === saved.record.id), true);
});

test('有效截止时间在将来仍然算现行', () => {
  const scope = fresh('future');
  const saved = upsert(scope, { title: '试用期规则', summary: '试用期三个月。', body: '到期前都按这条。' });
  patchEntry(scope, saved.record.id, { validUntil: new Date(Date.now() + 86400_000).toISOString() });
  assert.equal(search(scope, '试用期', 4).some((item) => item.id === saved.record.id), true);
});

test('同一条不能被取代两次，也不能取代自己', () => {
  const scope = fresh('twice');
  const a = upsert(scope, { title: '第一条', summary: '甲的结论。', body: '甲。' });
  const b = upsert(scope, { title: '第二条', summary: '乙的结论。', body: '乙。', supersedes: a.record.id, resolution: 'distinct' });
  assert.throws(() => upsert(scope, { title: '第三条', summary: '丙的结论。', body: '丙。', supersedes: a.record.id, resolution: 'distinct' }),
    (error) => error.code === 'conflict' && /取代/.test(error.message));
  assert.throws(() => upsert(scope, { id: b.record.id, title: '第二条', summary: '乙的结论。', body: '乙。', supersedes: b.record.id }),
    /不能取代自己/);
});

test('取代不存在的 id 直接报错，不静默新建', () => {
  const scope = fresh('missing');
  assert.throws(() => upsert(scope, { title: '新条目', summary: '随手一条。', body: '正文。', supersedes: 'mem_000000000000' }),
    /不在这一层/);
  assert.equal(loadIndex(scope).entries.length, 0);
});

test('重新更新被取代的条目会摘掉取代链，回到现行', () => {
  const scope = fresh('revive');
  const a = upsert(scope, { title: '配色规则', summary: '主色用蓝。', body: '蓝。' });
  upsert(scope, { title: '配色规则二', summary: '主色改用墨绿。', body: '墨绿。', supersedes: a.record.id, resolution: 'distinct' });
  upsert(scope, { id: a.record.id, summary: '主色回到蓝。', body: '深蓝。' });
  const revived = loadIndex(scope).entries.find((item) => item.id === a.record.id);
  assert.equal(revived.supersededBy || '', '');
  assert.equal(revived.validUntil || '', '');
  assert.ok(search(scope, '配色', 4).some((item) => item.id === a.record.id));
});

test('没有生命周期字段的旧记录照常可读可搜', () => {
  const scope = fresh('legacy');
  const saved = upsert(scope, { title: '旧数据兼容', summary: '老记录没有新字段。', body: '正文照旧。' });
  patchEntry(scope, saved.record.id, { validFrom: undefined, validUntil: undefined, supersededBy: undefined, supersedeReason: undefined });
  const record = loadIndex(scope).entries.find((item) => item.id === saved.record.id);
  assert.equal(record.supersededBy, '');
  assert.equal(search(scope, '旧数据', 4).some((item) => item.id === saved.record.id), true);
  assert.match(readEntry(scope, saved.record.id).body, /正文照旧/);
});

console.log(`record.test.mjs: ${passed} passed`);
