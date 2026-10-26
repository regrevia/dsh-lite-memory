import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-recall-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');

const HEADER = '已有记忆可能相关';
const CARD_LINE = /^- \[[^\]]+\] 「.+?」.* · mem_[a-z0-9]+(?:｜.*)?$/;
const CARD_LINE_M = new RegExp(CARD_LINE.source, 'm');

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
  conditions: [{ key: 'targetOs', value: 'linux' }],
  summary: '只在 Linux CI 上跑构建检查',
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
    title: '只在 Linux 上跑构建检查',
    tags: ['构建'],
    applicability: 'conditional',
    conditions: [{ key: 'targetOs', value: 'linux' }],
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
  assert.equal(fourth.id, '');
  assert.equal(bootA.render('memory_read', {}, fourth), 'memory · 本请求的记忆额度已用完');
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
  assert.match(bootA.provider.text({ agent, signal: sig }), new RegExp(doomed.id));
  const purged = await bootA.exec('memory_forget', { id: doomed.id, mode: 'purge' }, agent);
  assert.equal(purged.mode, 'purged');
  assert.match(bootA.provider.text({ agent, signal: sig }), new RegExp(doomed.id), '已提交的旧快照不回头改写');
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
  assert.match(bootA.provider.text({ agent, signal: sig }), new RegExp(globalNote.id));
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
  assert.equal(exhausted.id, '');
  assert.ok(win.bytes <= 8192);
  assert.ok(win.bodies <= 3);
  assert.ok(win.reads <= 8);
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
  assert.ok(current.refs.some((ref) => ref.id === oldBody.id && ref.revision === 2), '检索只给当前版本');
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
