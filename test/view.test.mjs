/**
 * 投影与语义闸门：只测「模型该看到什么、自动召回该不该拿、删了之后还会不会冒出来」。
 * 涉及具体措辞的断言都取用户原话，避免把内部命名写进测试。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-view-'));
const view = await import('../view.js');
const store = await import('../store.js');
const state = await import('../state.js');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lm-view-${label}-`));
  dirs.push(dir);
  return store.scopeOf(dir);
};
const ctxOf = (scope, extra = {}) => view.trustedContext(scope, extra);

test('提示只认用户自己说的话，宿主合成的消息不算', () => {
  const human = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后视频都给本地链接' }] };
  const goal = { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: '<goal_round>\nObjective: 把插件做稳定' }] };
  const snapshot = { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] };
  const runtime = { role: 'user', content: [{ type: 'text', text: 'Current runtime context. 已有记忆可能相关：\n- 「插件热重载」' }] };
  const job = { role: 'user', content: [{ type: 'text', text: 'background job bash-1 finished' }] };
  assert.equal(view.newestUserQuery([human]), '以后视频都给本地链接');
  assert.equal(view.newestUserQuery([human, goal, snapshot, runtime, job]), '以后视频都给本地链接');
  assert.equal(view.newestUserQuery([goal, runtime, job]), '');
  assert.equal(view.newestUserQuery([]), '');
});

test('条件与清单只收能核验的写法', () => {
  assert.deepEqual(view.normalizeConditions([{ key: 'targetOs', value: 'macOS' }]), [{ key: 'targetOs', value: 'macOS' }]);
  assert.deepEqual(view.normalizeConditions([]), []);
  assert.throws(() => view.normalizeConditions([{ key: 'favorite', value: 'x' }]), /不认这个条件键/);
  assert.throws(() => view.normalizeConditions([{ key: 'shell', value: 'zsh' }, { key: 'shell', value: 'bash' }]), /重复/);
  assert.throws(() => view.normalizeConditions(new Array(9).fill({ key: 'shell', value: 'zsh' })), /最多 8 条/);
  assert.throws(() => view.normalizeSelection({ mode: 'complete' }), /artifactKey/);
  assert.deepEqual(view.normalizeSelection({ mode: 'examples', items: ['无糖'] }), { mode: 'examples', artifactKey: '', items: ['无糖'] });
  assert.throws(() => view.normalizeTriggers(['a', 'b', 'c', 'd', 'e']), /最多 4 个/);
  assert.throws(() => view.normalizeLinks([{ type: 'related', id: 'mem_000000000001' }], 'mem_000000000001'), /不能关联自己/);
  assert.throws(() => view.normalizeLinks([{ type: 'related', id: 'nope' }]), /不合法/);
  assert.throws(() => view.normalizeLinks([{ type: 'related', id: 'mem_000000000001' }, { type: 'related', id: 'mem_000000000001' }]), /重复/);
});

test('适用范围按字段推断，自相矛盾的组合写不进去', () => {
  assert.equal(view.decideApplicability({ conditions: [], when: '' }), 'all_in_scope');
  assert.equal(view.decideApplicability({ conditions: [{ key: 'shell', value: 'zsh' }] }), 'conditional');
  assert.equal(view.decideApplicability({ when: '周四晚上' }), 'unresolved');
  assert.equal(view.decideApplicability({ applicability: 'unresolved', when: '' }), 'unresolved');
  assert.throws(() => view.validateApplicability('all_in_scope', [{ key: 'shell', value: 'zsh' }]), /普遍适用不能带条件/);
  assert.throws(() => view.validateApplicability('conditional', []), /至少要给一个条件/);
});

test('条件裁决：不把不知道当不存在，也不把未解决当普遍适用', () => {
  const record = { id: 'mem_000000000001', applicability: 'conditional', conditions: [{ key: 'targetOs', value: 'macOS' }], when: '' };
  assert.equal(view.evaluate(record, ctxOf(null, { targetOs: 'macos' })).state, 'match');
  assert.equal(view.evaluate(record, ctxOf(null, { targetOs: 'linux' })).state, 'mismatch');
  assert.equal(view.evaluate(record, ctxOf(null, {})).state, 'unknown');
  const unresolved = { ...record, applicability: 'unresolved', conditions: [] };
  assert.equal(view.statusOf(unresolved, ctxOf(null, {})), 'needs_context');
  assert.equal(view.canAutoRecall(unresolved, ctxOf(null, {})), false);
  const legacy = { ...record, applicability: 'all_in_scope', conditions: [], reviewState: 'legacy_unreviewed' };
  assert.equal(view.canAutoRecall(legacy, ctxOf(null, {})), false);
});

test('complete 只对指定对象成立；对象不明时需上下文，对象不符时不适用', () => {
  const record = {
    id: 'mem_000000000002',
    applicability: 'conditional',
    conditions: [{ key: 'pathPrefix', value: '/tmp/project' }],
    selection: { mode: 'complete', artifactKey: 'menu:main', items: ['无糖'] },
    when: '',
  };
  assert.equal(view.evaluate(record, ctxOf(null, { pathPrefix: '/tmp/project', artifactKey: 'menu:main' })).state, 'match');
  assert.equal(view.evaluate(record, ctxOf(null, { pathPrefix: '/tmp/project', artifactKey: 'menu:other' })).state, 'mismatch');
  assert.equal(view.evaluate(record, ctxOf(null, { pathPrefix: '/tmp/project' })).state, 'unknown');
  assert.equal(view.evaluate(record, ctxOf(null, { pathPrefix: '/tmp/elsewhere', artifactKey: 'menu:main' })).state, 'mismatch');
});

test('召回先过阈值再排序，条件未知的不进自动召回', () => {
  const rows = [
    { id: 'mem_000000000001', title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint', tags: [], when: '', applicability: 'all_in_scope', conditions: [], selection: null, lastUsed: '2026-01-01T00:00:00.000Z' },
    { id: 'mem_000000000002', title: '发布流程', summary: '发版顺序', tags: [], when: '', applicability: 'conditional', conditions: [{ key: 'shell', value: 'zsh' }], selection: null, lastUsed: '2026-02-01T00:00:00.000Z' },
  ];
  const plainHits = view.rank(rows, '发布', { limit: 4 });
  assert.ok(plainHits.every((item) => item.score >= view.MATCH_FLOOR));
  assert.deepEqual(view.rank(rows, '完全无关的主题词').map((item) => item.record.id), []);
  const strict = view.rank(rows, '发布', { requireApplicable: true, context: ctxOf(null, {}) });
  assert.equal(strict.some((item) => item.record.id === 'mem_000000000002'), false);
  const known = view.rank(rows, '发布', { requireApplicable: true, context: ctxOf(null, { shell: 'zsh' }) });
  assert.equal(known.some((item) => item.record.id === 'mem_000000000002'), true);
});

test('触发词进检索与自动召回', () => {
  const record = {
    id: 'mem_000000000009',
    title: '对外链接处理',
    summary: '本地文件怎样进对话',
    tags: [],
    triggers: ['把视频贴给我'],
    when: '',
    applicability: 'all_in_scope',
    conditions: [],
    selection: null,
    lastUsed: '2026-03-01T00:00:00.000Z',
  };
  assert.ok(view.matchScore(record, '帮我把视频贴给我看看').score >= view.MATCH_FLOOR);
  assert.ok(view.matchScore(record, '完全无关的主题词').score < view.MATCH_FLOOR);
  /** 单字重合不算相关：「这」出现在「这个」里，不能让整句沾边就被召回。 */
  const unrelated = { id: 'mem_cccccccccccc', title: '以后都用这个一次性脚本', summary: '这个脚本只跑一次', when: '', aliases: [], tags: [], triggers: [], status: 'active' };
  assert.equal(view.matchScore(unrelated, '把这段视频的字幕导出来').score, 0);
  const ranked = view.rank([record], '帮我把视频贴给我看看', { limit: 4, context: ctxOf(null, {}) });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].record.id, record.id);
  const scope = fresh('trigger');
  const saved = store.upsert(scope, { title: '对外链接处理', summary: '本地文件怎样进对话', body: '看本地文件', triggers: ['把视频贴给我'] });
  const hits = store.search(scope, '帮我把视频贴给我看看');
  assert.equal(hits.some((item) => item.id === saved.record.id), true);
});

test('模型投影不含维护区、历史版本和旧名', () => {
  const record = {
    id: 'mem_000000000003',
    title: '发布前跑文案检查',
    summary: '发版前先跑 UI 文案检查',
    when: '发版前',
    kind: 'convention',
    revision: 4,
    scope: 'project',
    body: 'node ui-copy-lint.mjs',
    conditions: [],
    selection: null,
    links: [{ type: 'related', id: 'mem_000000000004' }],
    versions: [{ title: '旧名称-哨兵', body: '旧正文-哨兵' }],
    retiredNames: ['旧名称-哨兵'],
    sourceRefs: ['msg_哨兵'],
    receipts: [{ operationId: 'op_哨兵' }],
    checks: [{ note: '哨兵' }],
    hits: 42,
    merges: 3,
    lastUsed: '2026-01-01T00:00:00.000Z',
    reviewState: 'legacy_unreviewed',
  };
  for (const purpose of ['search', 'read', 'save']) {
    const text = JSON.stringify(view.toModelView(record, purpose, { status: 'ok' }));
    assert.equal(text.includes('哨兵'), false, `${purpose} 投影漏了维护区`);
    assert.equal(/versions|retiredNames|sourceRefs|receipts|checks|hits|merges|lastUsed/.test(text), false);
  }
  const links = view.toModelView(record, 'links', { links: [{ id: 'mem_000000000004', title: '相关的一条', revision: 2 }] });
  assert.equal(links.links[0].status, 'ok');
  assert.equal(view.projectionText(view.toModelView(record, 'read', { status: 'needs_context' })).includes('适用范围待确认'), true);
});

test('patch 保留没给的字段；空值显式清空；整份替换不继承旧值', () => {
  const scope = fresh('write');
  const first = store.upsert(scope, {
    title: '菜单里可以有「无糖」',
    summary: '这个菜单允许无糖选项',
    body: '主菜单允许无糖',
    when: '改菜单时',
    tags: ['菜单'],
    applicability: 'conditional',
    conditions: [{ key: 'pathPrefix', value: '/tmp/menu' }],
    selection: { mode: 'complete', artifactKey: 'menu:main', items: ['无糖'] },
  });
  assert.equal(first.record.title, '菜单里可以有「无糖」');
  assert.equal(first.record.applicability, 'conditional');
  const kept = store.upsert(scope, { id: first.record.id, body: '主菜单允许无糖，别处不管' });
  assert.equal(kept.record.title, '菜单里可以有「无糖」');
  assert.equal(kept.record.conditions.length, 1);
  const cleared = store.upsert(scope, { id: first.record.id, conditions: [], when: '', body: '' });
  assert.equal(cleared.record.conditions.length, 0);
  assert.equal(cleared.record.when, '');
  assert.equal(cleared.record.body, '');
  assert.throws(() => store.upsert(scope, { id: first.record.id, writeMode: 'replace_current', title: '换一条', summary: '整份替换', body: 'x' }), /整份替换要给出|不能用来新增/);
  const replaced = store.upsert(scope, {
    id: first.record.id,
    writeMode: 'replace_current',
    title: '全新的一条',
    summary: '整份替换后的内容',
    body: '新正文',
    when: '',
    kind: 'note',
    tags: [],
  });
  assert.equal(replaced.record.title, '全新的一条');
  assert.equal(replaced.record.applicability, 'all_in_scope');
  assert.equal(replaced.record.selection, null);
});

test('拒绝候选留抑制规则；被忘掉的来源不会再自动建议（D07）', () => {
  const scope = fresh('suppress');
  const gate = store.suggestionGate(scope, { title: '发布前跑文案检查', summary: '发版前先跑 lint' });
  assert.equal(gate.ok, true);
  const noted = store.noteSuggestion(scope, { title: '发布前跑文案检查', summary: '发版前先跑 lint', body: 'x' });
  const rejected = store.rejectCandidate(scope, noted.id);
  assert.equal(rejected.ok, true);
  const second = store.suggestionGate(scope, { title: '发布前跑文案检查', summary: '发版前先跑 lint' });
  assert.equal(second.ok, false);

  const saved = store.upsert(scope, { title: '要忘掉的一条', summary: '这条会被彻底忘掉', body: '旧正文-哨兵' });
  store.upsert(scope, { id: saved.record.id, summary: '这条会被彻底忘掉', body: '新正文-哨兵' });
  store.forget(scope, saved.record.id, { mode: 'purge' });
  assert.equal(store.loadIndex(scope).entries.some((item) => item.id === saved.record.id), false);
  const replay = store.suggestionGate(scope, { title: '要忘掉的一条', summary: '这条会被彻底忘掉' });
  assert.equal(replay.ok, false);
});

test('彻底忘掉后受管副本里搜不到旧内容（D06）', () => {
  const scope = fresh('hygiene');
  const saved = store.upsert(scope, { title: '要清掉的一条', summary: '会被彻底忘掉', body: '旧正文-哨兵' });
  store.upsert(scope, { id: saved.record.id, summary: '会被彻底忘掉', body: '第二版-哨兵' });
  store.upsert(scope, { title: '留下的一条', summary: '留着', body: '留下的正文' });
  store.forget(scope, saved.record.id, { mode: 'purge' });
  const leftovers = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (fs.readFileSync(full).includes('哨兵')) leftovers.push(full);
    }
  };
  walk(scope.dir);
  assert.deepEqual(leftovers, []);
  const remains = store.search(scope, '要清掉的一条');
  assert.equal(remains.some((item) => item.id === saved.record.id || item.title === '要清掉的一条'), false);
});

test('没指定归档还是彻底忘掉时不动盘（D05）', () => {
  const scope = fresh('undecided');
  const saved = store.upsert(scope, { title: '先别动', summary: '需要用户点明怎么处理', body: '正文' });
  const decision = store.forget(scope, saved.record.id);
  assert.equal(decision.mode, 'needs_resolution');
  assert.equal(store.readEntry(scope, saved.record.id).body, '正文');
  const archived = store.forget(scope, saved.record.id, { mode: 'archive' });
  assert.equal(archived.mode, 'archive');
  assert.equal(store.loadIndex(scope).entries.length, 0);
  assert.equal(store.loadIndex(scope).archived.some((item) => item.id === saved.record.id), true);
  const suggestedAgain = store.suggestionGate(scope, { title: '先别动', summary: '需要用户点明怎么处理' });
  assert.equal(suggestedAgain.ok, false);
  assert.match(suggestedAgain.reason, /忘掉/);
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`view.test.mjs: ${passed} passed`);
