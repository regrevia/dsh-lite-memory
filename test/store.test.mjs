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
  evolutionStatus, setEvolution, saveIndex, readCitationBodyByTitle } = store;

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

test('正文正好到 4096 字节可以存，元数据不算进正文上限', () => {
  const scope = fresh('body-cap');
  const body = `${'测'.repeat(1365)}a`;
  const saved = upsert(scope, { title: '正文到顶', summary: '正文刚好到上限', body });
  assert.equal(saved.record.body, body);
  assert.ok(saved.record.bytes > LIMITS.entryBytes);
  assert.throws(() => upsert(scope, { title: '超一点', summary: '正文超一点', body: `${body}a` }), /正文 4097 字节/);
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

test('expired or superseded records do not block a new same-title save', () => {
  const scope = fresh('stale-merge');
  const first = upsert(scope, { title: '旧结论', summary: '这条已经过期', topicKey: 'old-topic', body: '旧' });
  const expired = loadIndex(scope);
  expired.entries.find((row) => row.id === first.record.id).validUntil = new Date(Date.now() - 1000).toISOString();
  saveIndex(scope, expired);
  const next = upsert(scope, { title: '旧结论', summary: '新结论应该另存', topicKey: 'old-topic', body: '新' });
  assert.equal(next.needsResolution, false);
  assert.equal(next.merged, false);
  assert.notEqual(next.record.id, first.record.id);

  const second = upsert(scope, { title: '被取代的结论', summary: '已经被新版本取代', body: '旧' });
  const superseded = loadIndex(scope);
  superseded.entries.find((row) => row.id === second.record.id).supersededBy = 'later';
  saveIndex(scope, superseded);
  const replacement = upsert(scope, { title: '被取代的结论', summary: '沿同名标题重写', body: '新' });
  assert.equal(replacement.needsResolution, false);
  assert.notEqual(replacement.record.id, second.record.id);
});

test('expired reads report their lifecycle and empty reads do not count as usage', () => {
  const scope = fresh('lifecycle-read');
  const first = upsert(scope, { title: '过期条目', summary: '已经过了有效期', body: '旧正文' });
  const index = loadIndex(scope);
  index.entries.find((row) => row.id === first.record.id).validUntil = new Date(Date.now() - 1000).toISOString();
  index.entries.find((row) => row.id === first.record.id).lastUsed = '2026-01-01T00:00:00.000Z';
  saveIndex(scope, index);
  const expired = readEntry(scope, first.record.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.body, '旧正文');
  assert.equal(loadIndex(scope).entries.find((row) => row.id === first.record.id).lastUsed, '2026-01-01T00:00:00.000Z');

  const empty = upsert(scope, { title: '空正文条目', summary: '只有摘要', body: '' }).record;
  loadIndex(scope).entries.find((row) => row.id === empty.id).lastUsed = '2026-01-01T00:00:00.000Z';
  const saved = loadIndex(scope);
  saved.entries.find((row) => row.id === empty.id).lastUsed = '2026-01-01T00:00:00.000Z';
  saveIndex(scope, saved);
  const record = readEntry(scope, empty.id);
  assert.equal(record.body, '');
  assert.equal(loadIndex(scope).entries.find((row) => row.id === empty.id).lastUsed, '2026-01-01T00:00:00.000Z', '空读不算用过');
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

test('over-long title is an error; over-long summary keeps its full text outside the body', () => {
  const scope = fresh('length');
  assert.throws(() => upsert(scope, { title: 't'.repeat(LIMITS.titleChars + 1), summary: '写得短一点' }), /标题超过/);
  const long = '长'.repeat(LIMITS.summaryChars + 1);
  const saved = upsert(scope, { title: '长摘要', summary: long });
  assert.equal(saved.record.summary.length, LIMITS.summaryChars);
  /** 完整原句进维护区，正文保持空：不再往正文里补「摘要原文」尾巴。 */
  assert.equal(readEntry(scope, saved.record.id).body, '');
  assert.equal(saved.record.summaryFull, long);
  assert.equal(readEntry(scope, saved.record.id).maintenance.summaryFull, long);
  assert.equal(saved.draft.fullTextSaved, true);
  assert.equal(saved.draft.fullTextInBody, false);
  assert.equal(saved.draft.summaryShortened, true);
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
  assert.match(rendered.text, /^- 「发布顺序」/);
  assert.doesNotMatch(rendered.text, /mem_[a-z0-9]+/);
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
  assert.equal(rendered.text.split('\n')[0].includes(item.record.id), false, '索引行只给标题');
  assert.match(rendered.text.split('\n')[0], /「旧条目」/);
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
  assert.equal(archived.body, '', '列表只拿归档元数据，不读冷存正文');
  assert.equal(readEntry(scope, first.record.id).body, '第一版正文', '真要读这一条时才从冷存取');
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
  assert.match(rendered.text, /^- \[global\] 「全局条目」/);
  assert.doesNotMatch(rendered.text, /mem_[a-z0-9]{6,}/);
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

test('citation body by title picks the requested layer', () => {
  const scope = fresh('cite-layer');
  const local = upsert(scope, { title: '同名规则', summary: '项目层版本', body: '项目正文' }).record;
  const wide = upsert(globalScope(), { title: '同名规则', summary: '全局层版本', body: '全局正文' }).record;
  recordCitations(scope, 'session-layer', [{ ...local, scope: 'project' }, { ...wide, scope: 'global' }]);
  assert.match(readCitationBodyByTitle('session-layer', '同名规则', { scope: 'project' }).body, /项目正文/);
  assert.match(readCitationBodyByTitle('session-layer', '同名规则', { scope: 'global' }).body, /全局正文/);
  assert.equal(readCitationBodyByTitle('session-layer', '没有这条', { scope: 'global' }), null);
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

test('旧实验规则缺作用域指纹时，打开开关只转待复核并保留正文来源', () => {
  const scope = fresh('evolution-legacy-quarantine');
  upsert(scope, { title: '旧实验规则', summary: '旧规则的作用域没冻结过', body: '以前留下的正文' });
  const target = stateOf(scope).entries.find((entry) => entry.current.title === '旧实验规则');
  assert.ok(target);
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === target.id);
    row.origin = 'project_evolution';
    row.maintenance.learning = { state: 'trial', trialUntil: '2099-01-01T00:00:00.000Z' };
    row.maintenance.sourceRefs = [{ kind: 'message', id: 'msg_legacy', sessionId: 's-legacy' }];
    return { changed: true };
  });
  const on = setEvolution(scope, true, { operationId: 'op-legacy-on' });
  assert.equal(on.ok, true);
  assert.equal(on.changed, true);
  const row = stateOf(scope).entries.find((entry) => entry.id === target.id);
  assert.equal(row.current.body, '以前留下的正文');
  assert.deepEqual(row.maintenance.sourceRefs, [{ kind: 'message', id: 'msg_legacy', sessionId: 's-legacy' }]);
  assert.equal(row.maintenance.reviewState, 'legacy_unreviewed');
  assert.equal(row.maintenance.learning.state, 'paused');
  assert.equal(row.maintenance.learning.blockedReason, 'needs_scope_review');
  assert.equal(search(scope, '旧实验规则', 4).some((entry) => entry.id === target.id), false);
  assert.equal(search(scope, '旧实验规则', 4, { allowExperimental: true }).some((entry) => entry.id === target.id), false);
  const snap = store.learningSnapshot(scope);
  const shown = snap.rules.find((rule) => rule.title === '旧实验规则');
  assert.ok(shown, '待复核规则仍要出现在面板里');
  assert.equal(shown.reviewState, 'legacy_unreviewed');
  assert.equal(shown.state, 'paused');
  const again = setEvolution(scope, true);
  assert.equal(again.changed, false, '重复打开不再产生写入');
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

test('当前不适用的高相关条目不挤掉后面真能用的条目', () => {
  const scope = fresh('usable-rank');
  for (let index = 0; index < 40; index += 1) {
    upsert(scope, {
      title: `旧规则${index}`,
      summary: `旧规则${index}`,
      body: `口播检查项${index}的正文`,
      applicability: 'unresolved',
    });
  }
  const usable = upsert(scope, {
    title: '口播检查项可用',
    summary: '口播检查项可用',
    body: '口播检查项的可用正文',
    applicability: 'all_in_scope',
  });
  const usableId = usable.record?.id ?? usable.id;
  const hits = search(scope, '口播检查项', 3);
  assert.equal(hits.some((row) => row.id === usableId), true);
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });

test('R24 省略正文的更新不覆盖已有正文（按 id 与同名都成立）', () => {
  const scope = fresh('omit-body');
  const first = upsert(scope, { title: '连接池改法', summary: '旧摘要', body: '旧正文：先看连接数。' });
  const id = first.record.id;
  upsert(scope, { id, title: '连接池改法', summary: '新摘要' });
  assert.equal(bodyOf(scope, id), '旧正文：先看连接数。', 'id 更新省略正文时保留原正文');
  upsert(scope, { title: '连接池改法', summary: '再新一点' });
  assert.equal(bodyOf(scope, id), '旧正文：先看连接数。', '同名更新省略正文时保留原正文');
});

test('R25 长摘要改动即使只差第 61 个字符也算改过，完整原句另存', () => {
  const scope = fresh('long-summary-change');
  const head = '摘要主体'.repeat(15);
  const first = upsert(scope, { title: '长摘要规则', summary: `${head}甲` });
  const id = first.record.id;
  assert.equal(first.record.summary.length, LIMITS.summaryChars);
  assert.equal(bodyOf(scope, id), '', '正文不塞摘要原文');
  assert.equal(first.record.summaryFull, `${head}甲`);
  const again = upsert(scope, { id, title: '长摘要规则', summary: `${head}乙` });
  assert.equal(again.noop, false, '第 61 个字符变化不能当作没改');
  assert.equal(bodyOf(scope, id), '');
  assert.equal(again.record.summaryFull, `${head}乙`, '新的完整摘要也落盘');
  assert.equal(again.record.maintenance.summaryFull, `${head}乙`);
  assert.equal(again.record.summary.length, LIMITS.summaryChars);
});

test('R26 显式长正文加短摘要时完整原句另存，不混进正文', () => {
  const scope = fresh('body-plus-summary');
  const long = '现场记录'.repeat(20);
  const saved = upsert(scope, { title: '带正文的长摘要', summary: long, body: '显式正文：先复现再改。' });
  const record = readEntry(scope, saved.record.id);
  assert.equal(record.body, '显式正文：先复现再改。');
  assert.doesNotMatch(record.body, /摘要原文：/);
  assert.equal(record.summaryFull, long);
  assert.equal(record.maintenance.summaryFull, long);
  assert.equal(saved.draft.fullTextSaved, true);
  assert.equal(saved.draft.fullTextInBody, false);
});

// ── 长摘要、用户正文里的「摘要原文：」、凭据、冷存删除 ─────────────────
test('用户正文里自带「摘要原文：」时原样保留，保存与再次更新都不改写', () => {
  const scope = fresh('user-tail-text');
  const body = '用户原话：\n摘要原文：这里本来就是正文的一部分，别动它。';
  const saved = upsert(scope, { title: '用户写的正文', summary: '用户正文原样保留', body });
  const id = saved.record.id;
  assert.equal(bodyOf(scope, id), body);
  upsert(scope, { id, title: '用户写的正文', summary: '再更新一次也不动正文', body });
  assert.equal(bodyOf(scope, id), body, '第二次更新也不能剥离用户正文');
  assert.equal(readEntry(scope, id).maintenance.legacySummaryTail, true, '旧标记只做待整理提示');
});

test('长摘要改短后清掉旧的完整原句，不留托管尾巴', () => {
  const scope = fresh('summary-cleared');
  const long = '完整摘要'.repeat(20);
  const saved = upsert(scope, { title: '先长后短', summary: long });
  const id = saved.record.id;
  assert.equal(readEntry(scope, id).summaryFull, long);
  upsert(scope, { id, title: '先长后短', summary: '改成一句短的' });
  const record = readEntry(scope, id);
  assert.equal(record.summaryFull, '');
  assert.equal(record.maintenance.summaryFull, undefined);
  assert.equal(record.body, '');
  assert.equal(stateOf(scope).entries[0].maintenance.summaryFull, undefined, '热状态里也不留旧原文');
});

test('冷存共享原文片段时只删目标条目，另一条的正文与历史完整', () => {
  const scope = fresh('cold-shared');
  const shared = '这段原文两条都用到';
  const a = upsert(scope, { title: '共享片段 A', summary: '第一条', body: `${shared}，A 的细节` });
  const b = upsert(scope, { title: '共享片段 B', summary: '第二条', body: `${shared}，B 的细节`, resolution: 'distinct' });
  upsert(scope, { id: b.record.id, title: '共享片段 B', summary: '第二条改过', body: `${shared}，B 的第二版` });
  forget(scope, a.record.id, { mode: 'archive' });
  forget(scope, b.record.id, { mode: 'archive' });
  const coldA = path.join(scope.dir, 'cold', `${a.record.id}.json`);
  const coldB = path.join(scope.dir, 'cold', `${b.record.id}.json`);
  assert.equal(fs.existsSync(coldA), true);
  assert.equal(fs.existsSync(coldB), true);
  forget(scope, a.record.id, { mode: 'purge' });
  assert.equal(fs.existsSync(coldA), false, 'A 的冷存按 id 删除');
  assert.equal(fs.existsSync(coldB), true, 'B 的冷存一个字都不能动');
  const left = readEntry(scope, b.record.id);
  assert.equal(left.body, `${shared}，B 的第二版`);
  assert.ok(left.versions.length >= 1, 'B 的历史版本还在');
  assert.match(JSON.stringify(fs.readFileSync(coldB, 'utf8')), /B 的第一版|B 的细节|B 的第二版/);
  assert.equal(fs.existsSync(path.join(scope.dir, 'cold')), true);
});

test('冷存缺失、损坏或身份不符时报明确错误，不拿空正文顶上', () => {
  const scope = fresh('cold-broken');
  const saved = upsert(scope, { title: '冷存出错', summary: '读回要报错', body: '冷存正文：读回要报错' });
  const id = saved.record.id;
  forget(scope, id, { mode: 'archive' });
  const file = path.join(scope.dir, 'cold', `${id}.json`);
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ 不是 json');
  assert.doesNotThrow(() => loadIndex(scope), '列表不读归档正文，冷存坏了也不能整层失败');
  assert.throws(() => readEntry(scope, id), /冷存|cold_corrupt/);
  fs.writeFileSync(file, JSON.stringify({ id: 'other', scope: scope.key, revision: 1, body: '别人的正文' }));
  assert.throws(() => readEntry(scope, id), /冷存|cold_corrupt/);
  fs.rmSync(file);
  assert.throws(() => readEntry(scope, id), /冷存|cold_missing/);
  fs.writeFileSync(file, good);
  assert.equal(readEntry(scope, id).body, '冷存正文：读回要报错');
});

test('归档正文懒加载：列表与 snapshot 不读冷存，只有读到该条正文才报 cold_missing', () => {
  const scope = fresh('cold-lazy');
  const saved = upsert(scope, { title: '归档懒读', summary: '列表不读正文', body: '懒加载正文：只有读这一条才取' });
  const id = saved.record.id;
  forget(scope, id, { mode: 'archive' });
  const file = path.join(scope.dir, 'cold', `${id}.json`);
  assert.equal(fs.existsSync(file), true);
  fs.rmSync(file);
  const index = loadIndex(scope);
  const archived = index.archived.find((row) => row.id === id);
  assert.ok(archived, '归档元数据照常加载');
  assert.equal(archived.body, '');
  assert.equal(archived.coldBody, '');
  assert.doesNotThrow(() => store.learningSnapshot(scope));
  assert.equal(search(scope, '归档懒读').length, 0, '列表/搜索只认真在用（active）的记录');
  assert.throws(() => readEntry(scope, id), /冷存|cold_missing/, '真要读这一条正文时缺冷存就报明确错误');
});

test('被截掉的摘尾巴里藏凭据也要拒绝', () => {
  const scope = fresh('summary-tail-secret');
  const mask = '这条摘要的前半段可以短一点'.repeat(5);
  const secret = ' token = sk-abcdefghijklmnopqrst';
  assert.throws(() => upsert(scope, {
    title: '凭据藏尾巴', summary: `${mask}${secret}`, body: '显式正文',
  }), /凭据/);
  assert.equal(fs.existsSync(path.join(scope.dir, 'state.json')), false);
});

test('归属路由：本机痕迹的「通用流程」留在项目层，干净流程带依据才进全局', () => {
  const project = { confirmed: true };
  const bound = store.routeScope({
    title: '部署脚本', summary: '本机部署脚本的位置', body: 'bash /tmp/deploy.sh，再看 127.0.0.1:8080',
    memoryClass: 'portable_procedure', scope: 'global',
  }, { project });
  assert.equal(bound.chosenScope, 'project');
  assert.equal(bound.reasonCode, 'machine_bound_scope');

  const boundNoScope = store.routeScope({
    title: '本机路径', summary: '部署脚本在 /tmp 下', body: 'bash /tmp/deploy.sh',
    memoryClass: 'portable_procedure',
  }, { project });
  assert.equal(boundNoScope.chosenScope, 'project');
  assert.equal(boundNoScope.reasonCode, 'machine_bound_procedure');

  const noEvidence = store.routeScope({
    title: '提交前跑测试', summary: '提交前跑测试', body: 'pnpm test',
    memoryClass: 'portable_procedure',
  }, { project });
  assert.equal(noEvidence.chosenScope, 'project');
  assert.equal(noEvidence.reasonCode, 'unbound_evidence');

  const withEvidence = store.routeScope({
    title: '提交前跑测试', summary: '提交前跑测试', body: 'pnpm test',
    memoryClass: 'portable_procedure', evidenceRef: '团队 wiki 的提交流程页',
  }, { project });
  assert.equal(withEvidence.chosenScope, 'global');
  assert.equal(withEvidence.reasonCode, 'class_portable_procedure');

  const evidencePath = store.routeScope({
    title: '提交前跑测试', summary: '提交前跑测试', body: 'pnpm test',
    memoryClass: 'portable_procedure', evidenceRef: '/tmp/notes/deploy.md',
  }, { project });
  assert.equal(evidencePath.chosenScope, 'project', '依据本身是本机文件不算普适证据');
  assert.equal(evidencePath.reasonCode, 'machine_bound_procedure');

  const osOnlyProcedure = store.routeScope({
    title: '本机部署脚本', summary: '本机部署脚本的位置', body: 'bash /tmp/deploy.sh',
    memoryClass: 'portable_procedure', scope: 'global',
    conditions: [{ key: 'targetOs', value: 'macos' }],
  }, { project });
  assert.equal(osOnlyProcedure.chosenScope, 'project', '只写操作系统名收不住本机路径');
  assert.equal(osOnlyProcedure.reasonCode, 'machine_bound_scope');

  const osOnlyClass = store.routeScope({
    title: '本机部署脚本', summary: '本机部署脚本的位置', body: 'bash /tmp/deploy.sh',
    memoryClass: 'portable_procedure',
    conditions: [{ key: 'targetOs', value: 'macos' }],
  }, { project });
  assert.equal(osOnlyClass.chosenScope, 'project', 'targetOs 不是机器条件，不能凭它搬去全局层');
  assert.equal(osOnlyClass.reasonCode, 'machine_bound_procedure');

  const scopedProcedure = store.routeScope({
    title: 'npm 操作走 dsh-npm', summary: '本机 npm 命令用包装脚本',
    body: '本机 npm 一律用 dsh-npm；裸 npm 报 ENEEDAUTH 不是缺凭据',
    memoryClass: 'portable_procedure',
    conditions: [{ key: 'machine', value: 'macOS 桌面机' }],
  }, { project });
  assert.equal(scopedProcedure.chosenScope, 'global', '声明了机器条件的本机流程可进全局层');
  assert.equal(scopedProcedure.reasonCode, 'machine_scoped_procedure');

  const scopedExplicit = store.routeScope({
    title: 'npm 操作走 dsh-npm', summary: '本机 npm 命令用包装脚本',
    body: '本机 npm 一律用 dsh-npm；裸 npm 报 ENEEDAUTH 不是缺凭据',
    memoryClass: 'portable_procedure', scope: 'global',
    conditions: [{ key: 'machine', value: 'macOS 桌面机' }],
  }, { project });
  assert.equal(scopedExplicit.chosenScope, 'global');
  assert.equal(scopedExplicit.reasonCode, 'explicit');

  const unconfirmed = store.routeScope({
    title: '部署脚本', summary: '本机部署脚本', body: 'bash /tmp/deploy.sh',
    memoryClass: 'portable_procedure', scope: 'global',
  }, { project: { confirmed: false } });
  assert.equal(unconfirmed.needsScope, true);
  assert.equal(unconfirmed.reasonCode, 'needs_environment');
  assert.deepEqual(unconfirmed.requiredConditions.map((row) => row.key), ['machine', 'runtime']);

  const humanGlobal = store.routeScope({
    title: '部署脚本', summary: '本机部署脚本', body: 'bash /tmp/deploy.sh',
    memoryClass: 'portable_procedure', scope: 'global',
  }, { project, humanScope: true });
  assert.equal(humanGlobal.chosenScope, 'global');
  assert.equal(humanGlobal.reasonCode, 'explicit');

  const modelGlobalFact = store.routeScope({
    title: '发布分支', summary: '本仓库发布分支是 main', body: 'main',
    memoryClass: 'project_fact', scope: 'global',
  }, { project });
  assert.equal(modelGlobalFact.chosenScope, 'project', '模型自填 global 不能把项目事实送进全局层');
  assert.equal(modelGlobalFact.reasonCode, 'model_global_project_fact');

  /** 显式 global 是用户要的那一层：没 evidenceRef 也只代表模型没补依据，不能把它降回项目层。 */
  const userGlobalProcedure = store.routeScope({
    title: '提交前跑测试', summary: '提交前跑测试', body: 'pnpm test',
    memoryClass: 'portable_procedure', scope: 'global',
  }, { project });
  assert.equal(userGlobalProcedure.chosenScope, 'global');
  assert.equal(userGlobalProcedure.reasonCode, 'explicit');

  /** 没显式 scope 时，memoryClass 只是提案：缺可搬依据的流程仍留在项目层。 */
  const classOnlyProcedure = store.routeScope({
    title: '提交前跑测试', summary: '提交前跑测试', body: 'pnpm test',
    memoryClass: 'portable_procedure',
  }, { project });
  assert.equal(classOnlyProcedure.chosenScope, 'project', '没有显式 scope 又缺依据，不能自己搬去全局层');
  assert.equal(classOnlyProcedure.reasonCode, 'unbound_evidence');
});

test('几百条归档的正文不进热状态，下一次保存照样能过', () => {
  const scope = fresh('cold-archives');
  fs.mkdirSync(scope.dir, { recursive: true });
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const row = (id, status, title, body) => ({
    id,
    revision: 1,
    status,
    origin: 'user_explicit',
    createdAt: at,
    updatedAt: at,
    current: {
      title, summary: title, body, kind: 'note', when: '', keywords: [], topicKey: '',
      triggers: [], applicability: 'all_in_scope', conditions: [], selection: null, links: [], aliases: [],
    },
    maintenance: { reviewState: 'current', sourceRefs: [], retiredNames: [], versions: [], checks: [], hits: 0, merges: 0, lastUsed: at },
  });
  const build = (chars) => {
    const big = state.emptyState(scope);
    big.entries.push(row('mem_cold00000001', 'active', '现役条目', '现役正文'));
    const body = '归档正文示例'.repeat(1).padEnd(1) + '归'.repeat(chars);
    for (let i = 0; i < 480; i += 1) {
      big.entries.push(row(`mem_cold${String(i + 2).padStart(8, '0')}`, 'archived', `旧条目 ${i}`, body));
    }
    return state.encodeState(big);
  };
  let chars = 1400;
  let encoded = build(chars);
  for (let attempt = 0; attempt < 30 && Buffer.byteLength(encoded) > LIMITS.stateBytes - 1200; attempt += 1) {
    const over = Buffer.byteLength(encoded) - (LIMITS.stateBytes - 1200);
    chars -= Math.max(1, Math.ceil(over / (480 * 3)));
    encoded = build(chars);
  }
  const seeded = Buffer.byteLength(encoded);
  assert.ok(seeded <= LIMITS.stateBytes, '造出的热状态本身还得读得动');
  assert.ok(seeded > LIMITS.stateBytes - 3200, '离上限只差一条新记忆');
  fs.writeFileSync(path.join(scope.dir, 'state.json'), encoded);

  const saved = upsert(scope, { title: '新的一条', summary: '归档再多也要能写', body: '新正文'.repeat(400) });
  assert.equal(saved.record.title, '新的一条');
  assert.ok(Buffer.byteLength(rawState(scope)) < LIMITS.stateBytes, '热状态回到上限内');
  assert.equal(fs.existsSync(path.join(scope.dir, 'cold')), true);
  assert.equal(fs.existsSync(path.join(scope.dir, 'archive')), false);
  const archivedId = 'mem_cold00000002';
  assert.match(readEntry(scope, archivedId).body, /归档正文示例/, '归档正文还能读到');
  assert.match(search(scope, '新的一条')[0].title, /新的一条/);
});

test('lastUsed 只在真读过且够旧时回写，刚存下的条目不动', () => {
  const scope = fresh('last-used-touch');
  const created = upsert(scope, { title: '会被读的条目', summary: '读一次要记下用过', body: '正文' });
  const id = created.record.id;
  const freshUsed = loadIndex(scope).entries.find((entry) => entry.id === id).lastUsed;
  readEntry(scope, id);
  assert.equal(loadIndex(scope).entries.find((entry) => entry.id === id).lastUsed, freshUsed, '十分钟内不写盘');
  search(scope, '会被读的条目');
  assert.equal(loadIndex(scope).entries.find((entry) => entry.id === id).lastUsed, freshUsed);

  const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const index = loadIndex(scope);
  index.entries.find((entry) => entry.id === id).lastUsed = stale;
  store.saveIndex(scope, index);
  assert.equal(stateOf(scope).entries.find((entry) => entry.id === id).maintenance.lastUsed, stale);
  readEntry(scope, id);
  const touched = loadIndex(scope).entries.find((entry) => entry.id === id).lastUsed;
  assert.notEqual(touched, stale);
  assert.ok(Date.now() - Date.parse(touched) < 60_000, '过旧时读一次就回写');

  const other = upsert(scope, { title: '葡萄柚检索目标', summary: '葡萄柚专用的检索记录', body: '葡萄柚正文' });
  assert.ok(other.record, '第二条要真的新建出来');
  const staleSearch = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const again = loadIndex(scope);
  again.entries.find((entry) => entry.id === other.record.id).lastUsed = staleSearch;
  store.saveIndex(scope, again);
  search(scope, '葡萄柚检索目标');
  assert.notEqual(loadIndex(scope).entries.find((entry) => entry.id === other.record.id).lastUsed, staleSearch);
});

test('项目层未绑作品的候选也能开始整理并提交成规则', () => {
  const scope = fresh('learning-unbound');
  const on = setEvolution(scope, true, { operationId: 'evo-unbound-on' });
  assert.equal(on.ok, true);
  const started = store.beginLearningAttempt(scope, { episodeId: '', operationId: 'unbound-start' });
  assert.equal(started.ok, true, started.reason);
  assert.equal(started.episodeId, '', '不编造作品 id');
  const change = {
    target: 'new', feedbackType: 'spec_change', topicKey: '口播开头',
    currentText: '开头三句内给结论。', applicability: 'conditional',
    conditions: [{ key: 'seriesId', value: '口播' }], evidence: ['u0'], persistence: 'project_candidate',
  };
  const committed = store.commitLearning(scope, {
    operationId: 'unbound-commit', epoch: started.epoch, episodeId: '', projectId: scope.key,
    sessionId: 's-unbound', messageIds: ['m1'], changes: [change], preparedTargets: [],
  });
  assert.equal(committed.ok, true, committed.reason);
  const rules = stateOf(scope).entries.filter((entry) => entry.origin === 'project_evolution');
  assert.equal(rules.length, 1);
  assert.match(rules[0].current.title, /开头|口播/);

  const foreign = store.commitLearning(scope, {
    operationId: 'unbound-foreign', epoch: started.epoch, episodeId: '', projectId: 'other-project',
    sessionId: 's-unbound', messageIds: ['m1'], changes: [change], preparedTargets: [],
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /缺少作品标识/);
});

test('整理回执的 evidence 带上用户原句，优先本次改动其次整批', () => {
  const changeFor = (extra = {}) => ({
    target: 'new', feedbackType: 'spec_change', topicKey: '口播开头',
    currentText: '开头三句内给结论。', applicability: 'conditional',
    conditions: [{ key: 'seriesId', value: '口播' }], evidence: ['u0'], persistence: 'project_candidate',
    ...extra,
  });
  const commitOnce = (scope, batchExcerpt, changeExcerpt) => {
    assert.equal(setEvolution(scope, true, { operationId: `evo-evidence-${scope.key}` }).ok, true);
    const started = store.beginLearningAttempt(scope, { episodeId: '', operationId: `start-evidence-${scope.key}` });
    assert.equal(started.ok, true, started.reason);
    const committed = store.commitLearning(scope, {
      operationId: `commit-evidence-${scope.key}`, epoch: started.epoch, episodeId: '', projectId: scope.key,
      sessionId: 's-evidence', messageIds: ['m1', 'm2'],
      sourceExcerpt: batchExcerpt,
      changes: [changeFor(changeExcerpt ? { sourceExcerpt: changeExcerpt } : {})], preparedTargets: [],
    });
    assert.equal(committed.ok, true, committed.reason);
    return loadIndex(scope).entries.find((entry) => entry.origin === 'project_evolution');
  };
  const fromBatch = commitOnce(fresh('evidence-batch'), '用户原话：开头别绕，三句内给结论。');
  assert.equal(fromBatch.learning.sourceExcerpt, '用户原话：开头别绕，三句内给结论。');
  assert.deepEqual(fromBatch.learning.sourceRefs.at(-1).messageIds, ['m1', 'm2'], 'messageIds 仍是真实消息');
  const fromChange = commitOnce(fresh('evidence-change'), '整批摘录不该优先', '用户原话：开头三句内给结论，别铺垫。');
  assert.equal(fromChange.learning.sourceExcerpt, '用户原话：开头三句内给结论，别铺垫。', '本次改动摘录优先');
});

test('整理器规则顺序与开始整理时一致，按状态/最近使用排而不是插入顺序', () => {
  const scope = fresh('organizer-order');
  const on = setEvolution(scope, true, { operationId: 'order-evo-on' });
  assert.equal(on.ok, true, on.reason);
  const started = store.beginLearningAttempt(scope, { episodeId: '', operationId: 'order-start' });
  assert.equal(started.ok, true, started.reason);
  const changes = ['先写的旧规则', '后写的新规则'].map((topic) => ({
    target: 'new', feedbackType: 'spec_change', topicKey: topic,
    currentText: `${topic}：按规则走。`, applicability: 'all_in_scope',
    evidence: ['u0'], persistence: 'project_candidate',
  }));
  const committed = store.commitLearning(scope, {
    operationId: 'order-commit', epoch: started.epoch, projectId: scope.key,
    sessionId: 's-order', messageIds: ['m1'], changes, preparedTargets: [],
  });
  assert.equal(committed.ok, true, committed.reason);
  const organizer = store.learningRulesForOrganizer(scope).map((row) => row.id);
  assert.equal(organizer.length, 2);
  assert.deepEqual(store.learningRulesForOrganizer(scope).map((row) => row.id), organizer, '顺序确定，重复调用不变');
  const again = store.beginLearningAttempt(scope, { episodeId: '', operationId: 'order-start-2' });
  assert.equal(again.ok, true, again.reason);
  assert.deepEqual(again.rules.map((row) => row.id), organizer, '两处必须同一个顺序');
});

/** 冷存是归档正文唯一的家：写入必须和 state.json 一样 fsync 文件 + 目录，失败要整次保存失败。 */
const traceDurability = () => {
  const opened = new Map();
  const synced = [];
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  fs.openSync = (file, flags, ...rest) => {
    const fd = realOpen.call(fs, file, flags, ...rest);
    opened.set(fd, String(file));
    return fd;
  };
  fs.fsyncSync = (fd) => {
    synced.push(opened.get(fd) || '');
    return realFsync.call(fs, fd);
  };
  return {
    opened,
    synced,
    restore() {
      fs.openSync = realOpen;
      fs.fsyncSync = realFsync;
    },
  };
};

test('归档正文写冷存时 fsync 文件和目录（与 state.json 同一落盘序列）', () => {
  const scope = fresh('cold-fsync-trace');
  const created = upsert(scope, { title: '落盘冷存', summary: '冷存落盘序列', kind: 'note' }, {});
  const trace = traceDurability();
  try {
    const result = forget(scope, created.record.id, { mode: 'archive' });
    assert.equal(result.mode, 'archive');
  } finally {
    trace.restore();
  }
  const coldDir = path.join(scope.dir, 'cold');
  assert.ok(trace.synced.some((file) => file === coldDir), `冷存目录要 fsync：${JSON.stringify(trace.synced)}`);
  assert.ok(trace.synced.some((file) => file.startsWith(path.join(coldDir, '.')) && file.endsWith('.tmp')),
    `冷存临时文件要先 fsync 再 rename：${JSON.stringify(trace.synced)}`);
  const file = path.join(coldDir, `${created.record.id}.json`);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('冷存 fsync 失败时保存失败、不发布状态、不留半个冷存文件', () => {
  const scope = fresh('cold-fsync-fail');
  const body = '归档正文必须能读回来';
  const created = upsert(scope, { title: '写不进去的冷存', summary: '冷存 fsync 失败', body, kind: 'note' }, {});
  const trace = traceDurability();
  const coldDir = path.join(scope.dir, 'cold');
  try {
    const opened = trace.opened;
    const real = fs.fsyncSync;
    fs.fsyncSync = (fd) => {
      const file = opened.get(fd) || '';
      if (file.startsWith(path.join(coldDir, '.')) && file.endsWith('.tmp')) {
        const error = new Error('injected fsync failure');
        error.code = 'EIO';
        throw error;
      }
      return real.call(fs, fd);
    };
    assert.throws(() => forget(scope, created.record.id, { mode: 'archive' }),
      (error) => error.code === 'unavailable' && /归档正文没写进冷存/.test(error.message));
  } finally {
    trace.restore();
  }
  assert.equal(fs.existsSync(path.join(coldDir, `${created.record.id}.json`)), false, 'fsync 没成功就不能有权威冷存文件');
  const tmpLeft = fs.existsSync(coldDir) ? fs.readdirSync(coldDir).filter((name) => name.endsWith('.tmp')) : [];
  assert.deepEqual(tmpLeft, [], '失败的临时文件要清掉');
  assert.equal(bodyOf(scope, created.record.id), body, '发布失败时热状态原样保留正文');
  const retried = forget(scope, created.record.id, { mode: 'archive' });
  assert.equal(retried.mode, 'archive');
  const healed = readEntry(scope, created.record.id);
  assert.equal(healed.status, 'archived');
  assert.equal(healed.body, body);
});


test('一条冷存文件损坏不再拖死整层写入：退回热正文并重写好文件', () => {
  const scope = fresh('cold-corrupt-heal');
  const body = '归档正文还能从热状态找回来';
  const created = upsert(scope, { title: '冷存坏了', summary: '损坏自愈', body, kind: 'note' }, {});
  const coldFile = path.join(scope.dir, 'cold', `${created.record.id}.json`);
  fs.mkdirSync(path.dirname(coldFile), { recursive: true });
  fs.writeFileSync(coldFile, '{"broken":');
  const index = loadIndex(scope);
  /** 模拟预算腾位：正文还在热状态，索引里只留归档占位（没有 coldBody，必须去读冷存）。 */
  index.archived = [{ id: created.record.id, title: '冷存坏了', status: 'archived' }];
  index.entries = index.entries.filter((row) => row.id !== created.record.id);
  saveIndex(scope, index);
  const healed = readEntry(scope, created.record.id);
  assert.equal(healed.status, 'archived');
  assert.equal(healed.body, body, '自愈后正文要读得回来');
  assert.equal(JSON.parse(fs.readFileSync(coldFile, 'utf8')).body, body, '坏文件要被重写成好文件');
});

test('冷存坏了且热状态也没有正文：仍然明确报 cold_corrupt，不冒充空正文', () => {
  const scope = fresh('cold-corrupt-fail');
  upsert(scope, { title: '占位', summary: '保持状态存在', body: '正常正文', kind: 'note' });
  const orphan = 'mem_999999999999';
  const coldFile = path.join(scope.dir, 'cold', `${orphan}.json`);
  fs.mkdirSync(path.dirname(coldFile), { recursive: true });
  fs.writeFileSync(coldFile, 'not json');
  const index = loadIndex(scope);
  index.archived = [{ id: orphan, title: '孤儿归档', status: 'archived' }];
  assert.throws(() => saveIndex(scope, index), (error) => error.code === 'cold_corrupt');
  assert.equal(fs.readFileSync(coldFile, 'utf8'), 'not json', '救不回来时不动那个坏文件');
  assert.equal(index.entries.length, 1, '失败时不能悄悄丢掉别的条目');
});

console.log(`store.test.mjs: ${passed} passed`);
