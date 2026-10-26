import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-'));
const store = await import('../store.js');
const state = await import('../state.js');

const { upsert, search, readEntry, forget, undoChange, acceptCandidate, rejectCandidate,
  suggestionGate, noteSuggestion, findSuggestion, renderIndex, normalizeDraft, loadIndex,
  scopeOf, globalScope, LIMITS, recordCitations, listCitations, readCitationBody,
  evolutionStatus, setEvolution } = store;

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

const stateOf = (scope) => JSON.parse(fs.readFileSync(path.join(scope.dir, 'state.json'), 'utf8')).payload;
const bodyOf = (scope, id) => {
  const entry = stateOf(scope).entries.find((row) => row.id === id);
  return entry ? entry.current.body : undefined;
};
const rawState = (scope) => fs.readFileSync(path.join(scope.dir, 'state.json'), 'utf8');
const countOf = (scope) => loadIndex(scope).entries.length;
const suggestionsOf = (scope) => loadIndex(scope).suggestions;

test('over-specific body is stored, not rejected for naming concrete values', () => {
  const scope = fresh('specific');
  const saved = upsert(scope, {
    title: '自绘菜单',
    summary: '菜单用应用自绘，不用系统原生',
    body: '菜单 z-index: 1100；宽度 min(264px, 100vw - 24px)；字号 12px；内边距 10px；圆角 8px。',
  });
  assert.equal(saved.record.title, '自绘菜单');
  assert.ok(saved.record.body.includes('z-index'));
});

test('a 500-character body is accepted', () => {
  const scope = fresh('toolong');
  const saved = upsert(scope, { title: '长正文', summary: '长一点也要存下来', body: '记'.repeat(500) });
  assert.equal(saved.record.title, '长正文');
  assert.equal(saved.record.body.length, 500);
});

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
  const entriesBefore = rawState(scope);
  const conflict = upsert(scope, { title: 'npm 与 GitHub 发布凭据在哪', summary: '两处凭据各在哪取', body: '另一条' });
  assert.equal(conflict.needsResolution, true);
  assert.equal(conflict.record, null);
  assert.ok(conflict.similarList.length >= 1 && conflict.similarList.length <= 2);
  assert.equal(conflict.similarList[0].id, base.record.id);
  assert.equal(countOf(scope), before);
  assert.equal(rawState(scope), entriesBefore);
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
  assert.equal(fs.existsSync(path.join(scope.dir, 'state.json')), false);
  const first = upsert(scope, { title: '正常', summary: '一条正常正文', body: '保留我' });
  assert.throws(() => upsert(scope, { id: first.record.id, title: '正常', summary: '一条正常正文', body: big }), /超过/);
  assert.equal(bodyOf(scope, first.record.id), '保留我');
  assert.equal(loadIndex(scope).entries[0].revision, 1);
});

test('over-long title is an error; over-long summary is truncated instead', () => {
  const scope = fresh('length');
  assert.throws(() => upsert(scope, { title: 't'.repeat(LIMITS.titleChars + 1), summary: '写得短一点' }), /标题超过/);
  const saved = upsert(scope, { title: '长摘要', summary: '长'.repeat(LIMITS.summaryChars + 1) });
  assert.equal(saved.record.summary.length, LIMITS.summaryChars);
});

test('imperative summary is kept; credentials are still rejected', () => {
  const scope = fresh('validate');
  assert.equal(upsert(scope, { title: '回复语言', summary: '请用中文回复' }).record.summary, '请用中文回复');
  assert.throws(() => upsert(scope, { title: '凭据', summary: '一个 token 的值', body: 'token = sk-abcdefghijklmnopqrst' }), /凭据/);
  assert.equal(normalizeDraft({ title: 'a', summary: '名词短语' }).kind, 'note');
  assert.throws(() => normalizeDraft({ title: 'a', summary: '名词短语', kind: 'guess' }), /类型只能是/);
});

test('正文预算满了也先归档腾位，并在结果里点名', () => {
  const scope = fresh('budget');
  const original = LIMITS.totalBytes;
  LIMITS.totalBytes = 600;
  try {
    upsert(scope, { title: '第一条', summary: '占满预算的正文', body: '记'.repeat(100) });
    const second = upsert(scope, { title: '第二条', summary: '再来一条就超了', body: '记'.repeat(100) });
    assert.equal(second.record.title, '第二条');
    assert.deepEqual(second.archived.map((item) => item.title), ['第一条']);
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
  assert.equal(fs.existsSync(path.join(scope.dir, 'state.json')), false);
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
  assert.match(rendered.text, /mem_[a-z0-9]+ 发布顺序/);
  assert.doesNotMatch(rendered.text, /第 .* 版/);
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

test('search and read leave hits and lastUsed alone', () => {
  const scope = fresh('hits');
  const item = upsert(scope, { title: '常用条目', summary: '经常被翻出来的条目', body: 'x' });
  const before = loadIndex(scope).entries.find((entry) => entry.id === item.record.id);
  search(scope, '常用条目');
  readEntry(scope, item.record.id);
  const after = loadIndex(scope).entries.find((entry) => entry.id === item.record.id);
  assert.equal(after.hits, before.hits);
  assert.equal(after.lastUsed, before.lastUsed);
  assert.equal(loadIndex(scope).generation, before.generation ?? loadIndex(scope).generation);
});

test('readEntry returns the body from state, unknown ids are null', () => {
  const scope = fresh('read');
  const item = upsert(scope, { title: '读正文', summary: '正文要读得出来', body: '正文内容' });
  const record = readEntry(scope, item.record.id);
  assert.equal(record.body, '正文内容');
  assert.equal(readEntry(scope, 'mem_deadbeef0000'), null);
  assert.equal(store.readCitationBody('session-read', 'mem_deadbeef0000'), null);
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
  const archived = loadIndex(scope).archived.find((item) => item.id === first.record.id);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.body, '第一版正文');
  const againArchive = forget(scope, first.record.id, { mode: 'archive' });
  assert.equal(againArchive.mode, 'archive');
  assert.equal(againArchive.already, true);
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
  /** 拒绝过的候选在时限内不再冒出来，而不是靠 48 小时节流碰巧挡住。 */
  const retry = suggestionGate(scope, { title: '另一条建议', summary: '用来测试 reject 的候选' });
  assert.equal(retry.ok, false);
  assert.match(retry.reason, /拒绝/);
});

test('未确认的项目根目录不新建命名空间，显式全局仍然可写', () => {
  const project = fresh('unconfirmed');
  const unconfirmed = { ...project, confirmed: false };
  const blocked = store.saveEntry(unconfirmed, { title: '未确认目录里的规则', summary: '不该落进项目层', body: '正文' });
  assert.equal(blocked.needsScope, true);
  assert.equal(blocked.reasonCode, 'unconfirmed_project');
  assert.equal(store.loadIndex(project).entries.length, 0);
  const globalSaved = store.saveEntry(unconfirmed, {
    scope: 'global',
    memoryClass: 'personal_preference',
    title: '跨项目也成立的偏好',
    summary: '不依赖项目根目录',
    body: '正文',
  });
  assert.equal(globalSaved.needsScope, false);
  assert.equal(globalSaved.chosenScope, 'global');
  assert.equal(store.loadIndex(globalScope()).entries.some((item) => item.id === globalSaved.record.id), true);
  const created = upsert(project, { title: '已存在的项目规则', summary: '用来测更新', body: '旧正文' });
  const updateBlocked = store.saveEntry(unconfirmed, { id: created.record.id, title: '已存在的项目规则', summary: '用来测更新', body: '新正文' });
  assert.equal(updateBlocked.needsScope, true);
  assert.equal(updateBlocked.reasonCode, 'unconfirmed_project');
});

test('空正文更新也留版本，撤销不会当成新建', () => {
  const scope = fresh('empty-body');
  const created = upsert(scope, { title: '空正文起步', summary: '正文之后补', body: '' });
  const updated = upsert(scope, { id: created.record.id, title: '空正文起步', summary: '正文之后补', body: '后来补的正文' });
  assert.equal(updated.previousBody, '');
  const undone = undoChange(scope, created.record.id);
  assert.equal(undone.mode, 'restored');
  const current = readEntry(scope, created.record.id);
  assert.equal(current.body, '');
  assert.equal(current.revision, 3);
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
  assert.equal(countOf(scope), 0);
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

test('条数 200 是提示线，不是拒绝线', () => {
  const scope = fresh('trim');
  for (let i = 0; i < LIMITS.entries; i += 1) {
    upsert(scope, { title: `条目 ${i}`, summary: `第 ${i} 条压容量`, body: `body ${i}`, resolution: 'distinct' });
  }
  assert.equal(countOf(scope), LIMITS.entries);
  const extra = upsert(scope, { title: '第 201 条', summary: '不许因为条数拒绝新记忆' });
  assert.equal(extra.record.title, '第 201 条');
  assert.deepEqual(extra.archived, []);
  assert.equal(countOf(scope), LIMITS.entries + 1);
  assert.equal(fs.existsSync(path.join(scope.dir, 'archive')), false);
});

test('到硬上限时归档最久没读的一条，不拒绝新记忆', () => {
  const scope = fresh('evict');
  fs.mkdirSync(scope.dir, { recursive: true });
  const chunk = Math.ceil(LIMITS.totalBytes / 20);
  const entries = Array.from({ length: 20 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return {
      id: `mem_${String(i).padStart(12, '0')}`,
      title: `旧条目 ${i}`,
      summary: `第 ${i} 条`,
      when: '',
      kind: 'note',
      tags: [],
      created: `2026-01-${day}T00:00:00.000Z`,
      updated: `2026-01-${day}T00:00:00.000Z`,
      lastUsed: `2026-01-${day}T00:00:00.000Z`,
      revision: 1,
      status: 'active',
      source: 'user_explicit',
      hits: 0,
      merges: 0,
      versions: [],
      bytes: chunk,
    };
  });
  fs.writeFileSync(path.join(scope.dir, 'index.json'), JSON.stringify({
    version: 1, scope: scope.key, entries, suggestions: [], receipts: [],
  }));
  fs.mkdirSync(path.join(scope.dir, 'entries'), { recursive: true });
  for (const entry of entries) {
    fs.writeFileSync(path.join(scope.dir, 'entries', `${entry.id}.md`), 'x'.repeat(chunk));
  }
  const saved = upsert(scope, { title: '新的一条', summary: '满了也要能存', body: '新正文' });
  assert.equal(saved.record.title, '新的一条');
  assert.equal(saved.archived.length, 1);
  assert.equal(saved.archived[0].title, '旧条目 0');
  assert.equal(countOf(scope), 20);
  const archived = stateOf(scope).entries.find((row) => row.id === saved.archived[0].id);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.current.title, '旧条目 0');
  assert.equal(archived.current.body.length, chunk);
});

test('the global layer reports both lines', () => {
  const global = globalScope();
  assert.equal(LIMITS.globalEntries, 200);
  const room = store.capacityOf(global, { entries: new Array(41).fill({}) });
  assert.equal(room.cap, 200);
  assert.equal(room.hard, LIMITS.hardEntries);
  assert.equal(room.used, 41);
  assert.equal(room.remaining, 159);
  assert.equal(room.bytes, 0);
  assert.equal(room.bytesLeft, LIMITS.totalBytes);
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
  assert.match(rendered.text, /^- \[global\] mem_/);
  const removed = forget(b, 'mem_000000000000', { mode: 'archive' });
  assert.equal(removed, null);
});

// ── 会话引用 ────────────────────────────────────────────────────────────────
test('citations keep one row per id and drop the oldest', () => {
  const scope = fresh('cite');
  const items = Array.from({ length: LIMITS.citations + 5 }, (_, i) => upsert(scope, {
    title: `条目 ${i}`, summary: `引用第 ${i} 条`, body: `正文 ${i}`, resolution: 'distinct',
  }).record);
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
  recordCitations(scope, 'session-old', [{ id: 'mem_000000000001' }]);
  const file = path.join(store.memoryRoot(), 'sessions', 'session-old.json');
  assert.equal(fs.existsSync(file), true);
  const past = new Date(Date.now() - LIMITS.citationTtlMs - 60_000);
  fs.utimesSync(file, past, past);
  recordCitations(scope, 'session-new', [{ id: 'mem_000000000002' }]);
  assert.equal(fs.existsSync(file), false);
  assert.equal(listCitations('session-new').items.length, 0);
});

test('title is identity: only whitespace is normalized, nothing is cut', () => {
  const scope = fresh('title-clean');
  const saved = upsert(scope, {
    title: 'Chrome 临时 profile 触发「找不到钥匙串」弹窗｜macOS 上由',
    summary: '临时 profile 起 Chrome 会弹钥匙串窗口',
    when: 'macOS 上由 agent 启动 Chrome 且用临时 profile 时',
  });
  assert.equal(saved.record.title, 'Chrome 临时 profile 触发「找不到钥匙串」弹窗｜macOS 上由');

  const pasted = normalizeDraft({ title: '发布顺序 （发版前要按顺序做的事）', summary: '发版前要按顺序做的事', when: '发版前要按顺序做的事' });
  assert.equal(pasted.title, '发布顺序 （发版前要按顺序做的事）');

  const spaced = normalizeDraft({ title: '  发布   顺序  ', summary: '发版前要按顺序做的事' });
  assert.equal(spaced.title, '发布 顺序');
});

test('distinct keeps two entries whose titles normalize to the same name', () => {
  const scope = fresh('title-distinct');
  const first = upsert(scope, { title: '菜单｜工作日', summary: '工作日菜单', body: '周一到周五' });
  const second = upsert(scope, { title: '菜单｜周末', summary: '周末菜单', body: '周六周日', resolution: 'distinct' });
  assert.notEqual(first.record.id, second.record.id);
  assert.equal(countOf(scope), 2);
  assert.equal(search(scope, '菜单').length, 2);

  const sameAgain = upsert(scope, { title: '菜单｜工作日', summary: '工作日菜单另存一份', resolution: 'distinct' });
  assert.notEqual(sameAgain.record.id, first.record.id);
  assert.equal(countOf(scope), 3);
});

test('multi-word search keeps only entries the query really hits (no single-common-word noise)', () => {
  const scope = fresh('relevance');
  upsert(scope, { title: '插件刷新崩溃', summary: '改完插件刷新前端会崩', when: '改完插件要刷新时' });
  upsert(scope, { title: '插件市场收录流程', summary: '提交卡片与预检', when: '上架插件市场前' });
  upsert(scope, { title: '插件安装位置', summary: '本地开发的插件装到 profile' });

  const hits = search(scope, '刷新插件 reload 前端');
  assert.deepEqual(hits.map((item) => item.title), ['插件刷新崩溃']);

  const none = search(scope, '本地视频 侧边栏 播放');
  assert.deepEqual(none, []);
});

test('peek hints on real title overlap and never writes hits', () => {
  const scope = fresh('peek');
  const saved = upsert(scope, { title: 'Chrome 弹钥匙串窗口', summary: '临时 profile 起 Chrome 会弹钥匙串窗口' });
  const before = loadIndex(scope).entries.find((item) => item.id === saved.record.id);
  const hits = store.peek(scope, '又弹钥匙串窗口了，怎么弄', 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, saved.record.id);
  assert.equal(hits[0].scope, 'project');
  const after = loadIndex(scope).entries.find((item) => item.id === saved.record.id);
  assert.equal(after.hits, before.hits);
  assert.equal(after.lastUsed, before.lastUsed);
  assert.deepEqual(store.peek(scope, '把这个按钮的圆角改小一点', 3), []);
});

test('candidate keeps field presence: explicit empty body clears, omitted fields stay', () => {
  const scope = fresh('candidate-presence');
  const created = upsert(scope, {
    title: '字段存在', summary: '省略保持原样', when: '项目内', body: '原正文', tags: ['旧标签'],
  }).record;
  const noted = noteSuggestion(scope, {
    title: '字段存在 改名', summary: '换成新摘要', body: '', targetId: created.id,
  });
  const kept = acceptCandidate(scope, noted.id, '');
  assert.equal(kept.ok, true);
  const after = readEntry(scope, created.id);
  assert.equal(after.title, '字段存在 改名');
  assert.equal(after.summary, '换成新摘要');
  assert.equal(after.when, '项目内');
  assert.deepEqual(after.tags, ['旧标签']);
  assert.equal(after.body, '');
});

test('归档条目仍能搜到并标已归档，正文也能读', () => {
  const scope = fresh('archived-search');
  const created = upsert(scope, { title: '旧端口约定', summary: 'unlag 走 49661', body: '49661' }).record;
  forget(scope, created.id, { mode: 'archive' });
  /** 归档后默认检索不到；只有明确查历史才列出来，并如实标成归档。 */
  assert.equal(search(scope, '旧端口约定', 3, {}).length, 0);
  const hits = search(scope, '旧端口约定', 3, { history: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].archived, true);
  assert.equal(hits[0].status, 'archived');
  const entry = readEntry(scope, created.id);
  assert.equal(entry.status, 'archived');
  assert.equal(entry.body, '49661');
});

test('归档条目也能彻底删除，旧版本与残留正文一并清掉', () => {
  const scope = fresh('purge-archived');
  const saved = upsert(scope, { title: '归档后再忘掉', summary: '管理动作覆盖归档条目', body: '第一版' });
  upsert(scope, { id: saved.record.id, title: '归档后再忘掉', summary: '管理动作覆盖归档条目', body: '第二版' });
  forget(scope, saved.record.id, { mode: 'archive' });
  assert.equal(loadIndex(scope).archived.length, 1);
  const purged = forget(scope, saved.record.id, { mode: 'purge' });
  assert.equal(purged.mode, 'purged');
  assert.equal(loadIndex(scope).archived.length, 0);
  assert.equal(stateOf(scope).entries.length, 0);
  assert.equal(fs.existsSync(path.join(scope.dir, 'entries', `${saved.record.id}.md`)), false);
  assert.equal(forget(scope, saved.record.id, { mode: 'purge' }), null);
});

test('上次彻底删除没做完时，forget 先按原层收尾再返回原回执', () => {
  const scope = fresh('purge-pending');
  const saved = upsert(scope, { title: '删到一半', summary: '屏障期间的重试', body: 'x' });
  const payload = stateOf(scope);
  const op = 'purge_test_pending';
  fs.writeFileSync(path.join(scope.dir, 'purge.intent.json'), `${JSON.stringify({
    operationId: op, scopeKey: scope.key, storeId: payload.storeId, fromEpoch: payload.epoch,
    toEpoch: 'epoch-after-purge', ids: [saved.record.id], phase: 'planned', at: new Date().toISOString(),
  })}
`);
  const purged = forget(scope, saved.record.id, { mode: 'purge' });
  assert.equal(purged.mode, 'purged');
  assert.equal(purged.operationId, op);
  assert.equal(stateOf(scope).entries.length, 0);
  assert.equal(fs.existsSync(path.join(scope.dir, 'purge.intent.json')), false);
});

test('归档条目的彻底删除同样先过屏障，断点收尾后不留正文', () => {
  const scope = fresh('purge-archived-pending');
  const saved = upsert(scope, { title: '归档删一半', summary: '归档条目也走屏障', body: '旧正文' });
  upsert(scope, { id: saved.record.id, title: '归档删一半', summary: '归档条目也走屏障', body: '新正文' });
  forget(scope, saved.record.id, { mode: 'archive' });
  const payload = stateOf(scope);
  fs.writeFileSync(path.join(scope.dir, 'purge.intent.json'), `${JSON.stringify({
    operationId: 'purge_archived_test', scopeKey: scope.key, storeId: payload.storeId, fromEpoch: payload.epoch,
    toEpoch: 'epoch-after-archived-purge', ids: [saved.record.id], phase: 'planned', at: new Date().toISOString(),
  })}
`);
  assert.throws(() => search(scope, '归档删一半', 3, { history: true }), (error) => error.code === 'purge_pending');
  const purged = forget(scope, saved.record.id, { mode: 'purge' });
  assert.equal(purged.mode, 'purged');
  assert.equal(purged.operationId, 'purge_archived_test');
  assert.equal(loadIndex(scope).archived.length, 0);
  assert.equal(fs.existsSync(path.join(scope.dir, 'purge.intent.json')), false);
  assert.equal(search(scope, '归档删一半', 3, {}).length, 0);
});


test('整层写回不丢来源、检查和学习字段，也不改写未知来源值', () => {
  const scope = fresh('codec-full');
  upsert(scope, { title: '代码往返', summary: '整层写回要保住扩展字段', body: '正文' });
  const saved = stateOf(scope).entries[0];
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === saved.id);
    row.origin = 'project_evolution';
    row.maintenance.sourceRefs = [{ kind: 'message', id: 'msg_1', sessionId: 's1' }];
    row.maintenance.checks = [{ at: '2026-01-01T00:00:00.000Z', result: 'passed' }];
    row.maintenance.learning = { state: 'trial', episodeId: 'ep_1', support: 2 };
    return { changed: true };
  });
  const loaded = loadIndex(scope);
  const flat = loaded.entries[0];
  assert.equal(flat.origin, 'project_evolution');
  assert.deepEqual(flat.sourceRefs, [{ kind: 'message', id: 'msg_1', sessionId: 's1' }]);
  assert.deepEqual(flat.checks, [{ at: '2026-01-01T00:00:00.000Z', result: 'passed' }]);
  assert.deepEqual(flat.learning, { state: 'trial', episodeId: 'ep_1', support: 2 });
  upsert(scope, { id: saved.id, summary: '整层写回要保住扩展字段（改过）' });
  const after = stateOf(scope).entries.find((entry) => entry.id === saved.id);
  assert.equal(after.origin, 'project_evolution');
  assert.deepEqual(after.maintenance.sourceRefs, [{ kind: 'message', id: 'msg_1', sessionId: 's1' }]);
  assert.deepEqual(after.maintenance.checks, [{ at: '2026-01-01T00:00:00.000Z', result: 'passed' }]);
  assert.deepEqual(after.maintenance.learning, { state: 'trial', episodeId: 'ep_1', support: 2 });
});

test('只改摘要或正文不会把待核对的范围放宽成普遍适用', () => {
  const scope = fresh('scope-preserve');
  const saved = upsert(scope, {
    title: '发布前检查', summary: '发布前的检查项', when: '发版前', applicability: 'unresolved', body: '旧正文',
  });
  assert.equal(saved.record.applicability, 'unresolved');
  const patched = upsert(scope, { id: saved.record.id, body: '新正文' });
  assert.equal(patched.record.applicability, 'unresolved');
  const summary = upsert(scope, { id: saved.record.id, summary: '发布前的检查项（更新）' });
  assert.equal(summary.record.applicability, 'unresolved');
  const cleared = upsert(scope, { id: saved.record.id, when: '' });
  assert.equal(cleared.record.applicability, 'all_in_scope');
});

test('旧候选 has=true 但条件缺失时拒绝接受并作废候选', () => {
  const scope = fresh('candidate-broken');
  const asked = noteSuggestion(scope, {
    title: '后期配色', summary: '后期统一用暖色', conditions: [{ key: 'taskKind', value: 'video' }],
  });
  state.transact(scope, {}, (draft) => {
    const row = draft.candidates.find((item) => item.id === asked.id);
    delete row.draft.conditions;
    return { changed: true };
  });
  const result = acceptCandidate(scope, asked.id);
  assert.equal(result.ok, false);
  assert.equal(result.invalid, true);
  assert.match(result.reason, /重新建议/);
  assert.equal(suggestionsOf(scope).length, 0);
  assert.equal(countOf(scope), 0);
});

test('实验来源条目默认不进入检索、正文与关联，只有管理面放行', () => {
  const scope = fresh('experimental-gate');
  const normal = upsert(scope, { title: '普通记录', summary: '普通记录可以读', body: '普通正文' });
  upsert(scope, { title: '实验记录', summary: '实验记录默认不可读', body: '实验正文' });
  const target = stateOf(scope).entries.find((entry) => entry.current.title === '实验记录');
  assert.ok(target);
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === target.id);
    row.origin = 'project_evolution';
    row.maintenance.learning = { state: 'paused' };
    return { changed: true };
  });
  assert.equal(search(scope, '实验记录', 4).some((row) => row.id === target.id), false);
  assert.equal(readEntry(scope, target.id), null);
  assert.equal(search(scope, '实验记录', 4, { allowExperimental: true }).some((row) => row.id === target.id), false);
  assert.equal(search(scope, '实验记录', 4, { allowExperimental: true, history: true }).some((row) => row.id === target.id), true);
  assert.equal(readEntry(scope, target.id, { allowExperimental: true }).body, '实验正文');
  assert.ok(readEntry(scope, normal.record.id));
});

test('项目实验默认关闭；打开才放行实验读取，关闭暂停试用且不自动复活', () => {
  const scope = fresh('evolution-switch');
  upsert(scope, { title: '实验规则', summary: '实验规则默认不参与读取', body: '实验正文' });
  const target = stateOf(scope).entries.find((entry) => entry.current.title === '实验规则');
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === target.id);
    row.origin = 'project_evolution';
    row.maintenance.learning = { state: 'trial', specDigest: 'digest-1', supportedEpisodeIds: [] };
    return { changed: true };
  });
  const initial = evolutionStatus(scope);
  assert.equal(initial.enabled, false);
  assert.equal(initial.compatible, true);
  assert.equal(initial.counts.trial, 1);
  assert.equal(search(scope, '实验规则', 4).some((row) => row.id === target.id), false);

  const on = setEvolution(scope, true, { operationId: 'op-enable-1' });
  assert.equal(on.ok, true);
  assert.equal(on.changed, true);
  assert.equal(on.enabled, true);
  assert.notEqual(on.epoch, initial.epoch);
  assert.equal(search(scope, '实验规则', 4).some((row) => row.id === target.id), false);
  assert.equal(search(scope, '实验规则', 4, { allowExperimental: true }).some((row) => row.id === target.id), true);
  assert.equal(readEntry(scope, target.id, { allowExperimental: true }).body, '实验正文');

  const off = setEvolution(scope, false, { operationId: 'op-disable-1' });
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);
  assert.equal(off.counts.paused, 1);
  const paused = stateOf(scope).entries.find((entry) => entry.id === target.id);
  assert.equal(paused.maintenance.learning.state, 'paused');
  assert.equal(paused.maintenance.learning.blockedReason, 'needs_revalidation');
  assert.equal(search(scope, '实验规则', 4).some((row) => row.id === target.id), false);

  const again = setEvolution(scope, true);
  assert.equal(again.enabled, true);
  assert.equal(again.counts.paused, 1);
  assert.equal(again.counts.trial, 0);
  assert.equal(search(scope, '实验规则', 4).some((row) => row.id === target.id), false);
});

test('实验策略版本不认时保持关闭，开关拒绝改动且盘上不变', () => {
  const scope = fresh('evolution-policy');
  upsert(scope, { title: '普通规则', summary: '普通规则', body: '正文' });
  state.transact(scope, {}, (draft) => {
    draft.experimental.projectEvolution.policyVersion = 99;
    return { changed: true };
  });
  const before = fs.readFileSync(path.join(scope.dir, 'state.json'), 'utf8');
  const status = evolutionStatus(scope);
  assert.equal(status.compatible, false);
  assert.equal(status.enabled, false);
  const refused = setEvolution(scope, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.compatible, false);
  assert.equal(fs.readFileSync(path.join(scope.dir, 'state.json'), 'utf8'), before);
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`store.test.mjs: ${passed} passed`);
