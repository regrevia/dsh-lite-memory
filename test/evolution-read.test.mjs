import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-evolution-read-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');
const state = await import('../state.js');
const anchor = await import('../anchor.js');

const effect = (fn) => {
  const dispose = fn();
  return typeof dispose === 'function' ? dispose : () => {};
};

function boot(mode = 'adaptive') {
  const defs = new Map();
  const handlers = new Map();
  const promptContexts = [];
  const ctx = {
    tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
    effect,
    inject: () => () => {},
    get: (name) => (name === 'systemPrompt'
      ? { context: (entry) => { promptContexts.push(entry); return () => {}; } }
      : name === 'agents' ? { currentInitiator: () => null } : undefined),
    on: (event, handler) => {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  };
  apply(ctx, { mode });
  const provider = promptContexts.find((entry) => entry.name === 'lite-memory:recall');
  assert.ok(provider, 'recall provider registered');
  /* CI 冷启动偶尔超过召回耗时上限，逻辑断言不该被「这轮先不注入」判失败。 */
  globalThis.__liteMemoryRecall?.setDeadlineMs?.(5000);
  const exec = (name, args, agent) => defs.get(name).execute(args, { agent });
  const preStep = (payload, decision) => handlers.get('agent/pre-step').at(-1)(payload, async () => decision);
  const text = (agent, signal) => provider.text({ agent, signal });
  return { defs, handlers, provider, exec, preStep, text, debug: globalThis.__liteMemoryRecall };
}

const signal = () => new AbortController().signal;
let seq = 0;
const human = (body) => {
  seq += 1;
  return { role: 'user', id: `msg-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text: body }] };
};
const enter = (...messages) => ({ kind: 'enter', messages });
const mkdir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `lite-memory-evolution-${label}-`));
const makeAgent = (id, dir) => ({ id, cwd: dir, session: { id: `session-${id}`, header: { cwd: dir } } });

const save = (scope, fields) => {
  const result = store.upsert(scope, {
    applicability: 'all_in_scope',
    body: `正文：${fields.title}`,
    resolution: 'distinct',
    ...fields,
    summary: fields.summary ?? `${fields.title}的摘要`,
  });
  return { ...result, id: result.record?.id ?? result.id };
};

/** 直接种一条实验来源条目，绕开 PR4 的整理入口。 */
function seedRule(scope, { title, body, summary, conditions = [], learning = { state: 'active', specDigest: 'seeded' }, topicKey, tags = [] }) {
  const saved = save(scope, { title, body, summary, tags });
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === saved.id);
    row.origin = 'project_evolution';
    row.current.conditions = conditions;
    row.maintenance.learning = { ...learning };
    if (topicKey) row.topicKey = topicKey;
    return { changed: true };
  });
  return saved.id;
}

const enable = (scope, defaults) => {
  const turned = store.setEvolution(scope, true, { operationId: `op-on-${Math.random().toString(16).slice(2)}` });
  assert.equal(turned.ok, true, turned.reason);
  assert.equal(turned.enabled, true);
  if (defaults) {
    const applied = store.setTaskDefault(scope, defaults);
    assert.equal(applied.ok, true, applied.reason);
  }
  return turned;
};

const scopeOf = (dir) => store.scopeOf(dir);

/* L01：默认关闭时，自动读取与普通召回完全不动。 */
{
  const dir = mkdir('off');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  const runtime = boot();
  const agent = makeAgent('a-off', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期口播开头怎么改')));
  assert.equal(runtime.text(agent, sig), '');
  assert.equal(runtime.debug.windowOf(agent).experiment, null);
}

/* L02：开关打开但没有任何栏目，不注入任何领域问题，也不给空上下文。 */
{
  const dir = mkdir('clarify');
  const scope = scopeOf(dir);
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-clarify', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期怎么开头')));
  const text = runtime.text(agent, sig);
  assert.equal(text, '');
  assert.doesNotMatch(text, /栏目|Vlog|口播|视频/);
  const experiment = runtime.debug.windowOf(agent).experiment;
  assert.equal(experiment ? experiment.injectedIds.length : 0, 0);
}

/* L03：未绑定任务只给栏目索引，不超过三条；短规则不进正文。 */
{
  const dir = mkdir('index');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播视频' }] });
  seedRule(scope, { title: '口播收尾', body: '结尾只留一个行动。', conditions: [{ key: 'seriesId', value: '口播视频' }] });
  seedRule(scope, { title: 'Vlog 节奏', body: '每段不超过二十秒。', conditions: [{ key: 'seriesId', value: 'Vlog' }] });
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-index', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('视频开头怎么改')));
  const text = runtime.text(agent, sig);
  assert.match(text, /这些记忆范围可能适用/);
  assert.doesNotMatch(text, /Vlog/);
  assert.doesNotMatch(text, /开场三句内给结论/);
  const listed = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(listed.length <= 3, true);
  assert.equal(Buffer.byteLength(text) <= 600 + 160, true, 'index stays small');
}

/* L03b：项目有视频栏目，本轮是修代码：无关栏目与选择提示都不进上下文。 */
{
  const dir = mkdir('index-unrelated');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  seedRule(scope, { title: 'Vlog 节奏', body: '每段不超过二十秒。', conditions: [{ key: 'seriesId', value: 'Vlog' }] });
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-index-unrelated', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('修一下 dsh-unlag 的重新载入问题')));
  const injected = runtime.text(agent, sig);
  assert.equal(injected, '');
  const experiment = runtime.debug.windowOf(agent).experiment;
  assert.equal(experiment ? experiment.injectedIds.length : 0, 0);
}

/* L04：项目默认绑定后给规则正文，带 id 与版本。 */
{
  const dir = mkdir('default');
  const scope = scopeOf(dir);
  const id = seedRule(scope, { title: '默认口播开头', body: '先给结论再解释。', conditions: [{ key: 'seriesId', value: '口播' }, { key: 'taskKind', value: 'video' }] });
  enable(scope, { taskKind: 'video', seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-default', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期开头怎么改')));
  const text = runtime.text(agent, sig);
  assert.match(text, /项目实验规则/);
  assert.match(text, /先给结论再解释/);
  assert.ok(!text.includes(id), '实验规则也只给标题，不给内部编号');
  assert.doesNotMatch(text, /第 .* 版/);
}

/* L05：长规则只给用途与 memory_read 指针，不把正文塞进上下文。 */
{
  const dir = mkdir('long');
  const scope = scopeOf(dir);
  const longBody = `完整流程：${'先做这一步再检查，'.repeat(30)}`;
  const id = seedRule(scope, { title: '长流程口播', body: longBody, summary: '完整流程按顺序做', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-long', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期口播怎么做')));
  const text = runtime.text(agent, sig);
  assert.ok(!text.includes(id), '实验规则也只给标题，不给内部编号');
  assert.match(text, /memory_read/);
  assert.equal(text.includes('先做这一步再检查'), false);
  assert.equal(Buffer.byteLength(text) <= 1200 + 200, true);
}

/* L06：道谢不注入规则，只留一个可续的指针。 */
{
  const dir = mkdir('thanks');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-thanks', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('谢谢！')));
  const text = runtime.text(agent, sig);
  assert.equal(text.includes('开场三句内给结论'), false);
}

/* L07：再做一期是新的一集，继承栏目与风格，不继承旧主题。 */
{
  const dir = mkdir('continue');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '风格规则', body: '口播全程用短句。', conditions: [{ key: 'seriesId', value: '口播' }, { key: 'phase', value: 'brief' }] });
  seedRule(scope, { title: '本期主题', body: '这一期讲春季收纳。', conditions: [{ key: 'seriesId', value: '口播' }, { key: 'phase', value: 'theme' }] });
  enable(scope, { seriesId: '口播' });
  const selected = anchor.applySelection(store.taskState(scope), {
    sessionId: 'session-a-continue',
    selection: { seriesId: '口播', phase: 'theme' },
    batchKey: anchor.requestBatchKey(['seed-theme']),
    messageIds: ['seed-theme'],
  });
  const seededEpisode = selected.tasks.episodes[selected.episode.episodeId];
  seededEpisode.status = 'active';
  selected.tasks.sessions['session-a-continue'].status = 'active';
  assert.equal(store.saveTaskState(scope, selected.tasks, { operationId: 'op-seed-theme' }).ok, true);
  const runtime = boot();
  const agent = makeAgent('a-continue', dir);
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 't1' }, enter(human('这期讲春季收纳')));
  assert.match(runtime.text(agent, first), /这一期讲春季收纳/);
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 't2' }, enter(human('再做一期')));
  const text = runtime.text(agent, second);
  assert.match(text, /口播全程用短句/);
  assert.equal(text.includes('这一期讲春季收纳'), false);
}

/* L08：改一版沿用同一集，不新建集。 */
{
  const dir = mkdir('revision');
  const scope = scopeOf(dir);
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-revision', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期口播开头快点')));
  const before = store.taskState(scope).episodes;
  const beforeIds = Object.keys(before);
  await runtime.preStep({ agent, signal: signal(), turn: 't2' }, enter(human('再改一下开头')));
  const after = store.taskState(scope).episodes;
  assert.deepEqual(Object.keys(after).sort(), beforeIds.sort());
  assert.equal(Object.values(after)[0].status, 'continuable');
}

/* L09：改做别的类型不把视频规则带过去。 */
{
  const dir = mkdir('switch');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-switch', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期口播开头')));
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't2' }, enter(human('改做 README 文案')));
  const text = runtime.text(agent, sig);
  assert.equal(text.includes('开场三句内给结论'), false);
  const current = Object.values(store.taskState(scope).episodes).find((episode) => episode.status === 'unbound');
  assert.ok(current, 'switch leaves an unbound episode');
}

/* L09b：明确改为排查数据库后，旧视频规则和栏目提示都不再注入。 */
{
  const dir = mkdir('switch-db');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-switch-db', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期口播开头')));
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't2' }, enter(human('这期不做了，改为排查 PostgreSQL 慢查询')));
  const text = runtime.text(agent, sig);
  assert.equal(text.includes('开场三句内给结论'), false);
  assert.equal(/栏目|点名/.test(text), false);
}

/* L10：没有本请求上下文时，普通检索看不到实验来源。 */
{
  const dir = mkdir('nocx');
  const scope = scopeOf(dir);
  const id = seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-nocx', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期口播开头')));
  const value = await runtime.exec('memory_search', { query: '口播开头' }, agent);
  assert.equal((value.refs || []).some((ref) => ref.id === id), false);
}

/* L11：真人原话点名栏目就直接生效；工具绑定仍只认这句原话。 */
{
  const dir = mkdir('bind');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-bind', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期口播怎么开头')));
  const held = runtime.debug.windowOf(agent).experiment;
  assert.ok(held && held.contextId, 'context leaked');
  const value = await runtime.exec('memory_search', { query: '口播', contextId: held.contextId, bindForRequest: true }, agent);
  assert.equal(value.status, 'ok');
  assert.ok((value.text || '').includes('口播'));
  const episodes = Object.values(store.taskState(scope).episodes);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].status, 'active');
  assert.match(runtime.text(agent, sig), /开场三句内给结论/);
}

/* L11b：模型自己写 query 不能建绑定；只认本轮真人原话。 */
{
  const dir = mkdir('bind-model');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-bind-model', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期怎么开头')));
  const held = runtime.debug.windowOf(agent).experiment;
  const value = await runtime.exec('memory_search', { query: '口播', contextId: held.contextId, bindForRequest: true }, agent);
  assert.equal(value.status, 'needs_context');
  assert.equal((value.text || '').includes('口播'), false);
  assert.equal((value.text || '').includes('开场三句内给结论'), false);
  const episodes = Object.values(store.taskState(scope).episodes);
  assert.equal(episodes.some((episode) => episode.status === 'proposed'), false);
  assert.equal(runtime.text(agent, sig).includes('开场三句内给结论'), false);
}

/* L12：跨项目上下文直接拒绝。 */
{
  const dirA = mkdir('cross-a');
  const dirB = mkdir('cross-b');
  const scopeA = scopeOf(dirA);
  seedRule(scopeA, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scopeA);
  const runtime = boot();
  const agentA = makeAgent('a-cross-a', dirA);
  await runtime.preStep({ agent: agentA, signal: signal(), turn: 't1' }, enter(human('这期怎么开头')));
  const held = runtime.debug.windowOf(agentA).experiment;
  const agentB = makeAgent('a-cross-b', dirB);
  const value = await runtime.exec('memory_search', { query: '口播', contextId: held.contextId }, agentB);
  assert.equal(value.status, 'needs_context');
  assert.match(value.text, /另一个项目/);
}

/* L13：跨请求复用旧上下文算过期。 */
{
  const dir = mkdir('stale');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-stale', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期怎么开头')));
  const old = runtime.debug.windowOf(agent).experiment.contextId;
  await runtime.preStep({ agent, signal: signal(), turn: 't2' }, enter(human('再问一次')));
  const value = await runtime.exec('memory_search', { query: '口播', contextId: old }, agent);
  assert.equal(value.status, 'needs_context');
}

/* L14：绑定必须带 contextId，不能凭空绑。 */
{
  const dir = mkdir('bind-missing');
  const scope = scopeOf(dir);
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-bind-missing', dir);
  const value = await runtime.exec('memory_search', { query: '口播', bindForRequest: true }, agent);
  assert.equal(value.status, 'needs_context');
}

/* L15：暂停的实验条目即使有上下文也不给正文。 */
{
  const dir = mkdir('paused');
  const scope = scopeOf(dir);
  const id = seedRule(scope, {
    title: '暂停口播规则',
    body: '这条已经暂停，不该给正文。',
    conditions: [{ key: 'seriesId', value: '口播' }],
    learning: { state: 'paused', blockedReason: 'needs_revalidation', specDigest: 'seeded' },
  });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-paused', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期口播怎么做')));
  const held = runtime.debug.windowOf(agent).experiment;
  assert.ok(held);
  const value = await runtime.exec('memory_read', { id, contextId: held.contextId }, agent);
  assert.equal(value.status, 'needs_context');
  assert.equal(value.body, '');
}

/* L16：工具模式不自动注入，窗口仍然开。 */
{
  const dir = mkdir('tool-only');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope, { seriesId: '口播' });
  const runtime = boot('tool_only');
  const agent = makeAgent('a-tool-only', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期口播开头')));
  assert.equal(runtime.text(agent, signal()), '');
}

/* L16b：工具模式下前台点名栏目可按需绑定，仍然不自动注入。 */
{
  const dir = mkdir('tool-only-bind');
  const scope = scopeOf(dir);
  const id = seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope, { seriesId: '口播' });
  const runtime = boot('tool_only');
  const agent = makeAgent('a-tool-only-bind', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期口播开头')));
  const value = await runtime.exec('memory_search', { query: '口播开头', bindForRequest: true }, agent);
  assert.equal(value.status, 'ok');
  assert.equal((value.refs || []).some((ref) => ref.title === '口播开头'), true);
  const episodes = Object.values(store.taskState(scope).episodes);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].status, 'proposed');
}

/* L17：固定规则照常召回，实验规则不混进普通自动召回。 */
{
  const dir = mkdir('fixed');
  const scope = scopeOf(dir);
  save(scope, { title: '固定发布检查', body: '发版前跑一遍检查。', tags: ['发布'] });
  seedRule(scope, { title: '实验发布检查', body: '实验规则：发版前先备份。', tags: ['发布'], learning: { state: 'active', specDigest: 'seeded' } });
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-fixed', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('发版前检查什么')));
  const text = runtime.text(agent, sig);
  assert.match(text, /固定发布检查/);
  assert.equal(text.includes('实验规则：发版前先备份'), false);
}

/* L18：工具绑定零命中/多命中时只回一句读取状态，不要求用户点名栏目。 */
{
  const dir = mkdir('bind-none');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  seedRule(scope, { title: 'Vlog 节奏', body: '每段不超过二十秒。', conditions: [{ key: 'seriesId', value: 'Vlog' }] });
  enable(scope);
  const runtime = boot();
  const agent = makeAgent('a-bind-none', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期怎么开头')));
  const held = runtime.debug.windowOf(agent).experiment;
  const none = await runtime.exec('memory_search', { query: '修一下构建脚本', contextId: held.contextId, bindForRequest: true }, agent);
  assert.equal(none.status, 'needs_context');
  assert.doesNotMatch(none.text, /点名|先问|栏目/);
  const many = await runtime.exec('memory_search', { query: '口播和 Vlog 都要', contextId: held.contextId, bindForRequest: true }, agent);
  assert.equal(many.status, 'needs_context');
  assert.doesNotMatch(many.text, /点名|先问|栏目/);
}

/* L19：试用到期后不再自动注入，和检索、读取用同一档可用性。 */
{
  const dir = mkdir('trial-expired');
  const scope = scopeOf(dir);
  const id = seedRule(scope, {
    title: '过期口播规则',
    body: '这条试用已经到期，不该自动出现。',
    conditions: [{ key: 'seriesId', value: '口播' }],
    learning: { state: 'trial', specDigest: 'seeded', trialUntil: new Date(Date.now() - 60_000).toISOString() },
  });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-trial-expired', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期口播怎么做')));
  const text = runtime.text(agent, sig);
  assert.equal(text.includes('这条试用已经到期，不该自动出现。'), false);
  const held = runtime.debug.windowOf(agent).experiment;
  assert.deepEqual(held ? held.injectedIds : [], []);
}

/* L19b：准备时还在试用期、请求中途到期，同一请求也不能再输出正文。 */
{
  const dir = mkdir('trial-expiring');
  const scope = scopeOf(dir);
  seedRule(scope, {
    title: '快到期口播规则',
    body: '这条试用马上到期，过期后同一请求也不能再出现。',
    conditions: [{ key: 'seriesId', value: '口播' }],
    learning: { state: 'trial', specDigest: 'seeded', trialUntil: new Date(Date.now() + 700).toISOString() },
  });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-trial-expiring', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期口播怎么做')));
  assert.match(runtime.text(agent, sig), /马上到期/);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(runtime.text(agent, sig), '');
}

/* L19c：一条试用到期只撤这一条，不把同请求里其他可用规则一起清掉。 */
{
  const dir = mkdir('trial-parts');
  const scope = scopeOf(dir);
  seedRule(scope, {
    title: '快到期的主题规则',
    body: '这条试用马上到期。',
    conditions: [{ key: 'seriesId', value: '口播' }],
    learning: { state: 'trial', specDigest: 'seeded', trialUntil: new Date(Date.now() + 700).toISOString() },
    topicKey: 'theme',
  });
  seedRule(scope, {
    title: '长期口播开头',
    body: '开场三句内给结论。',
    conditions: [{ key: 'seriesId', value: '口播' }],
    learning: { state: 'active', specDigest: 'seeded' },
    topicKey: 'opening',
  });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-trial-parts', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期口播怎么做')));
  const first = runtime.text(agent, sig);
  assert.match(first, /快到期的主题规则/);
  assert.match(first, /长期口播开头/);
  await new Promise((resolve) => setTimeout(resolve, 900));
  const later = runtime.text(agent, sig);
  assert.doesNotMatch(later, /快到期的主题规则/);
  assert.match(later, /长期口播开头/, '无关的试用到期不该清掉别的规则');
}

/* L20：自进化关掉后，已经准备好的实验正文立刻不再输出；重开也不复活。 */
{
  const dir = mkdir('off-after-prepare');
  const scope = scopeOf(dir);
  seedRule(scope, { title: '口播开头', body: '开场三句内给结论。', conditions: [{ key: 'seriesId', value: '口播' }] });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-off-after-prepare', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期口播怎么做')));
  assert.match(runtime.text(agent, sig), /开场三句内给结论/);
  assert.equal(store.setEvolution(scope, false, { operationId: 'evo-off-after-prepare' }).ok, true);
  assert.equal(runtime.text(agent, sig), '');
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-on-again' }).ok, true);
  assert.equal(runtime.text(agent, sig), '');
}

/* L21：检索没有可用命中、但有条件未确认的候选时，只说状态，不把标题递给模型。 */
{
  const dir = mkdir('search-withheld');
  const scope = scopeOf(dir);
  save(scope, {
    title: '发布前检查清单',
    body: '按清单逐项确认。',
    summary: '发布前逐项确认',
    applicability: 'unresolved',
  });
  const runtime = boot();
  const agent = makeAgent('a-search-withheld', dir);
  const value = await runtime.exec('memory_search', { query: '发布前检查' }, agent);
  assert.equal(value.count, 0);
  assert.equal(value.status, 'needs_context');
  assert.equal(value.reasonCode, 'applicability_unresolved');
  assert.equal(value.text.includes('发布前检查清单'), false);
  assert.match(value.text, /适用条件还没确认/);
}

/* L22：自动续写轮没有新的真人消息，仍沿用本会话上一次的请求上下文读正文。 */
{
  const dir = mkdir('continuation');
  const scope = scopeOf(dir);
  const saved = save(scope, { title: '口播发布清单', body: '按清单逐项确认。' });
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === saved.id);
    row.current.conditions = [{ key: 'seriesId', value: '口播' }];
    return { changed: true };
  });
  enable(scope, { seriesId: '口播' });
  const runtime = boot();
  const agent = makeAgent('a-continuation', dir);
  await runtime.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('这期口播怎么做')));
  const first = await runtime.exec('memory_read', { id: saved.id }, agent);
  await runtime.preStep({ agent, signal: signal(), turn: 't2' }, enter());
  assert.equal(first.status, 'ok');
  assert.match(first.body, /按清单逐项确认/);
  const second = await runtime.exec('memory_read', { id: saved.id }, agent);
  assert.equal(second.status, 'ok');
  assert.equal(second.repeat, true);
}

console.log('evolution-read.test.mjs: all passed');
