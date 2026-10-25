import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-state-'));
const state = await import('../state.js');

const { LIMITS, StateError, scopeOf, globalScope, memoryRoot, resolveRoot, load, transact,
  readEntryBody, migrateLegacy, migrationReport, withScopeLock, validateState, emptyState } = state;

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

const dirs = [];
const fresh = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lm-state-${label}-`));
  dirs.push(dir);
  return scopeOf(dir);
};
const stateFile = (scope) => path.join(scope.dir, 'state.json');
const raw = (scope) => fs.readFileSync(stateFile(scope), 'utf8');
const bodyOf = (scope, id) => {
  const entry = load(scope).state.entries.find((row) => row.id === id);
  return entry ? entry.current.body : undefined;
};
const addNote = (title, body) => (draft) => {
  const at = new Date().toISOString();
  draft.entries = [...draft.entries, {
    id: `mem_${String(draft.entries.length + 1).padStart(12, '0')}`,
    revision: 1,
    status: 'active',
    origin: 'user_explicit',
    createdAt: at,
    updatedAt: at,
    current: { title, summary: title, body, kind: 'note', when: '', keywords: [], topicKey: '', triggers: [], applicability: 'all_in_scope', conditions: [], selection: null, links: [], aliases: [] },
    maintenance: { reviewState: 'active', sourceRefs: [], retiredNames: [], versions: [], checks: [], hits: 0, merges: 0, lastUsed: at },
  }];
  return { changed: true };
};

test('瘦包一封就是一份带校验和的状态', () => {
  const scope = fresh('envelope');
  const created = transact(scope, { expectCreate: true }, addNote('第一条', '正文'));
  assert.equal(created.changed, true);
  assert.equal(created.state.generation, 1);
  const parsed = JSON.parse(raw(scope));
  assert.equal(parsed.format, 'dsh-lite-memory/state@2');
  assert.match(parsed.checksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal(parsed.payload.generation, 1);
  assert.ok(fs.existsSync(path.join(scope.dir, 'state.prev.json')) === false);
  assert.equal(fs.existsSync(path.join(scope.dir, '.lock')), false);
});

test('D01 发布点失败：状态一个字节没动，也没有留下锁', () => {
  const scope = fresh('d01');
  transact(scope, { expectCreate: true }, addNote('第一条', '正文'));
  const before = raw(scope);
  assert.throws(() => transact(scope, { expected: { generation: 1 } }, () => {
    throw new Error('写盘前崩了');
  }), /写盘前崩了/);
  assert.equal(raw(scope), before);
  assert.equal(fs.existsSync(path.join(scope.dir, '.lock')), false);
  assert.equal(load(scope).state.generation, 1);
});

test('D01 current 丢了 prev 还在：读得到，下一次写入重新发布 current', () => {
  const scope = fresh('d01-prev');
  transact(scope, { expectCreate: true }, addNote('第一条', '正文'));
  transact(scope, { expected: { generation: 1 } }, addNote('第二条', '正文'));
  fs.copyFileSync(stateFile(scope), path.join(scope.dir, 'state.prev.json'));
  fs.rmSync(stateFile(scope));
  const recovered = load(scope);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.state.generation, 2);
  const written = transact(scope, {}, addNote('第三条', '正文'));
  assert.equal(written.changed, true);
  assert.equal(load(scope).exists, true);
  assert.equal(load(scope).state.generation, 3);
});

test('D02 响应丢了：同一 operationId 重放回执，不再写一遍', () => {
  const scope = fresh('d02');
  const note = addNote('一条', '正文');
  const first = transact(scope, { operationId: 'op-1', payloadDigest: 'digest-a' }, note);
  assert.equal(first.changed, true);
  assert.equal(first.state.generation, 1);
  const after = raw(scope);
  const replay = transact(scope, { operationId: 'op-1', payloadDigest: 'digest-a' }, note);
  assert.equal(replay.replayed, true);
  assert.equal(replay.changed, true);
  assert.equal(raw(scope), after);
  assert.equal(load(scope).state.generation, 1);
  assert.throws(() => transact(scope, { operationId: 'op-1', payloadDigest: 'digest-b' }, note), /不同内容/);
});

test('D08 别家进程占着锁：报忙，不猜也不抢', () => {
  const scope = fresh('d08-lock');
  fs.mkdirSync(scope.dir, { recursive: true });
  fs.writeFileSync(path.join(scope.dir, '.lock'), '999999:deadbeef');
  assert.throws(() => transact(scope, {}, addNote('一条', '正文')), (error) => error instanceof StateError && error.code === 'busy');
  assert.equal(fs.existsSync(stateFile(scope)), false);
  fs.rmSync(path.join(scope.dir, '.lock'));
  assert.equal(transact(scope, {}, addNote('一条', '正文')).changed, true);
});

test('D08 坏 JSON 与不认识的版本都不当空库覆盖', () => {
  const broken = fresh('d08-json');
  fs.mkdirSync(broken.dir, { recursive: true });
  fs.writeFileSync(stateFile(broken), '{"format":');
  assert.throws(() => load(broken), (error) => error instanceof StateError && error.code === 'corrupt');
  assert.equal(fs.readFileSync(stateFile(broken), 'utf8'), '{"format":');
  const unknown = fresh('d08-version');
  fs.mkdirSync(unknown.dir, { recursive: true });
  const payload = emptyState(unknown);
  payload.schemaVersion = 99;
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  fs.writeFileSync(stateFile(unknown), `${JSON.stringify({ format: 'dsh-lite-memory/state@2', checksum, payload })}\n`);
  assert.throws(() => load(unknown), (error) => error instanceof StateError && error.code === 'invalid');
});

test('D08 重入锁：读—改—写同一个窗口里连续调用不死锁', () => {
  const scope = fresh('d08-reentrant');
  const result = withScopeLock(scope, () => {
    transact(scope, { expectCreate: true }, addNote('第一条', '正文'));
    return transact(scope, { expected: { generation: 1 } }, addNote('第二条', '正文'));
  });
  assert.equal(result.changed, true);
  assert.equal(load(scope).state.entries.length, 2);
});

test('S01 仓库根与子目录共用一份记忆', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-repo-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const sub = path.join(repo, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  const atRoot = scopeOf(repo);
  const atSub = scopeOf(sub);
  assert.equal(atSub.key, atRoot.key);
  assert.equal(atSub.dir, atRoot.dir);
  assert.equal(resolveRoot(sub).root, fs.realpathSync(repo));
});

test('S02 符号链接、非 Git 目录、嵌套仓库各归各的', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-link-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const link = path.join(os.tmpdir(), `lm-state-alias-${Math.random().toString(16).slice(2, 8)}`);
  dirs.push(link);
  fs.symlinkSync(repo, link);
  assert.equal(scopeOf(link).key, scopeOf(repo).key);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-plain-'));
  dirs.push(plain);
  assert.equal(resolveRoot(plain).source, 'cwd');
  const nested = path.join(repo, 'vendor', 'inner');
  fs.mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: nested });
  assert.notEqual(scopeOf(nested).key, scopeOf(repo).key);
});

test('P04 Git 查询失败不冒充已确认工程，不用 cwd 兜底学习', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-gitfail-'));
  dirs.push(dir);
  const previous = process.env.PATH;
  process.env.PATH = '';
  try {
    const resolved = resolveRoot(dir);
    assert.equal(resolved.source, 'cwd');
    assert.equal(resolved.confirmed, false);
    assert.equal(scopeOf(dir).confirmed, false);
  } finally {
    process.env.PATH = previous;
  }
});

test('S04 全局层从 41 条写到 200 条，一条不少也不拒绝', () => {
  const global = globalScope();
  transact(global, { expectCreate: true }, (draft) => {
    for (let i = 0; i < 41; i += 1) addNote(`旧全局 ${i}`, `正文 ${i}`)(draft);
    return { changed: true };
  });
  for (let i = 41; i < 200; i += 1) {
    transact(global, {}, addNote(`全局 ${i}`, `正文 ${i}`));
  }
  assert.equal(load(global).state.entries.length, 200);
  assert.equal(LIMITS.globalEntries, 200);
});

test('S05 第 201 条与字节压力：先归档最久没读的，不拒绝', () => {
  const scope = fresh('s05');
  transact(scope, { expectCreate: true }, (draft) => {
    for (let i = 0; i <= 200; i += 1) addNote(`条目 ${i}`, `正文 ${i}`)(draft);
    return { changed: true };
  });
  assert.equal(load(scope).state.entries.length, 201);
  const big = 'x'.repeat(Math.ceil(LIMITS.totalBytes / 4));
  for (let i = 0; i < 4; i += 1) {
    transact(scope, {}, addNote(`大条目 ${i}`, big));
  }
  const loaded = load(scope).state;
  const active = loaded.entries.filter((entry) => entry.status === 'active');
  const archived = loaded.entries.filter((entry) => entry.status === 'archived');
  assert.ok(archived.length >= 1, '腾了位置');
  assert.ok(active.reduce((sum, entry) => sum + state.entryBytesOf(entry), 0) <= LIMITS.totalBytes);
  for (const entry of archived) assert.equal(entry.current.body.length > 0, true);
});

test('S10 旧库迁移：正文、归档、旧标题一起搬进状态', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-legacy-'));
  dirs.push(project);
  const scope = scopeOf(project);
  fs.mkdirSync(scope.dir, { recursive: true });
  fs.cpSync(new URL('./fixtures/legacy-v1', import.meta.url), scope.dir, { recursive: true });
  const indexFile = path.join(scope.dir, 'index.json');
  const legacy = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  legacy.cwd = scope.cwd;
  fs.writeFileSync(indexFile, JSON.stringify(legacy));
  const report = migrationReport(scope);
  assert.equal(report.required, true);
  assert.equal(report.entries, 3);
  assert.deepEqual(report.missingBodies, []);
  const migrated = migrateLegacy(scope);
  assert.equal(migrated.migrated, true);
  const loaded = load(scope).state;
  assert.equal(loaded.entries.length, 4);
  assert.equal(loaded.migration.fromVersion, 1);
  assert.equal(bodyOf(scope, 'mem_111111111111'), '第一步跑测试\n第二步改版本号');
  const archived = loaded.entries.find((entry) => entry.id === 'mem_444444444444');
  assert.equal(archived.status, 'archived');
  assert.equal(archived.current.body, '归档正文');
  assert.equal(migrateLegacy(scope).migrated, false);
  assert.equal(fs.existsSync(path.join(scope.dir, 'legacy', 'v1', 'index.json')), true);
  assert.equal(fs.existsSync(indexFile), false);
});

test('S10 缺正文与同 id 冲突：先给报告，不动盘', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-legacy-bad-'));
  dirs.push(project);
  const scope = scopeOf(project);
  fs.mkdirSync(scope.dir, { recursive: true });
  fs.cpSync(new URL('./fixtures/legacy-v1', import.meta.url), scope.dir, { recursive: true });
  const indexFile = path.join(scope.dir, 'index.json');
  const legacy = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  legacy.cwd = scope.cwd;
  fs.writeFileSync(indexFile, JSON.stringify(legacy));
  fs.rmSync(path.join(scope.dir, 'entries', 'mem_222222222222.md'));
  const before = fs.readFileSync(indexFile, 'utf8');
  assert.throws(() => migrateLegacy(scope), (error) => error instanceof StateError && error.code === 'legacy_missing_body' && error.report.missingBodies.includes('mem_222222222222'));
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before);
  assert.equal(fs.existsSync(stateFile(scope)), false);
});

test('S10 旧的子目录库并进仓库根，同 id 只留一条', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-adopt-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const sub = path.join(repo, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  const scope = scopeOf(repo);
  const childKey = `legacy-${Math.random().toString(16).slice(2, 8)}`;
  const childDir = path.join(memoryRoot(), childKey);
  fs.mkdirSync(path.join(childDir, 'entries'), { recursive: true });
  fs.writeFileSync(path.join(childDir, 'index.json'), JSON.stringify({
    version: 1, scope: childKey, cwd: sub,
    entries: [{ id: 'mem_555555555555', title: '子目录条目', summary: '子目录存的', when: '', kind: 'note', tags: [], created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', revision: 1, status: 'active', source: 'user_explicit', hits: 0, merges: 0, versions: [], bytes: 10 }],
    suggestions: [], receipts: [],
  }));
  fs.writeFileSync(path.join(childDir, 'entries', 'mem_555555555555.md'), '子目录正文');
  const report = migrationReport(scope);
  assert.equal(report.adoptable.length, 1);
  const migrated = migrateLegacy(scope);
  assert.equal(migrated.migrated, true);
  assert.equal(bodyOf(scope, 'mem_555555555555'), '子目录正文');
  assert.equal(fs.existsSync(childDir), false);
  assert.equal(fs.existsSync(path.join(scope.dir, 'legacy', `scope-${childKey}`)), true);
});

test('S10 迁移预检扫到所有被吸收的旧库：子目录缺正文/同 id 不同正文都不发布', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-adopt-bad-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const sub = path.join(repo, 'packages', 'bad');
  fs.mkdirSync(sub, { recursive: true });
  const scope = scopeOf(repo);
  const childKey = `legacy-bad-${Math.random().toString(16).slice(2, 8)}`;
  const childDir = path.join(memoryRoot(), childKey);
  fs.mkdirSync(path.join(childDir, 'entries'), { recursive: true });
  fs.writeFileSync(path.join(childDir, 'index.json'), JSON.stringify({
    version: 1, scope: childKey, cwd: sub,
    entries: [
      { id: 'mem_666666666666', title: '子目录缺正文', summary: '正文文件被删了', when: '', kind: 'note', tags: [], revision: 1, status: 'active', source: 'user_explicit', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z' },
      { id: 'mem_777777777777', title: '同 id 不同正文', summary: '和主库撞 id', when: '', kind: 'note', tags: [], revision: 1, status: 'active', source: 'user_explicit', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z' },
    ],
    suggestions: [], receipts: [],
  }));
  fs.writeFileSync(path.join(childDir, 'entries', 'mem_777777777777.md'), '子目录版本');
  /** 主库有同 id 但正文不同：合并会静默丢数据，必须在预检就拦下。 */
  fs.mkdirSync(path.join(scope.dir, 'entries'), { recursive: true });
  fs.writeFileSync(path.join(scope.dir, 'index.json'), JSON.stringify({
    version: 1, scope: scope.key, cwd: repo,
    entries: [{ id: 'mem_777777777777', title: '同 id 不同正文', summary: '主库版本', when: '', kind: 'note', tags: [], revision: 1, status: 'active', source: 'user_explicit', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z' }],
    suggestions: [], receipts: [],
  }));
  fs.writeFileSync(path.join(scope.dir, 'entries', 'mem_777777777777.md'), '主库版本');
  const report = migrationReport(scope);
  assert.equal(report.sources, 2);
  assert.ok(report.missingBodies.includes('mem_666666666666'));
  assert.ok(report.conflicts.some((row) => row.id === 'mem_777777777777' && /不同正文/.test(row.reason)));
  assert.throws(() => migrateLegacy(scope), (error) => error instanceof StateError && error.code === 'legacy_conflict');
  assert.equal(fs.existsSync(stateFile(scope)), false);
  assert.equal(fs.existsSync(path.join(childDir, 'index.json')), true);
});

test('exact noop 不涨 generation，也不改 updatedAt', () => {
  const scope = fresh('noop');
  transact(scope, { expectCreate: true }, addNote('一条', '正文'));
  const before = load(scope).state;
  const noop = transact(scope, { expected: { generation: 1 } }, () => ({ changed: false }));
  assert.equal(noop.changed, false);
  assert.equal(load(scope).state.generation, before.generation);
  assert.equal(load(scope).state.updatedAt, before.updatedAt);
});

test('validateState 拦坏结构，不拦合法的一条', () => {
  const scope = fresh('validate');
  const good = emptyState(scope);
  addNote('一条', '正文')(good);
  assert.equal(validateState(good).schemaVersion, 2);
  const bad = JSON.parse(JSON.stringify(good));
  bad.entries[0].id = 'not-an-id';
  assert.throws(() => validateState(bad), (error) => error instanceof StateError);
});


// ── 彻底忘掉：屏障、断点、旧副本 ─────────────────────────────────────────────
test('purge 删条目不回吐标题，轮换 epoch，prev 也是清过的', () => {
  const scope = fresh('purge');
  transact(scope, { expectCreate: true }, addNote('要忘掉的事', '旧正文-哨兵'));
  transact(scope, { expected: { generation: 1 } }, addNote('要留下的事', '留下的正文'));
  const before = load(scope).state;
  const result = state.purge(scope, { ids: ['mem_000000000001'], operationId: 'op_purge_test' });
  assert.equal(result.ok, true);
  assert.equal(result.operationId, 'op_purge_test');
  assert.equal(JSON.stringify(result).includes('要忘掉的事'), false);
  const after = load(scope).state;
  assert.equal(after.entries.some((entry) => entry.id === 'mem_000000000001'), false);
  assert.equal(after.entries.some((entry) => entry.id === 'mem_000000000002'), true);
  assert.notEqual(after.epoch, before.epoch);
  assert.equal(after.receipts.length, 1);
  assert.equal(after.receipts[0].kind, 'purge');
  assert.equal(JSON.stringify(after.receipts).includes('要忘掉的事'), false);
  const row = after.suppressions.find((item) => item.reason === 'forgotten_source');
  assert.ok(row);
  assert.equal(row.expiresAt, null);
  assert.equal(fs.existsSync(path.join(scope.dir, 'bodies', 'mem_000000000001.md')), false);
  const prev = JSON.parse(fs.readFileSync(path.join(scope.dir, 'state.prev.json'), 'utf8')).payload;
  assert.equal(prev.entries.some((entry) => entry.id === 'mem_000000000001'), false);
  assert.equal(fs.existsSync(path.join(scope.dir, 'purge.intent.json')), false);
  // 同一个 id 不会再被当成活条目
  assert.throws(() => transact(scope, {}, addNote('要忘掉的事', '冒充')), (error) => error instanceof StateError);
});

test('purge 断点：有 intent 时普通读取被拦住，重启后收尾', () => {
  const scope = fresh('purge-resume');
  transact(scope, { expectCreate: true }, addNote('断点里的事', '断点正文-哨兵'));
  const loaded = load(scope);
  const intent = {
    operationId: 'op_resume_test',
    scopeKey: scope.key,
    storeId: loaded.state.storeId,
    fromEpoch: loaded.state.epoch,
    toEpoch: '00000000-0000-4000-8000-000000000001',
    ids: ['mem_000000000001'],
    phase: 'planned',
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(scope.dir, 'purge.intent.json'), `${JSON.stringify(intent, null, 2)}\n`);
  assert.throws(() => load(scope), (error) => error instanceof StateError && error.code === 'purge_pending');
  assert.throws(() => state.purge(scope, { ids: ['mem_000000000001'] }), (error) => error.code === 'purge_pending');
  const resumed = state.resumePurge(scope);
  assert.equal(resumed.epoch, intent.toEpoch);
  assert.equal(fs.existsSync(path.join(scope.dir, 'purge.intent.json')), false);
  assert.equal(load(scope).state.entries.length, 0);
  assert.equal(JSON.stringify(resumed).includes('断点里的事'), false);
});

test('purge 之后再碰同一个 id 返回 missing，不复活', () => {
  const scope = fresh('purge-missing');
  transact(scope, { expectCreate: true }, addNote('删一次', '正文'));
  state.purge(scope, { ids: ['mem_000000000001'] });
  const again = state.purge(scope, { ids: ['mem_000000000001'] });
  assert.equal(again.ok, true);
  assert.equal(again.missing, true);
  assert.equal(load(scope).state.entries.length, 0);
});

test('写入重试不堆临时副本：固定临时名写前清理，成功后只留状态文件', () => {
  const scope = fresh('retry-temp');
  transact(scope, { expectCreate: true }, addNote('第一次', 'x'));
  const before = load(scope);
  /** 模拟上次写到一半：固定名和旧版随机名的残留都应在下一次写入前清掉。 */
  fs.writeFileSync(path.join(scope.dir, '.state.json.tmp'), '{"half":true}');
  fs.writeFileSync(path.join(scope.dir, '.state.prev.json.tmp'), '{"half":true}');
  fs.writeFileSync(path.join(scope.dir, '.state.abandoned.tmp'), '{"half":true}');
  const next = transact(scope, { expected: { generation: before.state.generation, epoch: before.state.epoch } }, addNote('第二次', 'y'));
  assert.equal(next.state.generation, before.state.generation + 1);
  assert.deepEqual(fs.readdirSync(scope.dir).filter((name) => name.endsWith('.tmp')), []);
  assert.equal(JSON.parse(raw(scope)).payload.generation, next.state.generation);
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`state.test.mjs: ${passed} passed`);
