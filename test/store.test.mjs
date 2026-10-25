import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-'));
const store = await import('../store.js');

const { upsert, search, readEntry, forget, undoChange, acceptCandidate, rejectCandidate,
  suggestionGate, noteSuggestion, findSuggestion, renderIndex, normalizeDraft, loadIndex,
  scopeOf, globalScope, LIMITS, recordCitations, listCitations, readCitationBody } = store;

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
  const dir = path.join(os.tmpdir(), `lite-memory-case-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return scopeOf(dir);
};

const bodyOf = (scope, id) => fs.readFileSync(path.join(scope.dir, 'entries', `${id}.md`), 'utf8');
const countOf = (scope) => loadIndex(scope).entries.length;
const suggestionsOf = (scope) => loadIndex(scope).suggestions;

test('create then same title merges with full old body kept', () => {
  const scope = fresh('create');
  const first = upsert(scope, { title: '发布顺序', summary: '发版前要按顺序做的事', body: '第一步\n- 跑测试' });
  assert.equal(first.merged, false);
  assert.equal(first.needsResolution, false);
  assert.equal(first.record.revision, 1);
  const second = upsert(scope, { title: '发布顺序', summary: '发版前要按顺序做的事', body: '第一步\n- 跑测试\n- 改版本号' });
  assert.equal(second.merged, true);
  assert.equal(second.record.id, first.record.id);
  assert.equal(second.record.revision, 2);
  assert.equal(second.record.versions.at(-1).body, '第一步\n- 跑测试');
  assert.equal(second.record.versions.at(-1).summary, '发版前要按顺序做的事');
  assert.match(readEntry(scope, first.record.id).body, /改版本号/);
  assert.equal(countOf(scope), 1);
});

test('update replaces the body instead of merging markdown sections', () => {
  const scope = fresh('replace');
  const first = upsert(scope, { title: '发布顺序', summary: '发版前按顺序做的事', body: '## 部署\ndeploy 命令' });
  const next = upsert(scope, { id: first.record.id, title: '发布顺序', summary: '发版前按顺序做的事', body: '## 回滚\nrollback 命令' });
  assert.equal(next.merged, true);
  const body = readEntry(scope, first.record.id).body;
  assert.equal(body, '## 回滚\nrollback 命令');
  assert.equal(next.record.versions.at(-1).body, '## 部署\ndeploy 命令');
});

test('update without when/kind/tags/body keeps the old values', () => {
  const scope = fresh('patch');
  const first = upsert(scope, {
    title: '回复用中文',
    summary: '用户要求回复用中文',
    when: '所有对话',
    kind: 'preference',
    tags: ['语言'],
    body: '用中文回复。',
  });
  const next = upsert(scope, { id: first.record.id, title: '回复用中文', summary: '用户要求一律用中文回复' });
  assert.equal(next.record.when, '所有对话');
  assert.equal(next.record.kind, 'preference');
  assert.deepEqual(next.record.tags, ['语言']);
  assert.equal(readEntry(scope, first.record.id).body, '用中文回复。');
  const cleared = upsert(scope, { id: first.record.id, title: '回复用中文', summary: '用户要求一律用中文回复', when: '', tags: [] });
  assert.equal(cleared.record.when, '');
  assert.deepEqual(cleared.record.tags, []);
});

test('similar title without id returns resolution and writes nothing', () => {
  const scope = fresh('similar');
  const base = upsert(scope, { title: 'npm 与 GitHub 发布凭据位置', summary: '两处凭据各在哪取', body: 'keychain 与 gh auth' });
  const before = countOf(scope);
  const entriesBefore = fs.readdirSync(path.join(scope.dir, 'entries')).sort();
  const conflict = upsert(scope, { title: 'npm 与 GitHub 发布凭据在哪', summary: '两处凭据各在哪取', body: '另一条' });
  assert.equal(conflict.needsResolution, true);
  assert.equal(conflict.record, null);
  assert.ok(conflict.similarList.length >= 1 && conflict.similarList.length <= 2);
  assert.equal(conflict.similarList[0].id, base.record.id);
  assert.equal(countOf(scope), before);
  assert.deepEqual(fs.readdirSync(path.join(scope.dir, 'entries')).sort(), entriesBefore);
  const distinct = upsert(scope, { title: 'npm 与 GitHub 发布凭据在哪', summary: '两处凭据各在哪取', body: '另一条', resolution: 'distinct' });
  assert.equal(distinct.needsResolution, false);
  assert.equal(distinct.merged, false);
  assert.equal(countOf(scope), before + 1);
});

test('same title with a different when is a second entry', () => {
  const scope = fresh('when');
  const a = upsert(scope, { title: '跑测试', summary: '提交前跑哪条命令', when: '本地', body: 'node test' });
  const b = upsert(scope, { title: '跑测试', summary: '提交前跑哪条命令', when: 'CI', body: 'pnpm test' });
  assert.notEqual(a.record.id, b.record.id);
  assert.equal(countOf(scope), 2);
  const again = upsert(scope, { title: '跑测试', summary: '提交前跑哪条命令', when: 'CI', body: 'pnpm test --watch' });
  assert.equal(again.merged, true);
  assert.equal(again.record.id, b.record.id);
});

test('oversized body is rejected, old data untouched', () => {
  const scope = fresh('oversize');
  const big = 'x'.repeat(LIMITS.entryBytes + 1);
  assert.throws(() => upsert(scope, { title: '太大', summary: '一条超大正文', body: big }), /超过/);
  assert.equal(fs.existsSync(path.join(scope.dir, 'index.json')), false);
  const first = upsert(scope, { title: '正常', summary: '一条正常正文', body: '保留我' });
  assert.throws(() => upsert(scope, { id: first.record.id, title: '正常', summary: '一条正常正文', body: big }), /超过/);
  assert.equal(bodyOf(scope, first.record.id), '保留我');
  assert.equal(loadIndex(scope).entries[0].revision, 1);
});

test('over-long title and summary are errors, not silent slices', () => {
  const scope = fresh('length');
  assert.throws(() => upsert(scope, { title: 't'.repeat(LIMITS.titleChars + 1), summary: '写得短一点' }), /标题超过/);
  assert.throws(() => upsert(scope, { title: '长摘要', summary: 's'.repeat(LIMITS.summaryChars + 1) }), /摘要超过/);
  assert.equal(fs.existsSync(path.join(scope.dir, 'index.json')), false);
});

test('imperative summary and credentials are rejected', () => {
  const scope = fresh('validate');
  assert.throws(() => upsert(scope, { title: '回复语言', summary: '请用中文回复' }), /名词短语/);
  assert.throws(() => upsert(scope, { title: '凭据', summary: '一个 token 的值', body: 'token = sk-abcdefghijklmnopqrst' }), /凭据/);
  assert.equal(normalizeDraft({ title: 'a', summary: '名词短语' }).kind, 'note');
  assert.throws(() => normalizeDraft({ title: 'a', summary: '名词短语', kind: 'guess' }), /类型只能是/);
});

test('total bytes budget rejects instead of archiving silently', () => {
  const scope = fresh('budget');
  const original = LIMITS.totalBytes;
  LIMITS.totalBytes = 600;
  try {
    upsert(scope, { title: '第一条', summary: '占满预算的正文', body: '记'.repeat(100) });
    assert.throws(() => upsert(scope, { title: '第二条', summary: '再来一条就超了', body: '记'.repeat(100) }), /记忆库已满/);
    assert.equal(countOf(scope), 1);
  } finally {
    LIMITS.totalBytes = original;
  }
});

test('lock file from a dead writer is not stolen: busy instead of a guessed write', () => {
  const scope = fresh('lock');
  fs.mkdirSync(scope.dir, { recursive: true });
  const lock = path.join(scope.dir, '.lock');
  fs.writeFileSync(lock, 'dead:token');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const started = Date.now();
  assert.throws(() => upsert(scope, { title: '拿不到锁', summary: '锁被别人拿着' }), /正忙/);
  const waited = Date.now() - started;
  assert.ok(waited >= 400 && waited < 3000, `锁等待 ${waited}ms`);
  assert.equal(fs.existsSync(path.join(scope.dir, 'index.json')), false);
  fs.rmSync(lock, { force: true });
  const ok = upsert(scope, { title: '拿得到锁', summary: '锁被清掉之后' });
  assert.equal(ok.merged, false);
});

test('search finds Chinese queries, when clauses and reports counts', () => {
  const scope = fresh('search');
  upsert(scope, { title: '发布顺序', summary: '发版前要按顺序做的事', body: 'a' });
  upsert(scope, { title: '文案检查', summary: '改完界面跑一遍 lint', when: 'CI 容器里', body: 'b' });
  const hits = search(scope, '上次发布流程是什么');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].title, '发布顺序');
  assert.equal(hits[0].scope, 'project');
  const when = search(scope, 'CI 容器');
  assert.ok(when.some((item) => item.title === '文案检查'));
  const rendered = renderIndex(hits);
  assert.match(rendered.text, /^- mem_[a-z0-9]+ 发布顺序/);
  assert.match(rendered.text, /第 1 版/);
  assert.ok(rendered.chars <= 400);
  assert.deepEqual(search(scope, '完全无关的主题词'), []);
});

test('archived or 90-day-stale entries render without a summary', () => {
  const scope = fresh('stale');
  const item = upsert(scope, { title: '旧条目', summary: '很久没用过的条目', body: 'x' });
  const index = loadIndex(scope);
  index.entries[0].lastUsed = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  store.saveIndex(scope, index);
  const hits = search(scope, '旧条目');
  assert.equal(hits.length, 1);
  const rendered = renderIndex(hits);
  assert.ok(!rendered.text.includes('｜'), rendered.text);
  assert.equal(rendered.text.split('\n')[0].includes(item.record.id), true);
});

test('search bumps hits and lastUsed', () => {
  const scope = fresh('hits');
  const item = upsert(scope, { title: '常用条目', summary: '经常被翻出来的条目', body: 'x' });
  search(scope, '常用条目');
  const record = loadIndex(scope).entries.find((entry) => entry.id === item.record.id);
  assert.equal(record.hits, 1);
  assert.ok(Date.parse(record.lastUsed) >= Date.parse(item.record.created));
  assert.ok(record.lastUsed.endsWith('Z'));
});

test('readEntry returns the body, and a missing body is an error', () => {
  const scope = fresh('read');
  const item = upsert(scope, { title: '读正文', summary: '正文要读得出来', body: '正文内容' });
  const record = readEntry(scope, item.record.id);
  assert.equal(record.body, '正文内容');
  assert.notEqual(readEntry(scope, 'mem_000000000000'), {});
  assert.equal(readEntry(scope, 'mem_deadbeef0000'), null);
  fs.rmSync(path.join(scope.dir, 'entries', `${item.record.id}.md`));
  assert.throws(() => readEntry(scope, item.record.id), /正文缺失/);
});

test('forget archives both body and record; undo restores the previous version', () => {
  const scope = fresh('undo');
  const first = upsert(scope, { title: '会改两次', summary: '需要撤销的一条', body: '第一版正文' });
  upsert(scope, { id: first.record.id, title: '会改两次', summary: '需要撤销的一条', body: '第二版正文' });
  const restored = undoChange(scope, first.record.id);
  assert.equal(restored.mode, 'restored');
  assert.equal(bodyOf(scope, first.record.id), '第一版正文');
  assert.equal(loadIndex(scope).entries[0].revision, 3);
  const again = undoChange(scope, first.record.id);
  assert.equal(again.mode, 'archived');
  assert.equal(countOf(scope), 0);
  const files = fs.readdirSync(path.join(scope.dir, 'archive'));
  assert.ok(files.includes(`${first.record.id}.md`));
  assert.ok(files.includes(`${first.record.id}.json`));
  assert.equal(fs.existsSync(path.join(scope.dir, 'entries', `${first.record.id}.md`)), false);
  assert.equal(forget(scope, first.record.id), null);
});

test('suggestion gate, keep, replay and reject', () => {
  const scope = fresh('candidate');
  const gate = suggestionGate(scope, { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint' });
  assert.equal(gate.ok, true);
  const noted = noteSuggestion(scope, { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint', body: 'node ui-copy-lint.mjs', when: '发布前' });
  assert.match(noted.id, /^sug_[a-z0-9]+$/);
  assert.equal(noted.targetId, '');
  const found = findSuggestion(scope, noted.id);
  assert.equal(found.when, '发布前');
  assert.equal(found.suggestionId, noted.id);
  const kept = acceptCandidate(scope, noted.id, 'op_first');
  assert.equal(kept.ok, true);
  assert.equal(kept.mode, 'created');
  assert.equal(kept.title, '发布前跑文案检查');
  assert.equal(countOf(scope), 1);
  assert.equal(suggestionsOf(scope).length, 0);
  const replay = acceptCandidate(scope, noted.id, 'op_first');
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.id, kept.id);
  assert.equal(acceptCandidate(scope, noted.id, 'op_other').ok, false);
  assert.equal(findSuggestion(scope, noted.id), null);
  assert.equal(countOf(scope), 1);
  const third = noteSuggestion(scope, { title: '另一条建议', summary: '用来测试 reject 的候选' });
  const dropped = rejectCandidate(scope, third.id);
  assert.equal(dropped.ok, true);
  assert.equal(rejectCandidate(scope, third.id).ok, false);
});

test('suggestion without a body never clears the target body', () => {
  const scope = fresh('candidate-update');
  const original = upsert(scope, { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint', body: '保留这段正文' });
  const gate = suggestionGate(scope, { title: '发布前跑文案检查（含全局）', summary: '发版前先跑 ui 文案 lint' });
  assert.equal(gate.ok, true);
  assert.equal(gate.target.id, original.record.id);
  const noted = noteSuggestion(scope, { title: '发布前跑文案检查（含全局）', summary: '发版前先跑 ui 文案 lint', targetId: gate.target.id });
  const kept = acceptCandidate(scope, noted.id, 'op_update');
  assert.equal(kept.ok, true);
  assert.equal(kept.mode, 'updated');
  assert.equal(kept.id, original.record.id);
  assert.equal(countOf(scope), 1);
  assert.equal(bodyOf(scope, original.record.id), '保留这段正文');
  assert.equal(loadIndex(scope).entries[0].title, '发布前跑文案检查（含全局）');
  assert.deepEqual(loadIndex(scope).entries[0].aliases, ['发布前跑文案检查']);
});

test('candidate pointing at a changed entry is refused, not overwritten', () => {
  const scope = fresh('candidate-stale');
  const original = upsert(scope, { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint', body: '第一版' });
  const noted = noteSuggestion(scope, { title: '发布前跑文案检查（含全局）', summary: '发版前先跑 ui 文案 lint', targetId: original.record.id });
  upsert(scope, { id: original.record.id, title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint', body: '第二版' });
  const kept = acceptCandidate(scope, noted.id, 'op_stale');
  assert.equal(kept.ok, false);
  assert.match(kept.reason, /改过/);
  assert.equal(bodyOf(scope, original.record.id), '第二版');
});

test('expired candidates are invisible and unusable', () => {
  const scope = fresh('candidate-ttl');
  const noted = noteSuggestion(scope, { title: '会过期的建议', summary: '还没确认就过期了' });
  const index = loadIndex(scope);
  index.suggestions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  store.saveIndex(scope, index);
  assert.equal(findSuggestion(scope, noted.id), null);
  assert.equal(acceptCandidate(scope, noted.id, '').ok, false);
  assert.equal(fs.existsSync(path.join(scope.dir, 'entries')), false);
});

test('candidate draft is validated like a real entry', () => {
  const scope = fresh('candidate-bad');
  assert.throws(() => noteSuggestion(scope, { title: '凭据候选', summary: '一个 token 的值', body: 'ghp_abcdefghijklmnopqrstuvwx' }), /凭据/);
  assert.throws(() => noteSuggestion(scope, { title: '超大候选', summary: '正文超过单条上限', body: 'x'.repeat(LIMITS.entryBytes + 1) }), /超过/);
  assert.equal((loadIndex(scope).suggestions || []).length, 0);
});

test('corrupt index stops reads and writes and stays on disk', () => {
  const scope = fresh('corrupt');
  fs.mkdirSync(scope.dir, { recursive: true });
  const file = path.join(scope.dir, 'index.json');
  const broken = '{"entries": [';
  fs.writeFileSync(file, broken);
  assert.throws(() => loadIndex(scope), /已损坏/);
  assert.throws(() => upsert(scope, { title: '不该写', summary: '索引坏了就不能写' }), /已损坏/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
  fs.writeFileSync(file, '{"entries": 3}');
  assert.throws(() => loadIndex(scope), /结构不对/);
});

test('capacity trim moves the oldest entries into archive/', () => {
  const scope = fresh('trim');
  for (let i = 0; i < LIMITS.entries + 3; i += 1) {
    upsert(scope, { title: `条目 ${i}`, summary: `第 ${i} 条压容量`, body: `body ${i}`, resolution: 'distinct' });
  }
  assert.equal(countOf(scope), LIMITS.entries);
  const archived = fs.readdirSync(path.join(scope.dir, 'archive'));
  assert.equal(archived.filter((name) => name.endsWith('.md')).length, 3);
  assert.equal(archived.filter((name) => name.endsWith('.json')).length, 3);
});

test('projects and the global layer stay separate', () => {
  const a = fresh('layer-a');
  const b = fresh('layer-b');
  upsert(a, { title: '只在 A 里', summary: '另一个项目看不到' });
  upsert(globalScope(), { title: '全局条目', summary: '所有项目都能搜到' });
  assert.equal(search(b, '只在 A 里').some((item) => item.title === '只在 A 里'), false);
  const global = search(b, '全局条目');
  assert.equal(global.length, 1);
  assert.equal(global[0].scope, 'global');
  const rendered = renderIndex(global);
  assert.match(rendered.text, /^- \[全局\] mem_/);
  const removed = forget(b, 'mem_000000000000');
  assert.equal(removed, null);
});

// ── 会话引用 ────────────────────────────────────────────────────────────────
test('citations keep one row per id and drop the oldest', () => {
  const scope = fresh('cite');
  const items = Array.from({ length: 25 }, (_, i) => ({
    id: `mem_${String(i).padStart(12, '0')}`,
    title: `条目 ${i}`,
    scope: 'project',
    revision: 1,
  }));
  recordCitations(scope, 'session-cite', items.slice(0, 3));
  assert.equal(listCitations('session-cite').items.length, 3);
  recordCitations(scope, 'session-cite', [items[1]]);
  const deduped = listCitations('session-cite').items;
  assert.equal(deduped.length, 3);
  assert.equal(deduped[0].id, items[1].id);
  recordCitations(scope, 'session-cite', items);
  const kept = listCitations('session-cite').items;
  assert.equal(kept.length, LIMITS.citations);
  assert.equal(kept[0].id, items[0].id);
});

test('citations refuse a path-like session id', () => {
  const scope = fresh('cite-bad');
  assert.deepEqual(recordCitations(scope, '../escape', [{ id: 'mem_aaaaaaaaaaaa', title: '越界' }]), []);
  assert.deepEqual(listCitations('../../etc/passwd').items, []);
});

test('citation body reads the entry and rejects a foreign path', () => {
  const scope = fresh('cite-body');
  const created = upsert(scope, { title: '引用正文', summary: '点开要看到正文', body: '正文第一行' }).record;
  recordCitations(scope, 'session-body', [{ ...created, scope: 'project' }]);
  const row = listCitations('session-body').items[0];
  assert.equal(row.title, '引用正文');
  assert.equal('path' in row, false);
  assert.match(readCitationBody('session-body', created.id).body, /正文第一行/);
  assert.equal(readCitationBody('session-body', 'mem_999999999999'), null);

  const dir = path.join(store.memoryRoot(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-escape.json'), JSON.stringify({ items: [{ id: 'mem_111111111111', path: '/etc/hosts' }] }));
  assert.equal(readCitationBody('session-escape', 'mem_111111111111'), null);
});

test('citation rows follow the current title and layer', () => {
  const scope = fresh('cite-fresh');
  const created = upsert(scope, { title: '旧标题', summary: '会被改名' }).record;
  recordCitations(scope, 'session-fresh', [{ ...created, scope: 'project' }]);
  assert.equal(listCitations('session-fresh').items[0].title, '旧标题');
  upsert(scope, { id: created.id, title: '新标题', summary: '会被改名' });
  assert.equal(listCitations('session-fresh').items[0].title, '新标题');

  const global = upsert(globalScope(), { title: '跨项目规则', summary: '换个项目也成立' }).record;
  recordCitations(scope, 'session-fresh', [{ ...global, scope: 'global' }]);
  assert.equal(listCitations('session-fresh').items[0].scope, 'global');
});

test('old citation session files are pruned', () => {
  const scope = fresh('cite-prune');
  recordCitations(scope, 'session-old', [{ id: 'mem_000000000001', title: '旧的' }]);
  const file = path.join(store.memoryRoot(), 'sessions', 'session-old.json');
  assert.equal(fs.existsSync(file), true);
  const past = new Date(Date.now() - LIMITS.citationTtlMs - 60_000);
  fs.utimesSync(file, past, past);
  recordCitations(scope, 'session-new', [{ id: 'mem_000000000002', title: '新的' }]);
  assert.equal(fs.existsSync(file), false);
  assert.equal(listCitations('session-new').items.length, 1);
});

test('title is identity: separator and pasted condition are cut before saving', () => {
  const scope = fresh('title-clean');
  const saved = upsert(scope, {
    title: 'Chrome 临时 profile 触发「找不到钥匙串」弹窗｜macOS 上由',
    summary: '临时 profile 起 Chrome 会弹钥匙串窗口',
    when: 'macOS 上由 agent 启动 Chrome 且用临时 profile 时',
  });
  assert.equal(saved.record.title, 'Chrome 临时 profile 触发「找不到钥匙串」弹窗');
  assert.equal(saved.record.when, 'macOS 上由 agent 启动 Chrome 且用临时 profile 时');

  const pasted = normalizeDraft({ title: '发布顺序 （发版前要按顺序做的事）', summary: '发版前要按顺序做的事', when: '发版前要按顺序做的事' });
  assert.equal(pasted.title, '发布顺序');

  const whole = normalizeDraft({ title: '发布顺序 发版前要按顺序做的事', summary: '发版前要按顺序做的事', when: '发版前要按顺序做的事' });
  assert.equal(whole.title, '发布顺序');
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`store.test.mjs: ${passed} passed`);
