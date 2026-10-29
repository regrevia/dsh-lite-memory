import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-recall-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');

const HEADER = '已有记忆可能相关';
const CARD_LINE = /^- \[[^\]]+\] 「.+?」(?:｜.*)?$/;
const CARD_LINE_M = new RegExp(CARD_LINE.source, 'm');
const INTERNAL_ID = /mem_[a-z0-9]{6,}/;

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
  const debug = globalThis.__liteMemoryRecall;
  const provider = promptContexts.find((entry) => entry.name === 'lite-memory:recall');
  /* CI 冷启动偶尔超过召回耗时上限，逻辑断言不该被「这轮先不注入」判失败。 */
  globalThis.__liteMemoryRecall?.setDeadlineMs?.(5000);
  assert.ok(provider, 'recall provider registered');
  assert.equal(provider.order, 60);
  assert.equal(provider.interpolate, false);
  assert.equal(provider.required, false);
  const exec = (name, args, agent) => defs.get(name).execute(args, { agent });
  const render = (name, args, value) => defs.get(name).output.render(args, value)[0].text;
  const preStep = (payload, decision) => {
    const handler = handlers.get('agent/pre-step').at(-1);
    return handler(payload, async () => decision);
  };
  return { defs, handlers, provider, exec, render, preStep, debug };
}

const signal = () => new AbortController().signal;

let messageSeq = 0;
function human(body, options = {}) {
  messageSeq += 1;
  return {
    role: 'user',
    id: options.id ?? `msg-${messageSeq}`,
    source: { kind: 'user' },
    content: [{ type: 'text', text: body }],
  };
}
const synthetic = (kind, body) => ({
  role: 'user', id: `synth-${(messageSeq += 1)}`, source: { kind }, content: [{ type: 'text', text: body }],
});
const enter = (...messages) => ({ kind: 'enter', messages });
const prepare = async (runtime, agent, query, turn = 't1') => {
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn }, enter(human(query)));
  return sig;
};

const mkdir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `lite-memory-recall-${label}-`));
const makeAgent = (id, dir) => ({ id, cwd: dir, session: { id: `session-${id}`, header: { cwd: dir } } });
const save = (scope, fields) => {
  const result = store.upsert(scope, {
    applicability: 'all_in_scope',
    body: `正文：${fields.title}`,
    summary: fields.summary ?? `${fields.title}的摘要`,
    ...fields,
  });
  return { ...result, id: result.record?.id ?? result.id };
};

/** 有效期这类时间不能靠等待制造：直接改热状态，并同步重算校验和。 */
const patchState = (scope, id, patch) => {
  const file = path.join(scope.dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = raw.payload.entries.find((row) => row.id === id);
  assert.ok(entry, `state 里没有 ${id}`);
  for (const [key, value] of Object.entries(patch)) {
    entry[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(entry[key] || {}), ...value } : value;
  }
  raw.checksum = `sha256:${crypto.createHash('sha256').update(JSON.stringify(raw.payload)).digest('hex')}`;
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
};

const cwdA = mkdir('a');
const scopeA = store.scopeOf(cwdA);
const global = store.globalScope();

const hotReload = save(scopeA, { title: '插件改完先试热刷新', tags: ['插件', '热刷新'], summary: '改完先热刷新，覆盖不到再选生效方式' });
const installPath = save(scopeA, { title: '插件安装位置', tags: ['插件', '安装'], summary: '装上后文件落在用户目录的插件包里' });
const crash = save(scopeA, { title: '插件刷新崩溃排查', tags: ['插件', '崩溃'], summary: '先看日志末尾有没有 reload 行' });
const publish = save(scopeA, { title: '发布前跑文案检查', tags: ['发布'], summary: '交付前把界面文案过一遍 lint' });
const unrelated = save(scopeA, { title: '本地视频侧边栏播放', tags: ['视频'], summary: '本地文件也要能在侧边栏播' });
const linuxOnly = save(scopeA, {
  title: '插件在 Linux CI 里构建',
  tags: ['插件', '构建'],
  when: '',
  applicability: 'conditional',
  conditions: [{ key: 'machine', value: '别的机器' }],
  summary: '只在另一台机器上跑构建检查',
});
const unresolved = save(scopeA, { title: '发布前要检查什么', tags: ['发布', '检查'], when: '发布前', applicability: 'unresolved' });
const globalHot = save(global, { title: '插件改动后先热刷新', tags: ['插件', '热刷新'], summary: '全局规矩：先热刷新再谈重启' });

/** 预算用：6 条都命中「发布」，单卡够大，只能装下少数几张。 */
const longEntries = [];
const longParts = ['文案', '图标', '包体', '权限', '链接', '版本'];
for (let i = 0; i < 6; i += 1) {
  longEntries.push(save(scopeA, {
    title: `发布流程${longParts[i]}检查${'长'.repeat(35)}`,
    summary: `这一步的说明比较长，${'细'.repeat(50)}`,
    tags: ['发布', longParts[i]],
    resolution: 'distinct',
  }));
}
const bigBodies = [];
for (let i = 0; i < 9; i += 1) {
  bigBodies.push(save(scopeA, {
    title: `大正文样本${i + 1}`,
    summary: '读取预算测试',
    tags: ['大正文'],
    resolution: 'distinct',
    body: `样本${i + 1}：${'正文内容'.repeat(80)}`,
  }));
}

const bootA = boot('adaptive');

// A01/A02：真人的第一句请求先准备，准备好之前 provider 是空的。
const agentA = makeAgent('agent-a', cwdA);
const signalA = signal();
assert.equal(bootA.provider.text({ agent: agentA, signal: signalA }), '');
const decisionA = enter(human('插件改完怎么让它生效？'));
await bootA.preStep({ agent: agentA, signal: signalA, turn: 't1' }, decisionA);
const preparedText = bootA.provider.text({ agent: agentA, signal: signalA });
assert.ok(preparedText.startsWith(HEADER), 'recall text starts with header');
assert.match(preparedText, /插件改完先试热刷新/);
assert.match(preparedText, CARD_LINE_M);
assert.ok(Buffer.byteLength(preparedText) <= 1200, 'snapshot stays inside card budget');
const cards = bootA.provider.text({ agent: agentA, signal: signalA }).split('\n').slice(1);
assert.ok(cards.length <= 3);
for (const line of cards) assert.match(line, CARD_LINE);
assert.doesNotMatch(preparedText, /第 .* 版/);
assert.equal(bootA.provider.text({ agent: agentA, signal: signalA }), preparedText, 'frozen between calls');
/** 到期在输出前复核：投影之后过期的那条不再发给模型。 */
const expiring = bootA.debug.preparedOf(agentA);
assert.ok(expiring.lines.length >= 1, 'prepared cards carry their own deadline');
const firstLine = expiring.lines[0].line;
expiring.lines[0].validUntil = new Date(Date.now() - 1000).toISOString();
const afterExpiry = bootA.provider.text({ agent: agentA, signal: signalA });
assert.ok(!afterExpiry.includes(firstLine), 'expired card withheld at emit');
assert.match(afterExpiry, /^已有记忆可能相关/);
expiring.lines[0].validUntil = '';
assert.equal(bootA.provider.text({ agent: agentA, signal: signalA }), preparedText, 'unexpired card still delivered');

// A02b：同一会话里只说「继续」时沿用上一句的查询，短追问也能接上刚才那条记忆。
const contAgent = makeAgent('agent-cont', cwdA);
const contSignal = signal();
await bootA.preStep({ agent: contAgent, signal: contSignal, turn: 'c1' }, enter(human('发布前文案检查要怎么过？')));
const contFirst = bootA.debug.preparedOf(contAgent);
assert.ok(contFirst && contFirst.cards.length, 'first turn recalls the publish rule');
assert.match(contFirst.query, /发布前文案检查/);
const contSignal2 = signal();
await bootA.preStep({ agent: contAgent, signal: contSignal2, turn: 'c2' }, enter(human('继续')));
const contNext = bootA.debug.preparedOf(contAgent);
assert.ok(contNext, 'short continuation still prepares a snapshot');
assert.match(contNext.query, /^继续 /);
assert.match(contNext.query, /发布前文案检查/, 'continuation carries the previous query');
assert.ok(contNext.cards.length, 'continuation still resolves cards');
assert.ok(contNext.cards.some((card) => /文案检查/.test(card.title || card.line || '')), 'same topic comes back');

// A03：provider 纯内存，不写盘、不动 hits。
const statePath = path.join(scopeA.dir, 'state.json');
const before = fs.readFileSync(statePath);
for (let i = 0; i < 20; i += 1) bootA.provider.text({ agent: agentA, signal: signalA });
assert.deepEqual(fs.readFileSync(statePath), before);
const storedHits = store.loadIndex(scopeA).entries.reduce((sum, item) => sum + (item.hits || 0), 0);
assert.equal(storedHits, 0);

// A04：不同 Agent/会话各自准备，不串卡片。
const cwdB = mkdir('b');
const scopeB = store.scopeOf(cwdB);
const video = save(scopeB, { title: '本地视频在侧边栏播放', tags: ['视频', '播放'], summary: '不受会话目录限制' });
const agentB = makeAgent('agent-b', cwdB);
const signalB = signal();
await bootA.preStep({ agent: agentB, signal: signalB, turn: 't1' }, enter(human('本地视频在侧边栏怎么播放？')));
const textB = bootA.provider.text({ agent: agentB, signal: signalB });
assert.match(textB, new RegExp(video.title));
assert.doesNotMatch(textB, /插件改完先试热刷新/);
assert.equal(bootA.provider.text({ agent: agentA, signal: signalA }), preparedText, 'agent A untouched');
assert.notEqual(bootA.provider.text({ agent: agentB, signal: signalB }), preparedText);

// A05：取消/超时/迟到结果都不能覆盖新请求。
{
  const agent = makeAgent('agent-abort', cwdA);
  const ctrl = new AbortController();
  await bootA.preStep({ agent, signal: ctrl.signal, turn: 't1' }, enter(human('插件改完怎么让它生效？')));
  assert.ok(bootA.provider.text({ agent, signal: ctrl.signal }));
  ctrl.abort();
  assert.equal(bootA.provider.text({ agent, signal: ctrl.signal }), '');

  const staleAgent = makeAgent('agent-stale', cwdA);
  const slower = new Promise((resolve) => setTimeout(() => resolve(enter(human('插件改完怎么让它生效？'))), 30));
  const stale = bootA.preStep({ agent: staleAgent, signal: signal(), turn: 't1' }, await slower);
  const newerSignal = signal();
  await bootA.preStep({ agent: staleAgent, signal: newerSignal, turn: 't2' }, enter(human('本地视频侧边栏播放')));
  await stale;
  const state = bootA.debug.preparedOf(staleAgent);
  assert.ok(state, 'newer request stays prepared');
  assert.match(state.query, /本地视频/);
}

// A06：模式策略；关掉时不准备、也不返回内容。
{
  const toolOnly = boot('tool_only');
  const agent = makeAgent('agent-tool', cwdA);
  const toolSig = await prepare(toolOnly, agent, '插件改完怎么让它生效？');
  assert.equal(toolOnly.provider.text({ agent, signal: toolSig }), '');
  const off = boot('off');
  const agentOff = makeAgent('agent-off', cwdA);
  const offSig = await prepare(off, agentOff, '插件改完怎么让它生效？');
  assert.equal(off.provider.text({ agent: agentOff, signal: offSig }), '');
  const disabled = await off.exec('memory_search', { query: '插件' }, agentOff);
  assert.equal(disabled.status, 'memory_disabled');
  assert.equal(off.render('memory_search', {}, disabled), 'memory · 记忆检索已关闭');
  const readDisabled = await off.exec('memory_read', { id: hotReload.id }, agentOff);
  assert.equal(readDisabled.status, 'memory_disabled');
}

// A07：合成消息不算真人请求，不准备也不开窗。
{
  const agent = makeAgent('agent-synth', cwdA);
  const webSig = signal();
  await bootA.preStep({ agent, signal: webSig, turn: 't1' }, enter(synthetic('web', '插件改完怎么让它生效？做一个网页搜索')));
  assert.equal(bootA.provider.text({ agent, signal: webSig }), '');
  const goalSig = signal();
  await bootA.preStep({ agent, signal: goalSig, turn: 't2' }, enter(synthetic('goal', '插件改完怎么让它生效')));
  assert.equal(bootA.provider.text({ agent, signal: goalSig }), '');
  assert.equal(bootA.debug.windowOf(agent), null);
}

// A08：真的无关时一个字都不注入。
{
  const agent = makeAgent('agent-unrelated', cwdA);
  const sig = await prepare(bootA, agent, '周末去山里走走');
  assert.equal(bootA.provider.text({ agent, signal: sig }), '');
}

// A09：条件不匹配、适用范围没解决的条目绝不自动召回。
{
  const cwdC = mkdir('c');
  const scopeC = store.scopeOf(cwdC);
  save(scopeC, {
    title: '只在另一台机器上跑构建检查',
    tags: ['构建'],
    applicability: 'conditional',
    conditions: [{ key: 'machine', value: '别的机器' }],
  });
  save(scopeC, { title: '发布前检查清单', tags: ['发布'], when: '发布前', applicability: 'unresolved' });
  const agent = makeAgent('agent-cond', cwdC);
  const sig = await prepare(bootA, agent, '发布前检查清单和 Linux 构建怎么做');
  assert.equal(bootA.provider.text({ agent, signal: sig }), '');
  assert.notEqual(linuxOnly.id, unresolved.id);
}

// A10：整卡装预算；装不下就整卡省略，不截断半个标题。
{
  const agent = makeAgent('agent-budget', cwdA);
  const sig = await prepare(bootA, agent, '发布流程每一步要检查什么？');
  const snapshot = bootA.provider.text({ agent, signal: sig });
  assert.ok(snapshot.length > 0);
  assert.ok(Buffer.byteLength(snapshot) <= 1200);
  const lines = snapshot.split('\n').slice(1);
  assert.ok(lines.length >= 1 && lines.length <= 3);
  for (const line of lines) {
    assert.match(line, CARD_LINE);
    assert.ok(line.trimEnd().endsWith('版') || line.includes('｜'), 'card is not cut mid-title');
    const title = line.match(/「(.+?)」/)?.[1] ?? '';
    assert.ok(title.length > 0);
    if (!longEntries.some((item) => item.record?.title === title) && !/插件|发布前跑/.test(title)) {
      throw new Error(`unexpected card: ${line}`);
    }
  }
}

// A11/A12/A13：读正文共用 8192 B / 3 条正文 / 8 次处理，重复读只回短句柄。
{
  const agent = makeAgent('agent-ledger', cwdA);
  await bootA.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('大正文样本怎么用')));
  const first = await bootA.exec('memory_read', { id: bigBodies[0].id }, agent);
  assert.equal(first.status, 'ok');
  assert.ok(Buffer.byteLength(first.body) > 900);
  const repeat = await bootA.exec('memory_read', { id: bigBodies[0].id }, agent);
  assert.equal(repeat.repeat, true);
  assert.equal(repeat.body, '');
  assert.match(bootA.render('memory_read', {}, repeat), /本请求已读过/);
  const second = await bootA.exec('memory_read', { id: bigBodies[1].id }, agent);
  assert.equal(second.status, 'ok');
  const third = await bootA.exec('memory_read', { id: bigBodies[2].id }, agent);
  assert.equal(third.status, 'ok');
  const fourth = await bootA.exec('memory_read', { id: bigBodies[3].id }, agent);
  assert.equal(fourth.status, 'budget_exhausted');
  assert.equal(fourth.body || '', '');
  assert.equal(bootA.render('memory_read', {}, fourth), 'memory · 这条消息已停止读记忆，下一条消息再读');
  const win = bootA.debug.windowOf(agent);
  assert.ok(win.bytes <= 8192);
  assert.equal(win.bodies, 3);

  const agentReads = makeAgent('agent-reads', cwdA);
  await bootA.preStep({ agent: agentReads, signal: signal(), turn: 't1' }, enter(human('大正文样本怎么用')));
  const firstRead = await bootA.exec('memory_read', { id: bigBodies[3].id }, agentReads);
  assert.equal(firstRead.status, 'ok');
  for (let i = 0; i < 7; i += 1) {
    const row = await bootA.exec('memory_read', { id: bigBodies[3].id }, agentReads);
    assert.equal(row.repeat, true, `repeat ${i + 1}`);
  }
  const capped = await bootA.exec('memory_read', { id: bigBodies[3].id }, agentReads);
  assert.equal(capped.status, 'budget_exhausted');
  assert.equal(capped.title, undefined);
  assert.equal(bootA.debug.windowOf(agentReads).reads, 8);
}

// A11b：准备阶段不算使用；只有真正交付给模型的卡片才更新 lastUsed。
{
  const cwdUse = mkdir('delivered');
  const scopeUse = store.scopeOf(cwdUse);
  const only = save(scopeUse, { title: '交付才算用过的记忆', tags: ['交付测试'], summary: '只看不交付不该改变使用时间' });
  const agent = makeAgent('agent-delivered', cwdUse);
  const runtime = boot();
  const sig = signal();
  patchState(scopeUse, only.record.id, { maintenance: { lastUsed: '2020-01-01T00:00:00.000Z' } });
  const saved = store.readEntry(scopeUse, only.record.id, { usage: () => false });
  assert.equal(saved.lastUsed, '2020-01-01T00:00:00.000Z', 'patch 生效');
  await runtime.preStep({ agent, signal: sig, turn: 'u1' }, enter(human('交付测试怎么做')));
  const preparedOnly = store.readEntry(scopeUse, only.record.id, { usage: () => false });
  assert.equal(preparedOnly.lastUsed, saved.lastUsed, '准备但没输出时不能改 lastUsed');
  assert.match(runtime.provider.text({ agent, signal: sig }), /交付才算用过的记忆/);
  const afterProvider = store.readEntry(scopeUse, only.record.id, { usage: () => false });
  assert.equal(afterProvider.lastUsed, saved.lastUsed, 'provider 输出路径不写使用时间');
  runtime.handlers.get('agent/turn-stopping').at(-1)({ turn: 'u1', signal: sig });
  const delivered = store.readEntry(scopeUse, only.record.id, { usage: () => false });
  assert.notEqual(delivered.lastUsed, saved.lastUsed, '回合收尾只给真正交付的卡片记使用');
}

// A12：额度状态与冻结快照分开；清掉快照后重准备不重新分配。
{
  const agent = makeAgent('agent-preserve', cwdA);
  const sig = signal();
  await bootA.preStep({ agent, signal: sig, turn: 't1' }, enter(human('插件改完怎么让它生效？')));
  const win = bootA.debug.windowOf(agent);
  const used = win.bytes;
  assert.ok(used > 0);
  const turnEnd = bootA.handlers.get('agent/turn-stopping').at(-1);
  turnEnd({ turn: 't1', signal: sig });
  assert.equal(bootA.provider.text({ agent, signal: sig }), '');
  await bootA.preStep({ agent, signal: sig, turn: 't2' }, enter(human('插件改完怎么让它生效？再确认一下')));
  assert.ok(bootA.provider.text({ agent, signal: sig }).startsWith(HEADER));
  assert.equal(win.bytes, used, 'same window does not re-allocate for already provided cards');
}

// A13b：轮次收尾清的是投影，不是任务；下一句「继续」仍要接上上一轮的原话。
{
  const agent = makeAgent('agent-after-turn', cwdA);
  const first = signal();
  await bootA.preStep({ agent, signal: first, turn: 'n1' }, enter(human('插件改完怎么让它生效？')));
  assert.ok(bootA.provider.text({ agent, signal: first }));
  bootA.handlers.get('agent/turn-stopping').at(-1)({ turn: 'n1', signal: first });
  assert.equal(bootA.provider.text({ agent, signal: first }), '');
  const second = signal();
  await bootA.preStep({ agent, signal: second, turn: 'n2' }, enter(human('继续')));
  assert.match(bootA.provider.text({ agent, signal: second }), /插件改完先试热刷新/, '收尾后「继续」仍属原任务');
}

// A13c：新任务零召回也照样记下新查询；再说「继续」不能把旧任务的记忆带回来。
{
  const agent = makeAgent('agent-zero-task', cwdA);
  const first = signal();
  await bootA.preStep({ agent, signal: first, turn: 'z1' }, enter(human('插件改完怎么让它生效？')));
  bootA.handlers.get('agent/turn-stopping').at(-1)({ turn: 'z1', signal: first });
  const second = signal();
  await bootA.preStep({ agent, signal: second, turn: 'z2' }, enter(human('帮我算一下 17 乘以 23 等于多少')));
  bootA.handlers.get('agent/turn-stopping').at(-1)({ turn: 'z2', signal: second });
  const third = signal();
  await bootA.preStep({ agent, signal: third, turn: 'z3' }, enter(human('继续')));
  assert.doesNotMatch(bootA.provider.text({ agent, signal: third }), /插件改完先试热刷新/, '零召回的新任务不能被旧任务续上');
}

// A13d：工具续步没有新的真人原话，刚执行的动作可以换来一次有界补查。
{
  const cwdStep = mkdir('tool-step');
  const scopeStep = store.scopeOf(cwdStep);
  save(scopeStep, { title: '记忆插件先看状态再改', tags: ['记忆插件', '排查'], summary: '先看状态文件再动代码' });
  save(scopeStep, { title: '改完 client.js 先重载宿主', tags: ['client.js', '重载'], summary: '普通刷新覆盖不到 client.js' });
  const agent = makeAgent('agent-tool-step', cwdStep);
  const runtime = boot();
  const said = human('记忆插件怎么排查');
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 's1' }, enter(said));
  assert.match(runtime.provider.text({ agent, signal: first }), /记忆插件先看状态再改/);
  const toolStep = {
    role: 'assistant',
    id: 'asst-tool-step',
    content: [
      { type: 'text', text: '我把改动写进文件了。' },
      { type: 'tool-call', name: 'write', input: { file_path: '/tmp/step/client.js' } },
    ],
  };
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 's1' }, enter(said, toolStep));
  assert.match(runtime.provider.text({ agent, signal: second }), /改完 client\.js 先重载宿主/, '工具动作后补查一次');
}

// A14：上一轮注入过的文字不会被当成这一轮的来源；只有合成消息的新 turn 不继承。
{
  const agent = makeAgent('agent-stale-section', cwdA);
  const sig1 = signal();
  await bootA.preStep({ agent, signal: sig1, turn: 't1' }, enter(human('插件改完怎么让它生效？')));
  assert.ok(bootA.provider.text({ agent, signal: sig1 }));
  const sig2 = signal();
  await bootA.preStep({ agent, signal: sig2, turn: 't2' }, enter(synthetic('tool', '命令输出：done')));
  assert.equal(bootA.provider.text({ agent, signal: sig2 }), '');
}

// A15：忘掉之后旧快照不复活；下一次请求不再带它。
{
  const cwdD = mkdir('d');
  const scopeD = store.scopeOf(cwdD);
  const doomed = save(scopeD, { title: '插件改完要重启应用', tags: ['插件', '重启'], summary: '旧结论：必须重启' });
  const agent = makeAgent('agent-purge', cwdD);
  const sig = signal();
  await bootA.preStep({ agent, signal: sig, turn: 't1' }, enter(human('插件改完怎么让它生效？')));
  assert.match(bootA.provider.text({ agent, signal: sig }), /插件改完要重启应用/);
  const purged = await bootA.exec('memory_forget', { title: '插件改完要重启应用', mode: 'purge' }, agent);
  assert.equal(purged.mode, 'purged');
  assert.match(bootA.provider.text({ agent, signal: sig }), /插件改完要重启应用/, '已提交的旧快照不回头改写');
  assert.doesNotMatch(bootA.provider.text({ agent, signal: sig }), /mem_[a-z0-9]{6,}/, '召回卡从不带内部编号');
  const sig2 = signal();
  await bootA.preStep({ agent, signal: sig2, turn: 't2' }, enter(human('插件改完怎么让它生效？')));
  const after = bootA.provider.text({ agent, signal: sig2 });
  assert.doesNotMatch(after, new RegExp(doomed.id));
  assert.doesNotMatch(after, /插件改完要重启应用/);
}

// 退出清理：disposed 之后 provider 一律空。
{
  const agent = makeAgent('agent-dispose', cwdA);
  const sig = signal();
  await bootA.preStep({ agent, signal: sig, turn: 't1' }, enter(human('插件改完怎么让它生效？')));
  const disposed = bootA.handlers.get('agent/disposed').at(-1);
  disposed({ agent });
  assert.equal(bootA.provider.text({ agent, signal: sig }), '');
}

// A16：全局层被彻底删除后，工具续步立刻重投影；冻结的旧卡片不复活，新真人任务重算。
{
  const globalNote = save(global, { title: '全局发布前文案核对', tags: ['发布', '核对'], summary: '全局规则：发布前先核对文案' });
  const agent = makeAgent('agent-global-purge', cwdA);
  const sig = signal();
  await bootA.preStep({ agent, signal: sig, turn: 't1' }, enter(human('发布前跑文案检查')));
  assert.match(bootA.provider.text({ agent, signal: sig }), /全局发布前文案核对/);
  const purged = store.forget(global, globalNote.id, { mode: 'purge' });
  assert.equal(purged.mode, 'purged');
  /** 同一 turn 的续步没有新真人消息：不重新问人，但盘上变了必须换掉快照。 */
  await bootA.preStep({ agent, signal: sig, turn: 't1' }, enter());
  const after = bootA.provider.text({ agent, signal: sig });
  assert.doesNotMatch(after, /全局发布前文案核对/);
  assert.match(after, /发布前跑文案检查/, '项目层卡片仍在');
  const sigNext = signal();
  await bootA.preStep({ agent, signal: sigNext, turn: 't2' }, enter(human('大正文样本怎么用')));
  assert.match(bootA.debug.preparedOf(agent).query, /大正文样本/);
  assert.doesNotMatch(bootA.provider.text({ agent, signal: sigNext }), /全局发布前文案核对/);
}

// A17：工具模式不自动注入，但工具调用同样共享每请求额度。
{
  const toolOnly = boot('tool_only');
  const agent = makeAgent('agent-tool-budget', cwdA);
  await prepare(toolOnly, agent, '大正文样本怎么用');
  assert.equal(toolOnly.debug.preparedOf(agent), null);
  const win = toolOnly.debug.windowOf(agent);
  assert.ok(win, '工具模式也开额度窗口');
  let exhausted = null;
  for (let i = 0; i < 9 && !exhausted; i += 1) {
    const row = await toolOnly.exec('memory_read', { id: bigBodies[i].id }, agent);
    if (row.status === 'budget_exhausted') exhausted = row;
  }
  assert.ok(exhausted, '超过额度后拒绝读正文');
  assert.equal(exhausted.id, undefined);
  assert.ok(win.bytes <= 8192);
  assert.ok(win.bodies <= 3);
  assert.ok(win.reads <= 8);
}

// A21：自动注入把这一轮用得差不多，模型按标题来读正文不该被连带挡掉。
{
  const agent = makeAgent('agent-read-after-auto', cwdA);
  await prepare(bootA, agent, '大正文样本怎么用');
  const win = bootA.debug.windowOf(agent);
  assert.ok(win, '自动召回开了额度窗口');
  /** 模拟自动注入已经把这轮的 8192 B 用满。 */
  win.bytes = 8192;
  const row = await bootA.exec('memory_read', { title: '大正文样本1' }, agent);
  assert.equal(row.status, 'ok', '自动注入用满之后仍能读正文');
  assert.ok(Buffer.byteLength(row.body) > 900);
}

// A18：归档/旧正文不进正常检索；只有明确查历史才列归档。
{
  const cwdE = mkdir('e');
  const scopeE = store.scopeOf(cwdE);
  const archivedEntry = save(scopeE, { title: '旧端口修正', tags: ['端口'], summary: '端口改到 49661', body: '旧正文：端口是 49661' });
  const agent = makeAgent('agent-history', cwdE);
  const fresh = await bootA.exec('memory_search', { query: '旧端口修正' }, agent);
  assert.equal(fresh.count, 1);
  await bootA.exec('memory_forget', { id: archivedEntry.id, mode: 'archive' }, agent);
  const hidden = await bootA.exec('memory_search', { query: '旧端口修正' }, agent);
  assert.equal(hidden.count, 0, '归档后默认检索不到');
  const history = await bootA.exec('memory_search', { query: '旧端口修正', history: true }, agent);
  assert.equal(history.count, 1);
  assert.equal(history.refs[0].status, 'archived');
  const oldBody = save(scopeE, { title: '口端口令', tags: ['端口'], summary: '端口以最新为准', body: '第一版：端口是 5000' });
  store.upsert(scopeE, { id: oldBody.id, title: '口端口令', summary: '端口以最新为准', body: '第二版：端口是 49661' });
  const current = await bootA.exec('memory_search', { query: '口端口令', history: true }, agent);
  assert.ok(current.refs.some((ref) => ref.title === '口端口令' && ref.revision === 2), '检索只给当前版本');
  const latest = await bootA.exec('memory_read', { id: oldBody.id }, agent);
  assert.match(latest.body, /第二版/);
  assert.doesNotMatch(latest.body, /第一版/);
}

// A19：预算按规范化 JSON 字节算，中文、换行、引号、反斜杠都算进去。
{
  const cwdF = mkdir('f');
  const scopeF = store.scopeOf(cwdF);
  const tricky = store.upsert(scopeF, {
    title: '转义预算样本',
    summary: '换行与引号',
    applicability: 'all_in_scope',
    body: '第一行\n第二行 "双引号" \\反斜杠\t制表',
  });
  const agent = makeAgent('agent-json-budget', cwdF);
  await bootA.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('转义预算样本怎么读')));
  const win = bootA.debug.windowOf(agent);
  const before = win.bytes;
  const value = await bootA.exec('memory_read', { id: tricky.record.id }, agent);
  assert.equal(value.status, 'ok');
  assert.equal(win.bytes - before, Buffer.byteLength(JSON.stringify(value)));
  assert.ok(win.bytes <= 8192);
}

// 生命周期退出默认召回：被取代、过期的条目不再自动注入，也不再进手动检索。
{
  const runtime = boot();
  const cwdLife = mkdir('lifecycle');
  const scopeLife = store.scopeOf(cwdLife);
  const oldDeploy = save(scopeLife, {
    title: '旧部署目标', summary: '部署到 staging，旧流程。', body: '旧流程只发 staging。', resolution: 'distinct',
  });
  const newDeploy = save(scopeLife, {
    title: '新部署目标', summary: '部署到 production，先跑测试。', body: '新流程先跑测试再发 production。', resolution: 'distinct',
    supersedes: oldDeploy.id,
  });
  const stalePort = save(scopeLife, {
    title: '临时调试端口', summary: '本地服务跑在 18080。', body: '旧端口已经不用了。', resolution: 'distinct',
  });
  patchState(scopeLife, stalePort.id, {
    validFrom: new Date(Date.now() - 7200_000).toISOString(),
    validUntil: new Date(Date.now() - 3600_000).toISOString(),
  });
  const agentLife = makeAgent('agent-lifecycle', cwdLife);
  const lifeSignal = await prepare(runtime, agentLife, '部署目标怎么走，临时调试端口是多少');
  const text = runtime.provider.text({ agent: agentLife, signal: lifeSignal });
  assert.match(text, /新部署目标/);
  assert.doesNotMatch(text, /旧部署目标|旧流程只发 staging/, '被取代的条目退出自动召回');
  assert.doesNotMatch(text, /临时调试端口|旧端口已经不用了/, '过期的条目退出自动召回');
  const found = await runtime.exec('memory_search', { query: '部署目标' }, agentLife);
  assert.equal(found.refs.some((ref) => ref.title === '旧部署目标'), false);
  assert.equal(found.refs.some((ref) => ref.title === '新部署目标'), true);
  const port = await runtime.exec('memory_search', { query: '临时调试端口' }, agentLife);
  assert.equal(port.refs.some((ref) => ref.title === '临时调试端口'), false, '过期条目也不进默认检索');
}

// A20：没有命中是正常空结果，不是额度用尽。
{
  const agent = makeAgent('agent-empty-search', cwdA);
  await bootA.preStep({ agent, signal: signal(), turn: 't1' }, enter(human('完全无关的一串词')));
  const value = await bootA.exec('memory_search', { query: '完全不存在的主题 zzzqqq' }, agent);
  assert.equal(value.status, 'ok');
  assert.equal(value.count, 0);
  assert.deepEqual(value.refs, []);
}

console.log('recall.test.mjs: ok');

// A20：条件未确认的条目，model 侧读正文只拿状态，不拿标题；面板仍可查。
{
  const agent = makeAgent('agent-withheld-read', cwdA);
  await prepare(bootA, agent, '发布前要检查什么');
  const row = await bootA.exec('memory_read', { id: unresolved.id }, agent);
  assert.equal(row.body, '');
  assert.equal(row.status, 'needs_context');
  assert.doesNotMatch(JSON.stringify(row), /发布前要检查什么/);
  assert.doesNotMatch(bootA.render('memory_read', { id: unresolved.id }, row), /发布前要检查什么/);
  const links = await bootA.exec('memory_read', { id: unresolved.id, view: 'links' }, agent);
  assert.equal(links.status, 'needs_context');
  assert.doesNotMatch(JSON.stringify(links), /发布前要检查什么/);
}

// A24：纯英文查询按整词判断，自动注入和手动搜索必须给同一个结论。
{
  const cwdEn = mkdir('en');
  const scopeEn = store.scopeOf(cwdEn);
  save(scopeEn, { title: 'Digital asset catalog', summary: '图形素材目录' });
  const agent = makeAgent('agent-en', cwdEn);
  const runtime = boot();
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('git')));
  assert.doesNotMatch(runtime.provider.text({ agent, signal: sig }), /Digital asset catalog/);
  assert.equal(store.search(scopeEn, 'git', 5).length, 0, '手动搜索也不给这条');
}

// A25：用户这句话没提动作时，用上一轮助手的话和工具名补一次查询；补不到不盖掉原判断。
{
  const cwdAct = mkdir('action');
  const scopeAct = store.scopeOf(cwdAct);
  save(scopeAct, {
    title: '改完 client.js 先重载宿主',
    tags: ['client.js', '重载'],
    summary: 'client.js 一改就要重载宿主，普通刷新覆盖不到',
  });
  const agent = makeAgent('agent-action', cwdAct);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 't1' }, enter(human('这个怎么弄')));
  assert.equal(runtime.provider.text({ agent, signal: first }), '', '只说「这个怎么弄」时不该凭空命中');
  const assistantMessage = {
    role: 'assistant',
    id: 'asst-action-1',
    content: [
      { type: 'text', text: '我把改动写进文件了。' },
      { type: 'tool-call', name: 'write', input: { file_path: '/tmp/act/client.js' } },
    ],
  };
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 't2' }, enter(assistantMessage, human('这个怎么弄')));
  const actionText = runtime.provider.text({ agent, signal: second });
  assert.match(actionText, /改完 client\.js 先重载宿主/, '动作侧线索要能召回预防型记忆');
  const actionWin = runtime.debug.windowOf(agent);
  assert.equal(actionWin.autoBudget.totalBytes, Buffer.byteLength(actionText), '最终交付字节与预算账本一致');
  assert.equal(actionWin.autoBudget.cards, runtime.debug.preparedOf(agent).cards.length, '最终卡片数与预算账本一致');
}

// A25b：短续句「继续优化收敛」没有自己的检索词，要沿用上一句，不能断在上一轮。
{
  const cwdEllipse = mkdir('ellipse');
  const scopeEllipse = store.scopeOf(cwdEllipse);
  save(scopeEllipse, {
    title: '轻量化记忆与前端展示逻辑先定召回顺序',
    tags: ['轻量化记忆', '前端展示逻辑'],
    summary: '先定召回顺序，再谈展示；触发机制跟着任务走',
  });
  const agent = makeAgent('agent-ellipse', cwdEllipse);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 'e1' }, enter(human('继续优化轻量化记忆与前端展示逻辑 还有触发机制等')));
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 'e2' }, enter(human('继续优化收敛')));
  const prepared = runtime.debug.preparedOf(agent);
  assert.ok(prepared, '短续句要准备召回');
  assert.match(prepared.query, /轻量化记忆与前端展示逻辑/, '短续句沿用上一句原话');
  assert.ok(prepared.cards.some((card) => /轻量化记忆/.test(card.title || card.line || '')), '同一话题的记忆要回来');
}

// A25c：上一轮有动作、这句话只有「这个怎么弄」时，通用卡片不能挡住动作线索的补查。
{
  const cwdGeneric = mkdir('generic');
  const scopeGeneric = store.scopeOf(cwdGeneric);
  save(scopeGeneric, {
    title: '这个怎么弄时先读现有文档',
    tags: ['怎么弄', '文档'],
    summary: '没头绪时先读现有文档再动手',
  });
  save(scopeGeneric, {
    title: '改完 client.js 先重载宿主',
    tags: ['client.js', '重载'],
    summary: 'client.js 一改就要重载宿主，普通刷新覆盖不到',
  });
  const agent = makeAgent('agent-generic', cwdGeneric);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 'g1' }, enter(human('这个怎么弄')));
  assert.match(runtime.provider.text({ agent, signal: first }), /先读现有文档/, '第一轮命中通用卡片');
  const assistantMessage = {
    role: 'assistant',
    id: 'asst-generic-1',
    content: [
      { type: 'text', text: '我把改动写进文件了。' },
      { type: 'tool-call', name: 'write', input: { file_path: '/tmp/generic/client.js' } },
    ],
  };
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 'g2' }, enter(assistantMessage, human('这个怎么弄')));
  assert.match(runtime.provider.text({ agent, signal: second }), /改完 client\.js 先重载宿主/, '通用卡片不能挡住动作线索');
}

// A25d：换到数据库任务后再说「继续」，只承接数据库这一句，不能把前端任务的记忆带回来。
{
  const cwdSwitch = mkdir('switch-cont');
  const scopeSwitch = store.scopeOf(cwdSwitch);
  save(scopeSwitch, {
    title: '前端按钮颜色先对齐设计稿 token',
    tags: ['前端按钮', '颜色'],
    summary: '按钮颜色只取设计稿 token，不要另写十六进制',
  });
  save(scopeSwitch, {
    title: 'PostgreSQL 连接池先查 max_connections',
    tags: ['PostgreSQL', '连接池'],
    summary: '连接池调大前先看 max_connections 和实际占用',
  });
  const agent = makeAgent('agent-switch-cont', cwdSwitch);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 'sc1' }, enter(human('前端按钮颜色怎么改')));
  assert.match(runtime.provider.text({ agent, signal: first }), /前端按钮颜色/, '第一轮命中前端任务');
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 'sc2' }, enter(human('改用 PostgreSQL，先看连接池')));
  assert.match(runtime.provider.text({ agent, signal: second }), /PostgreSQL 连接池/, '第二轮命中数据库任务');
  const third = signal();
  await runtime.preStep({ agent, signal: third, turn: 'sc3' }, enter(human('继续')));
  const prepared = runtime.debug.preparedOf(agent);
  assert.match(prepared.query, /PostgreSQL/, '续句承接的是数据库那一句');
  assert.ok(prepared.cards.some((card) => /PostgreSQL/.test(card.title || card.line || '')), '续句仍命中数据库记忆');
  assert.ok(!prepared.cards.some((card) => /前端按钮/.test(card.title || card.line || '')), '不把前端任务记忆带回来');
}

// A25e：认不出任务类型的明确换任务，也不能把上一轮的动作线索带过来。
{
  const cwdUnknown = mkdir('unknown-switch');
  const scopeUnknown = store.scopeOf(cwdUnknown);
  save(scopeUnknown, {
    title: '改完 client.js 先重载宿主',
    tags: ['client.js', '重载'],
    summary: 'client.js 改动后必须重载宿主，普通刷新覆盖不到',
  });
  save(scopeUnknown, {
    title: 'nginx 502 先看 upstream 日志',
    tags: ['nginx', '502', 'upstream'],
    summary: '502 先查 upstream 是否存活，再看超时配置',
  });
  const agent = makeAgent('agent-unknown', cwdUnknown);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 'u1' }, enter(human('把前端按钮颜色调一下')));
  const assistantMessage = {
    role: 'assistant',
    id: 'asst-unknown-1',
    content: [
      { type: 'text', text: '我把 client.js 的样式改好了。' },
      { type: 'tool-call', name: 'write', input: { file_path: '/tmp/unknown/client.js' } },
    ],
  };
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 'u2' }, enter(assistantMessage, human('先别管这个了，帮我看看 nginx 502')));
  const switchedText = runtime.provider.text({ agent, signal: second });
  assert.doesNotMatch(switchedText, /改完 client\.js 先重载宿主/, '明确换任务后不带旧动作线索');
  assert.match(switchedText, /nginx 502/, '新任务本身能命中');
  const third = signal();
  await runtime.preStep({ agent, signal: third, turn: 'u3' }, enter(human('继续')));
  const continuedText = runtime.provider.text({ agent, signal: third });
  assert.match(continuedText, /nginx 502/, '续句承接新任务');
  assert.doesNotMatch(continuedText, /改完 client\.js 先重载宿主/, '续句不回旧任务');
}

// A26：明确换任务后，不能拿上一轮助手的话去补查、把旧任务记忆塞进新任务。
{
  const cwdSwitch = mkdir('switch');
  const scopeSwitch = store.scopeOf(cwdSwitch);
  save(scopeSwitch, {
    title: '口播开场先给结论',
    tags: ['口播', '开场'],
    summary: '口播开场三句内先给结论，别先铺垫',
  });
  const agent = makeAgent('agent-switch', cwdSwitch);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 't1' }, enter(human('这期口播开场怎么改')));
  const assistantMessage = {
    role: 'assistant',
    id: 'asst-switch-1',
    content: [
      { type: 'text', text: '口播开场先给结论，栏目风格保持短句。' },
      { type: 'tool-call', name: 'write', input: { file_path: '/tmp/switch/talk.md' } },
    ],
  };
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 't2' }, enter(assistantMessage, human('开始写 PostgreSQL 迁移脚本，先建表')));
  assert.equal(runtime.provider.text({ agent, signal: second }), '', '换任务后不补查旧任务的动作线索');
}

// A27：npm 原生命令在动作发生前拦一次，把凭据用法直接交给模型；同一轮不重复。
{
  const cwdNpm = mkdir('npm-guard');
  const scopeNpm = store.scopeOf(cwdNpm);
  store.setRecallMode(scopeNpm, 'adaptive', { operationId: 'npm-guard-mode' });
  assert.ok(store.upsert(global, {
    title: 'npm 发布一律走 dsh-npm，ENEEDAUTH 不是缺凭据',
    summary: '发布走 dsh-npm，不要用 npm whoami 判断凭据',
    body: '本机 npm 凭据在 Keychain，npm whoami 常报 ENEEDAUTH；发布一律用 dsh-npm publish，不要重新登录。',
    tags: ['npm', 'dsh-npm', '凭据'],
    applicability: 'all_in_scope',
  }).record);
  const guards = [];
  const agent = makeAgent('agent-npm-guard', cwdNpm);
  agent.ctx = {
    tools: { guard: (fn) => { guards.push(fn); return () => {}; } },
    effect: (fn) => fn(),
  };
  const runtime = boot();
  runtime.handlers.get('agent/created').at(-1)({ agent });
  assert.equal(guards.length, 1, '每个 agent 装一个执行前守卫');
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 'npm-1' }, enter(human('帮我发布这个包')));
  const blocked = guards[0]({ name: 'bash', callId: 'call-npm-1', arguments: { command: 'npm whoami' } });
  assert.match(String(blocked), /npm 发布一律走 dsh-npm/, '动作发生前给已有记忆正文');
  assert.match(String(blocked), /Keychain/, '给正文而不是只给标题');
  assert.equal(guards[0]({ name: 'bash', callId: 'call-npm-2', arguments: { command: 'npm publish' } }), undefined, '同一轮只提示一次');
  assert.ok(scopeNpm.key, '项目层不受影响');
}

// A27b：npm 提醒先看当前项目层，再看全局层；本机流程留在项目层也能在动作前拦人。
{
  const cwdNpmProject = mkdir('npm-guard-project');
  const scopeNpmProject = store.scopeOf(cwdNpmProject);
  store.setRecallMode(scopeNpmProject, 'adaptive', { operationId: 'npm-guard-project-mode' });
  assert.ok(store.upsert(global, {
    title: 'npm 全局登录提醒',
    summary: '全局层的 npm 登录说明',
    body: '全局层：npm login 会误导，改用 dsh-npm。',
    tags: ['npm'],
    applicability: 'all_in_scope',
  }).record);
  assert.ok(store.upsert(scopeNpmProject, {
    title: 'npm 项目发布前先看凭据',
    summary: '这个项目的 npm 发布步骤',
    body: '项目层：先读 Keychain 位置，再用 dsh-npm publish，不要 npm whoami。',
    tags: ['npm', '发布'],
    applicability: 'all_in_scope',
  }).record);
  const guards = [];
  const agent = makeAgent('agent-npm-project', cwdNpmProject);
  agent.ctx = {
    tools: { guard: (fn) => { guards.push(fn); return () => {}; } },
    effect: (fn) => fn(),
  };
  const runtime = boot();
  runtime.handlers.get('agent/created').at(-1)({ agent });
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 'npm-project-1' }, enter(human('先看下环境状态')));
  const blocked = guards[0]({ name: 'bash', callId: 'call-npm-project', arguments: { command: 'npm publish' } });
  assert.match(String(blocked), /项目发布前先看凭据/, '项目层规则优先于全局层');
  assert.match(String(blocked), /Keychain/, '给项目层正文');
}

// A28：零命中的同一轮里，关键动作发生后补查一次；补到后不再重复注入。
{
  const cwdActionKey = mkdir('action-key');
  const scopeActionKey = store.scopeOf(cwdActionKey);
  store.setRecallMode(scopeActionKey, 'adaptive', { operationId: 'action-key-mode' });
  const agent = makeAgent('agent-action-key', cwdActionKey);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 'ak1' }, enter(human('这个怎么弄')));
  assert.equal(runtime.provider.text({ agent, signal: first }), '', '第一步没有线索时不凭空命中');
  const assistantMessage = {
    role: 'assistant',
    id: 'asst-action-key-1',
    content: [
      { type: 'text', text: '我先看一下。' },
      { type: 'tool-call', name: 'bash', input: { command: 'npm whoami' } },
    ],
  };
  const toolResult = { role: 'user', id: 'tool-action-key-1', source: { kind: 'tool' }, content: [{ type: 'text', text: '已完成' }] };
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 'ak1' }, enter(assistantMessage, toolResult));
  const text = runtime.provider.text({ agent, signal: second });
  assert.match(text, /npm 发布一律走 dsh-npm/, '关键动作让凭据记忆在动作后补进来');
  assert.equal(runtime.debug.preparedOf(agent).actionRetried, true, '一次请求只补查一次');
  const actionWin = runtime.debug.windowOf(agent);
  assert.equal(actionWin.autoBudget.totalBytes, Buffer.byteLength(text), '补查后的最终字节与账本一致');
  assert.equal(actionWin.autoBudget.cards, runtime.debug.preparedOf(agent).cards.length, '补查后的卡片数与账本一致');
  const third = signal();
  await runtime.preStep({ agent, signal: third, turn: 'ak1' }, enter({
    role: 'assistant',
    id: 'asst-action-key-2',
    content: [{ type: 'tool-call', name: 'bash', input: { command: 'npm publish' } }],
  }, { role: 'user', id: 'tool-action-key-2', source: { kind: 'tool' }, content: [{ type: 'text', text: 'ERR' }] }));
  assert.equal(runtime.provider.text({ agent, signal: third }), text, '同一请求不重复补查，也不花第二份额度');
}

// A29：没有「换任务」这类明说，但新话题已经可判定为另一件事时，旧动作线索不能跟过来。
{
  const cwdFree = mkdir('free-switch');
  const scopeFree = store.scopeOf(cwdFree);
  save(scopeFree, {
    title: '改完 client.js 先重载宿主',
    tags: ['client.js', '重载'],
    summary: 'client.js 改动后必须重载宿主，普通刷新覆盖不到',
  });
  save(scopeFree, {
    title: 'PostgreSQL 连接池先查 max_connections',
    tags: ['PostgreSQL', '连接池'],
    summary: '连接池调大前先看 max_connections 和实际占用',
  });
  const agent = makeAgent('agent-free-switch', cwdFree);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 'f1' }, enter(human('前端按钮颜色怎么改')));
  const assistantMessage = {
    role: 'assistant',
    id: 'asst-free-1',
    content: [
      { type: 'text', text: '我把 client.js 的样式改好了。' },
      { type: 'tool-call', name: 'write', input: { file_path: '/tmp/free/client.js' } },
    ],
  };
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 'f2' }, enter(assistantMessage, human('PostgreSQL 连接池满了怎么排查')));
  const text = runtime.provider.text({ agent, signal: second });
  assert.match(text, /PostgreSQL 连接池/, '新话题命中自己的记忆');
  assert.doesNotMatch(text, /改完 client\.js 先重载宿主/, '旧任务线索不能进新任务');
}

// A30：只读文件、memory 工具输出不算「关键动作」，不能提前花掉一次补查机会。
{
  const cwdRead = mkdir('read-action');
  const scopeRead = store.scopeOf(cwdRead);
  store.setRecallMode(scopeRead, 'adaptive', { operationId: 'read-action-mode' });
  save(scopeRead, {
    title: 'npm 发布一律走 dsh-npm，ENEEDAUTH 不是缺凭据',
    tags: ['npm', 'dsh-npm', '凭据'],
    summary: '发布走 dsh-npm，不要用 npm whoami 判断凭据',
    body: '本机 npm 凭据在 Keychain，npm whoami 常报 ENEEDAUTH；发布一律用 dsh-npm publish，不要重新登录。',
  });
  const agent = makeAgent('agent-read-action', cwdRead);
  const runtime = boot();
  const first = signal();
  await runtime.preStep({ agent, signal: first, turn: 'ra1' }, enter(human('这个怎么弄')));
  assert.equal(runtime.provider.text({ agent, signal: first }), '', '第一步没有线索时不凭空命中');
  const passiveStep = {
    role: 'assistant',
    id: 'asst-read-action-1',
    content: [
      { type: 'text', text: '先看文档和已有记录。' },
      { type: 'tool-call', name: 'read', input: { file_path: '/tmp/lite-memory/README.md' } },
      { type: 'tool-call', name: 'memory_search', input: { query: 'npm 凭据怎么用' } },
    ],
  };
  const readResult = { role: 'user', id: 'tool-read-action-1', source: { kind: 'tool' }, content: [{ type: 'text', text: '# README 一段普通说明' }] };
  const second = signal();
  await runtime.preStep({ agent, signal: second, turn: 'ra1' }, enter(passiveStep, readResult));
  const heldAfterRead = runtime.debug.preparedOf(agent);
  assert.equal(heldAfterRead?.actionRetried, false, '只读操作不触发补查');
  assert.equal(runtime.provider.text({ agent, signal: second }), '', '只读操作后仍保持空快照');
  const activeStep = {
    role: 'assistant',
    id: 'asst-read-action-2',
    content: [{ type: 'tool-call', name: 'bash', input: { command: 'npm whoami' } }],
  };
  const activeResult = { role: 'user', id: 'tool-read-action-2', source: { kind: 'tool' }, content: [{ type: 'text', text: '已完成' }] };
  const third = signal();
  await runtime.preStep({ agent, signal: third, turn: 'ra1' }, enter(activeStep, activeResult));
  const text = runtime.provider.text({ agent, signal: third });
  assert.match(text, /npm 发布一律走 dsh-npm/, '真正关键动作仍能补查一次');
  assert.equal(runtime.debug.preparedOf(agent).actionRetried, true);
  const fourth = signal();
  await runtime.preStep({ agent, signal: fourth, turn: 'ra1' }, enter({
    role: 'assistant', id: 'asst-read-action-3', content: [{ type: 'tool-call', name: 'bash', input: { command: 'npm publish' } }],
  }, { role: 'user', id: 'tool-read-action-3', source: { kind: 'tool' }, content: [{ type: 'text', text: 'ERR' }] }));
  assert.equal(runtime.provider.text({ agent, signal: fourth }), text, '同一请求不重复补查');
}

// A31：只有真人明确说「存到全局/所有项目」才算跨项目授权，普通「全局变量」不能放行。
{
  const runtime = boot();
  const asked = runtime.debug.humanAskedGlobal;
  for (const text of ['以后这条存全局', '记到全局记忆里', '所有项目都按这个来', '以后所有项目都这样做']) {
    assert.equal(asked(text), true, text);
  }
  for (const text of ['把全局变量保存一下', '全局搜索这个函数', '这个项目保存一下', '都改完了保存']) {
    assert.equal(asked(text), false, text);
  }
}

// A32：只有真递到模型眼里的条目才记使用时间；空召回/未命中的回合不能顺手记账。
{
  const cwd = mkdir('usage');
  const scope = store.scopeOf(cwd);
  const probe = save(scope, { title: '量子纠缠咖啡机', tags: ['记账'], summary: '只有送达才记 lastUsed' });
  const lastUsedOf = () => store.locateByTitle(scope, '量子纠缠咖啡机').record.lastUsed;
  const baseline = lastUsedOf();
  const runtime = boot();
  const agent = makeAgent('agent-usage', cwd);
  const missSignal = await prepare(runtime, agent, '完全无关的一串词');
  assert.doesNotMatch(runtime.provider.text({ agent, signal: missSignal }), /量子纠缠咖啡机/);
  runtime.handlers.get('agent/turn-stopping').at(-1)({ signal: missSignal });
  assert.equal(lastUsedOf(), baseline, '没送达的条目不能被记账');
  const hitSignal = await prepare(runtime, agent, '量子纠缠咖啡机', 't2');
  assert.match(runtime.provider.text({ agent, signal: hitSignal }), /量子纠缠咖啡机/);
  assert.equal(lastUsedOf(), baseline, '送达也不在 provider 路径上写盘');
  runtime.handlers.get('agent/turn-stopping').at(-1)({ signal: hitSignal });
  assert.ok(lastUsedOf(), '回合收尾时把真正送达的条目记账');
  assert.equal(store.locateByTitle(scope, '量子纠缠咖啡机').record.id, probe.id);
}
