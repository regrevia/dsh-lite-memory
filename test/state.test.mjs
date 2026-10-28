import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-state-'));
const state = await import('../state.js');

const { LIMITS, StateError, scopeOf, globalScope, memoryRoot, resolveRoot, load, transact,
  readEntryBody, migrateLegacy, migrationReport, withScopeLock, validateState, emptyState, evolutionOf } = state;

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
  assert.equal(parsed.format, 'dsh-lite-memory/state@4');
  assert.match(parsed.checksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal(parsed.payload.generation, 1);
  assert.ok(fs.existsSync(path.join(scope.dir, 'state.prev.json')) === false);
  assert.equal(fs.existsSync(path.join(scope.dir, '.lock')), false);
});

test('2 版状态可读，下一次写入升级为 4 版并保留记录', () => {
  const scope = fresh('migrate-v2');
  const payload = emptyState(scope);
  addNote('旧库里的规则', '原文')(payload);
  payload.schemaVersion = 2;
  delete payload.experimental;
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  fs.mkdirSync(scope.dir, { recursive: true });
  fs.writeFileSync(stateFile(scope), `${JSON.stringify({ format: 'dsh-lite-memory/state@2', checksum, payload })}\n`);
  const loaded = load(scope);
  assert.equal(loaded.state.schemaVersion, 4);
  assert.equal(loaded.state.entries[0].current.title, '旧库里的规则');
  assert.equal(evolutionOf(loaded.state).enabled, false);
  transact(scope, { expected: { generation: loaded.state.generation } }, (draft) => {
    draft.entries[0].current.body = '升级后的正文';
    return { changed: true };
  });
  const parsed = JSON.parse(raw(scope));
  assert.equal(parsed.format, 'dsh-lite-memory/state@4');
  assert.equal(parsed.payload.entries[0].current.body, '升级后的正文');
});

test('D04b 旧实验规则缺作用域指纹时转待复核，正文与来源保留', () => {
  const scope = fresh('legacy-rules');
  transact(scope, { expectCreate: true }, (draft) => {
    addNote('旧规则', '旧正文')(draft);
    const entry = draft.entries[0];
    entry.origin = 'project_evolution';
    entry.maintenance.sourceRefs = [{ sourceType: 'human_feedback', sourceExcerpt: '以后都这样' }];
    entry.maintenance.learning = { state: 'trial', trialUntil: '2026-01-01T00:00:00.000Z' };
    addNote('新规则', '新正文')(draft);
    const freshRule = draft.entries[1];
    freshRule.origin = 'project_evolution';
    freshRule.maintenance.learning = { state: 'active', specDigest: 'digest' };
    return { changed: true };
  });
  const first = transact(scope, {}, (draft) => state.applyEvolution(draft, true));
  assert.equal(first.changed, true);
  const entries = first.state.entries;
  assert.equal(entries[0].maintenance.reviewState, 'legacy_unreviewed');
  assert.equal(entries[0].maintenance.legacyReview.reason, 'scope_unverified');
  assert.equal(entries[0].current.body, '旧正文');
  assert.equal(entries[0].maintenance.sourceRefs[0].sourceExcerpt, '以后都这样');
  assert.equal(entries[0].maintenance.learning.state, 'paused');
  assert.equal(entries[0].maintenance.learning.blockedReason, 'needs_scope_review');
  assert.equal(entries[1].maintenance.reviewState, 'active');
  const second = transact(scope, {}, (draft) => state.applyEvolution(draft, true));
  assert.equal(second.changed, false, '已复核的不再重复改写');
});

test('D04 旧程序拒绝写新格式，不抹掉实验标记', () => {
  const scope = fresh('d04-format');
  transact(scope, { expectCreate: true }, (draft) => {
    state.applyEvolution(draft, true);
    return { changed: true };
  });
  const before = raw(scope);
  assert.equal(JSON.parse(before).format, 'dsh-lite-memory/state@4');
  // 旧版只认 state@2，读到新格式会拒绝而不是当空库覆盖；实验标记因此留在盘上。
  const oldReader = (text) => {
    const data = JSON.parse(text);
    if (data.format !== 'dsh-lite-memory/state@2') throw new StateError('invalid', '旧版不认这个格式');
    return data.payload;
  };
  assert.throws(() => oldReader(before), (error) => error instanceof StateError && error.code === 'invalid');
  assert.equal(raw(scope), before);
  assert.equal(load(scope).state.experimental.projectEvolution.enabled, true);
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

test('D08 活进程占着锁：报忙，不猜也不抢（死 pid 的残留锁另行回收）', () => {
  const scope = fresh('d08-lock');
  fs.mkdirSync(scope.dir, { recursive: true });
  fs.writeFileSync(path.join(scope.dir, '.lock'), `${process.pid}:deadbeef`);
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
  assert.throws(() => load(unknown), (error) => error instanceof StateError && error.code === 'corrupt');
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
  /* Windows reports the temp root as an 8.3 short name on one side and the long
     name on the other; realpath 不一定把短名展开，按同一个目录的文件 ID 比对。 */
  const dirId = (dir) => {
    const stat = fs.statSync(dir, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  assert.equal(dirId(resolveRoot(sub).root), dirId(repo));
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

test('S03 配置的项目根只覆盖自己的子树，不吞别的目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-config-'));
  dirs.push(root);
  const sub = path.join(root, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-state-outside-'));
  dirs.push(outside);
  const config = path.join(memoryRoot(), 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ projectRoot: root }));
  try {
    assert.equal(resolveRoot(sub).root, fs.realpathSync(root));
    assert.equal(resolveRoot(sub).source, 'configured');
    assert.equal(scopeOf(sub).key, scopeOf(root).key);
    assert.notEqual(resolveRoot(outside).source, 'configured');
    assert.notEqual(scopeOf(outside).key, scopeOf(root).key);
  } finally {
    fs.rmSync(config, { force: true });
  }
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
  assert.equal(validateState(good).schemaVersion, 4);
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


/** 崩溃残留的 .lock：死 pid 能自动回收，活 pid 仍然 busy，迟到的新锁不能被误删。 */
const lockPath = (scope) => path.join(scope.dir, '.lock');
const writeLock = (scope, token) => {
  fs.mkdirSync(scope.dir, { recursive: true });
  fs.writeFileSync(lockPath(scope), token);
};
const deadPid = () => {
  for (const pid of [999999, 999998, 999997, 888888]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return pid;
    }
  }
  return null;
};

test('崩溃残留的锁（死 pid）自动回收，不再卡 busy', () => {
  const pid = deadPid();
  if (pid === null) return;
  const scope = fresh('stale-lock-dead');
  writeLock(scope, `${pid}:deadbeef`);
  const started = Date.now();
  const result = withScopeLock(scope, () => 'locked');
  const elapsed = Date.now() - started;
  assert.equal(result, 'locked');
  assert.ok(elapsed < 300, `回收要立刻重试，实际等了 ${elapsed}ms`);
  assert.equal(fs.existsSync(lockPath(scope)), false, '退出时自己的锁要删掉');
});

test('活 pid 的锁不回收：仍然报 busy，也不删别人的锁', () => {
  const scope = fresh('stale-lock-live');
  const token = `${process.pid}:other`;
  writeLock(scope, token);
  fs.utimesSync(lockPath(scope), new Date(0), new Date(0));
  const started = Date.now();
  assert.throws(() => withScopeLock(scope, () => 'never'), (error) => error.code === 'busy');
  assert.ok(Date.now() - started >= LIMITS.lockWaitMs - 50, '活锁要等满等待窗口');
  assert.equal(fs.readFileSync(lockPath(scope), 'utf8'), token, '活进程的锁一个字节都不能动');
});

test('回收窗口里锁被换成活 token：不删别人的新锁，最终报 busy', () => {
  const pid = deadPid();
  if (pid === null) return;
  const scope = fresh('stale-lock-race');
  const stale = `${pid}:stale`;
  const live = `${process.pid}:live`;
  writeLock(scope, stale);
  const originalRead = fs.readFileSync;
  const originalWrite = fs.writeFileSync;
  let swapped = false;
  /**
   * 真正注入竞态：回收函数第一次读到的还是死 pid 的 token，就在它读完之后、
   * 二次校验之前，另一个进程把锁换成了活 token。回收必须放弃删除。
   */
  fs.readFileSync = function (target, ...rest) {
    const result = originalRead.call(fs, target, ...rest);
    if (!swapped && String(target) === lockPath(scope)) {
      swapped = true;
      originalWrite.call(fs, lockPath(scope), live);
    }
    return result;
  };
  try {
    assert.throws(() => withScopeLock(scope, () => 'never'), (error) => error.code === 'busy');
    assert.equal(swapped, true, '竞态注入没生效，用例等于没测');
    assert.equal(originalRead.call(fs, lockPath(scope), 'utf8'), live, '换过主人的锁不能被误删');
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(lockPath(scope), { force: true });
  }
});

test('P0-B 坏 state + 好 prev：从上一版恢复，坏字节留成副本，写入继续', () => {
  const scope = fresh('p0b-recover');
  transact(scope, { expectCreate: true }, addNote('第一条', '正文一'));
  transact(scope, { expected: { generation: 1 } }, addNote('第二条', '正文二'));
  const broken = '{"format":';
  fs.writeFileSync(stateFile(scope), broken);
  const first = load(scope);
  assert.equal(first.recovered, true);
  assert.equal(first.state.generation, 1, '采用上一版，不能凭空造新代数');
  assert.equal(first.state.entries.length, 1);
  assert.match(first.recovery.message, /已从上一版恢复/);
  assert.equal(fs.readFileSync(first.recovery.corruptFile, 'utf8'), broken, '原始字节要原样保留');
  assert.equal(fs.readFileSync(stateFile(scope), 'utf8'), broken, '读路径不许静默覆盖坏文件');
  assert.equal(fs.readdirSync(scope.dir).filter((name) => name.startsWith('state.corrupt-')).length, 1);
  load(scope);
  assert.equal(fs.readdirSync(scope.dir).filter((name) => name.startsWith('state.corrupt-')).length, 1, '同一份坏字节不重复堆副本');
  const written = transact(scope, { expected: { generation: 1 } }, addNote('第三条', '正文三'));
  assert.equal(written.changed, true);
  const after = load(scope);
  assert.equal(after.recovered, false);
  assert.equal(after.state.generation, 2);
  assert.equal(after.state.entries.length, 2);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(scope.dir, 'state.prev.json'), 'utf8')), 'prev 不能被坏字节污染');
});

test('P0-B 坏 state 且没有 prev：报错给出损坏副本与可执行的恢复路径', () => {
  const scope = fresh('p0b-noprev');
  fs.mkdirSync(scope.dir, { recursive: true });
  const broken = '{"format":';
  fs.writeFileSync(stateFile(scope), broken);
  let error = null;
  try {
    load(scope);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '坏 state 不能当空库');
  assert.equal(error.code, 'corrupt');
  assert.match(error.message, /state\.prev\.json/, '要给出上一版路径');
  assert.match(error.message, /恢复步骤/);
  assert.ok(error.recovery && error.recovery.corruptFile, '要指出损坏副本');
  assert.equal(fs.readFileSync(error.recovery.corruptFile, 'utf8'), broken);
  assert.equal(fs.readFileSync(stateFile(scope), 'utf8'), broken);
});

test('D05 学习开关关掉再开，不重置已用次数和整理记录', () => {
  const scope = fresh('d05-learning-budget');
  const at = new Date().toISOString();
  transact(scope, {}, (draft) => {
    const evo = draft.experimental.projectEvolution;
    evo.learning = {
      attempts: { ep_seed: { count: 2, lastAt: at } },
      recent: [at],
      receipts: [{ operationId: 'op_seed', at, inputTokens: 10, outputTokens: 5 }],
    };
    return state.applyEvolution(draft, true);
  });
  const opened = load(scope).state.experimental.projectEvolution;
  assert.equal(opened.enabled, true);
  assert.deepEqual(opened.learning.recent, [], '打开时清掉在途观察');
  assert.equal(opened.learning.receipts.length, 1, '打开不能清整理回执');
  assert.equal(opened.learning.attempts.ep_seed.count, 2, '打开不能清已用次数');
  transact(scope, {}, (draft) => state.applyEvolution(draft, false));
  transact(scope, {}, (draft) => state.applyEvolution(draft, true));
  const again = load(scope).state.experimental.projectEvolution;
  assert.equal(again.enabled, true);
  assert.equal(again.learning.receipts.length, 1, '关掉再开不重置整理回执');
  assert.equal(again.learning.attempts.ep_seed.count, 2, '关掉再开不重置已用次数');
  assert.deepEqual(again.learning.recent, []);
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`state.test.mjs: ${passed} passed`);
