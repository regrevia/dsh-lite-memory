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
  assert.equal(ctxOf(null, {}).targetOs, view.hostTargetOs());
  const hostRecord = { ...record, conditions: [{ key: 'targetOs', value: view.hostTargetOs() || 'macos' }] };
  assert.equal(view.evaluate(hostRecord, ctxOf(null, {})).state, 'match');
  const machineOnly = { ...record, conditions: [{ key: 'machine', value: '这台机器' }] };
  assert.equal(view.evaluate(machineOnly, ctxOf(null, {})).state, 'unknown');
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

const broadRule = {
  id: 'mem_000000000031',
  title: '前端页面默认采用细边框',
  summary: '页面卡片、按钮的边缘用细边框，不要大阴影',
  tags: [],
  triggers: [],
  when: '',
  applicability: 'conditional',
  conditions: [{ key: 'taskKind', value: 'code' }],
  selection: null,
  lastUsed: '2026-03-01T00:00:00.000Z',
};

test('粗分类条件只决定能不能用：编码类规则不因 taskKind=code 进无关任务', () => {
  const task = { kind: 'code' };
  const context = view.contextWithTask(ctxOf(null, {}), task);
  const hits = view.rank([broadRule], '编写 PostgreSQL 数据库连接池代码', { limit: 4, requireApplicable: true, context, task });
  assert.deepEqual(hits.map((item) => item.record.id), []);
  /** 任务绑定只看对象级条件：粗分类取值不算「这次就在说同一件事」。 */
  const bound = broadRule.conditions.some((row) => view.TASK_CONDITION_KEYS.includes(row.key) && !view.isBroadCondition(row));
  assert.equal(bound, false);
  assert.equal(view.isBroadCondition({ key: 'taskKind', value: 'code' }), true);
  assert.equal(view.isBroadCondition({ key: 'seriesId', value: '口播' }), false);
  /** 加分也不能来自粗分类：同一句话有字面命中时，score 不因 taskKind 匹配变高。 */
  const boosted = view.rank([broadRule], '前端页面的边框是不是太粗了', { limit: 4, context, task })[0];
  const plain = view.rank([broadRule], '前端页面的边框是不是太粗了', { limit: 4, context, task: {} })[0];
  assert.equal(boosted.score, plain.score);
  /** 适用性判断照旧：条件对不上照样不通过。 */
  assert.equal(view.eligibility(broadRule, { context: {}, task: { kind: 'video' } }, 'auto', Date.now()).status, 'not_applicable');
  assert.equal(view.eligibility(broadRule, { context: {}, task: { kind: 'code' } }, 'auto', Date.now()).status, 'ok');
});

test('请求点到规则说的对象时，同样的规则照样召回', () => {
  const task = { kind: 'code' };
  const context = view.contextWithTask(ctxOf(null, {}), task);
  const hits = view.rank([broadRule], '前端页面的边框是不是太粗了', { limit: 4, requireApplicable: true, context, task });
  assert.deepEqual(hits.map((item) => item.record.id), [broadRule.id]);
  /** 只说「代码」不带对象时不算命中：粗分类词不能把规则捞上来。 */
  const vague = view.rank([broadRule], '把这段代码收个尾', { limit: 4, requireApplicable: true, context, task });
  assert.deepEqual(vague.map((item) => item.record.id), []);
});

test('对象级绑定仍然算相关：同系列/同产物的规则排前面', () => {
  const base = { tags: [], triggers: [], when: '', applicability: 'conditional', selection: null };
  const bound = { ...base, id: 'mem_000000000041', title: '口播这期开头先给结论', summary: '开头三句内给结论', conditions: [{ key: 'seriesId', value: '口播' }], lastUsed: '2026-01-01T00:00:00.000Z' };
  const loose = { ...base, id: 'mem_000000000042', title: '口播这期开头先给结论', summary: '开头三句内给结论', conditions: [], lastUsed: '2026-02-01T00:00:00.000Z' };
  const query = '口播这期开头先给结论';
  const cold = view.rank([bound, loose], query, { limit: 2, context: ctxOf(null, {}) });
  assert.equal(cold[0].record.id, loose.id);
  const task = { seriesId: '口播' };
  const warm = view.rank([bound, loose], query, { limit: 2, context: view.contextWithTask(ctxOf(null, {}), task), task });
  assert.equal(warm[0].record.id, bound.id);
  const artifact = { ...base, id: 'mem_000000000043', title: '连接池大小', summary: '按并发调', conditions: [{ key: 'artifactKey', value: 'src/api/pool.js' }] };
  assert.deepEqual(view.objectBindingsOf(artifact).map((row) => row.key), ['artifactKey']);
  assert.deepEqual(view.objectBindingsOf(broadRule), []);
});

test('预算内选组合：件数优先，跳过单条过大的候选换更小的一条', () => {
  const items = [{ id: 'a', n: 50 }, { id: 'b', n: 50 }, { id: 'c', n: 10 }, { id: 'd', n: 10 }];
  const sizeOf = (item) => item.n;
  const picked = view.selectContextBundle(items, { maxItems: 3, maxBytes: 100, sizeOf });
  assert.deepEqual(picked.items.map((item) => item.id), ['a', 'c', 'd']);
  assert.equal(picked.bytes, 70);
  assert.deepEqual(picked.omitted, [1]);
});

test('预算内选组合：单条就超预算时交空，不塞弱相关候选', () => {
  const huge = [{ id: 'big', n: 500 }];
  const none = view.selectContextBundle(huge, { maxItems: 3, maxBytes: 100, sizeOf: (item) => item.n });
  assert.deepEqual(none.items, []);
  assert.equal(none.bytes, 0);
  const empty = view.selectContextBundle([], {});
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.omitted, []);
});

test('预算内选组合：没预算也不硬凑件数，最多只看到 12 条', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, n: 5 }));
  const picked = view.selectContextBundle(many, { maxItems: 3, maxBytes: 12, sizeOf: (item) => item.n });
  assert.equal(picked.items.length, 2);
  assert.deepEqual(picked.items.map((item) => item.id), ['m0', 'm1']);
  assert.equal(picked.omitted.length, 10);
});

test('融合倒数排名：同一路里并列同分不被 id 顺序拆开', () => {
  const rows = view.fuseRoutes([[{ id: 'a', rank: 1 }, { id: 'b', rank: 1 }], ['a', 'c']], { k: 60 });
  const byId = new Map(rows.map((row) => [row.id, row.score]));
  assert.ok(Math.abs(byId.get('a') - 2 / 61) < 1e-12);
  assert.ok(Math.abs(byId.get('b') - 1 / 61) < 1e-12);
  assert.ok(byId.get('b') > byId.get('c'));
  assert.ok(byId.get('a') > byId.get('c'));
});

test('融合倒数排名：被第二条独立路径命中的条目反超只靠字面命中的条目', () => {
  const base = { tags: [], triggers: [], when: '', applicability: 'conditional', selection: null, conditions: [] };
  const strong = { ...base, scope: 'project', id: 'mem_000000000051', title: '样式统一用变量', summary: '样式统一用变量，别写死颜色', lastUsed: '2026-01-01T00:00:00.000Z', links: [{ id: 'mem_000000000052' }] };
  const linked = { ...base, scope: 'global', id: 'mem_000000000052', title: '颜色改一次全站生效', summary: '样式统一用变量的收益', lastUsed: '2026-01-01T00:00:00.000Z' };
  const plain = { ...base, scope: 'project', id: 'mem_000000000053', title: '按钮圆角', summary: '样式统一用变量的例外', lastUsed: '2026-03-01T00:00:00.000Z' };
  const rows = view.rank([strong, linked, plain], '样式统一用变量', { limit: 3, context: ctxOf(null, {}) });
  const ids = rows.map((row) => row.record.id);
  assert.equal(ids[0], strong.id);
  const linkedRow = rows.find((row) => row.record.id === linked.id);
  const plainRow = rows.find((row) => row.record.id === plain.id);
  assert.ok(linkedRow && plainRow);
  assert.equal(linkedRow.raw, plainRow.raw);
  assert.ok(ids.indexOf(linked.id) < ids.indexOf(plain.id));
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`view.test.mjs: ${passed} passed`);
