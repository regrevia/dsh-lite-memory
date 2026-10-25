import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');
const state = await import('../state.js');

const ORIGIN = 'http://127.0.0.1:60402';
const defs = new Map();
let route = null;

const webServer = { getOrigin: () => ORIGIN, register: (entry) => { route = entry; return () => {}; } };
const effect = (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; };
let currentAgent = null;
let llmImpl = null;
const sessionCwds = new Map();
const subscriptions = new Map();
const promptContexts = [];
const ctx = {
  tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
  effect,
  inject: (deps, callback) => { if (deps.includes('webServer')) callback({ webServer, effect }); return () => {}; },
  get: (name) => {
    if (name === 'systemPrompt') return { context: (entry) => { promptContexts.push(entry); return () => {}; } };
    if (name === 'agents') return { currentInitiator: () => currentAgent };
    if (name === 'sessions') return { get: (id) => (sessionCwds.has(id) ? { header: { cwd: sessionCwds.get(id) } } : undefined) };
    if (name === 'llm') return llmImpl || undefined;
    return undefined;
  },
  on: (event, handler) => { subscriptions.set(event, handler); return () => {}; },
};
apply(ctx);

const cwd = path.join(os.tmpdir(), 'lite-memory-contract-project');
fs.mkdirSync(cwd, { recursive: true });

const exec = (name, args) => defs.get(name).execute(args, { agent: { cwd, session: { id: 'session-contract', header: { cwd } } } });
const render = (name, args, value) => defs.get(name).output.render(args, value)[0].text;

function call(pathname, payload, options = {}) {
  const req = new EventEmitter();
  req.method = options.method ?? 'POST';
  req.url = pathname;
  req.headers = { origin: options.origin ?? ORIGIN };
  req.destroy = () => {};
  const res = {
    status: 0,
    text: '',
    writeHead(status) { this.status = status; },
    end(body) { this.text = body; this.finish(); },
  };
  const done = new Promise((resolve) => { res.finish = () => resolve(res); });
  route.handler(req, res);
  if (req.method === 'POST') {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }
  return done.then((value) => ({ status: value.status, body: JSON.parse(value.text || '{}') }));
}

const json = (body) => JSON.parse(body);

// ── tool contract ────────────────────────────────────────────────────────────
const names = ['memory_save', 'memory_suggest', 'memory_search', 'memory_read', 'memory_forget'];
assert.deepEqual([...defs.keys()].sort(), [...names].sort());
for (const name of names) {
  const def = defs.get(name);
  assert.equal(def.parameters.type, 'object');
  assert.equal(def.parameters.additionalProperties, false);
  assert.equal(typeof def.output.render, 'function');
  assert.equal(typeof def.output.schema, 'object');
  assert.ok(def.parameters.required.length >= 1);
}

const saveParams = defs.get('memory_save').parameters.properties;
/** 来源只能由服务端判定：参数里不存在可伪造成「用户明确要求」的字段。 */
for (const key of ['source', 'origin', 'confirmed', 'force', 'autoRecall']) {
  assert.equal(key in saveParams, false, `memory_save 不该接受 ${key}`);
}
assert.equal(saveParams.mode.enum.includes('replace_current'), true);
assert.equal(JSON.stringify(saveParams.applicability.enum), JSON.stringify(['all_in_scope', 'conditional', 'unresolved']));

assert.deepEqual(saveParams.resolution.enum, ['distinct']);
/** 一次检索最多回 4 条：列表是给下一步取正文用的，不是索引。 */
assert.equal(defs.get('memory_search').parameters.properties.limit.maximum, 4);
assert.equal(saveParams.id.type, 'string');
assert.deepEqual(saveParams.scope.enum, ['auto', 'project', 'global']);
assert.equal(saveParams.memoryClass.type, 'string');
assert.deepEqual(saveParams.memoryClass.enum, ['personal_preference', 'project_fact', 'environment_fact', 'portable_procedure']);
assert.deepEqual(saveParams.durability.enum, ['durable', 'task']);
assert.deepEqual(saveParams.sameTopicAs.required, ['scope', 'id', 'revision']);
assert.equal(defs.get('memory_suggest').parameters.properties.scope, undefined);
assert.equal(defs.get('memory_suggest').parameters.properties.resolution, undefined);

// ── save → render, then update ───────────────────────────────────────────────
const saved = await exec('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', body: '第一步' });
assert.equal(saved.needsResolution, false);
assert.equal(saved.merged, false);
assert.equal(saved.changed, true);
assert.equal(saved.scope, 'project');
// 「以后都用」这种措辞不带 scope 时落在项目层，不会自动升级成全局偏好
const phrased = await exec('memory_save', { title: '以后都用这个一次性脚本', summary: '这个脚本只跑一次', body: 'bash run.sh' });
assert.equal(phrased.scope, 'project');
assert.equal(store.loadIndex(store.globalScope()).entries.some((item) => item.title === '以后都用这个一次性脚本'), false);

assert.equal(typeof saved.id, 'string');
assert.match(render('memory_save', {}, saved), /^memory · saved "发布顺序" · mem_[a-z0-9]+ · 第 1 版$/);

const merged = await exec('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', body: '第一步\n第二步' });
assert.equal(merged.merged, true);
assert.equal(merged.id, saved.id);
assert.equal(merged.revision, 2);
assert.match(render('memory_save', {}, merged), /^memory · merged "发布顺序" · mem_[a-z0-9]+ · 第 2 版$/);

const patch = await exec('memory_save', { id: saved.id, title: '发布顺序', summary: '发版前要按顺序做的事', when: '发版当天' });
assert.equal(patch.when, '发版当天');
assert.match(render('memory_save', {}, patch), /（发版当天）/);

/** 同样的字段再存一次不算修改：不改版次，也不该被读成「存过一次」。 */
const again = await exec('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', when: '发版当天' });
assert.equal(again.changed, false);
assert.equal(again.id, saved.id);
assert.equal(again.revision, 3);
assert.match(render('memory_save', {}, again), /^memory · unchanged "发布顺序" · mem_[a-z0-9]+ · 第 3 版$/);

// ── similar title asks before overwriting ────────────────────────────────────
const probe = await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '另一条' });
assert.equal(probe.needsResolution, true);
assert.equal(probe.id, '');
assert.equal(probe.revision, 0);
assert.ok(probe.similarIds.length > 0);
const probeText = render('memory_save', {}, probe);
assert.match(probeText.split('\n')[0], /^memory · 需要确认：「发布顺序是啥」与已有条目相近$/);
assert.match(probeText, /要更新它，用 id 重存/);
assert.match(probeText, new RegExp(saved.id));
const distinct = await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '另一条', resolution: 'distinct' });
assert.equal(distinct.needsResolution, false);
assert.equal(distinct.merged, false);
assert.notEqual(distinct.id, saved.id);

// ── search / read / forget ───────────────────────────────────────────────────
const hits = await exec('memory_search', { query: '发布流程' });
assert.ok(hits.count >= 1);
assert.ok(hits.chars > 0);
const hitText = render('memory_search', {}, hits);
assert.match(hitText, new RegExp(`^memory · 命中 ${hits.count} 条 · 引用 ${hits.chars} 字\\n- mem_`));
assert.match(hitText, /第 3 版/);
const miss = await exec('memory_search', { query: '完全没有出现过的主题' });
assert.equal(miss.count, 0);
assert.equal(render('memory_search', {}, miss), 'memory · 没有命中');

const read = await exec('memory_read', { id: saved.id });
assert.equal(read.body, '第一步\n第二步');
assert.equal(read.revision, 3);
assert.match(render('memory_read', {}, read), new RegExp(`^memory · 「发布顺序」（发版当天） · ${saved.id} · 第 3 版`));

// 没点明归档还是彻底忘掉时不动盘，先返回待确认
const undecided = await exec('memory_forget', { id: distinct.id });
assert.equal(undecided.mode, 'needs_resolution');
assert.match(render('memory_forget', {}, undecided), new RegExp(`^memory · 先确认是归档还是彻底忘掉 · ${distinct.id}$`));
assert.ok(store.locate(store.scopeOf(cwd), distinct.id));
const archived = await exec('memory_forget', { id: distinct.id, mode: 'archive' });
assert.equal(archived.id, distinct.id);
assert.match(render('memory_forget', {}, archived), new RegExp(`^memory · archived "发布顺序是啥" · ${distinct.id}，可找回$`));
assert.equal(await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '第三条' }).then((v) => v.merged), false);

// ── suggestion → keep → replay → reject ──────────────────────────────────────
const suggested = await exec('memory_suggest', { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint', body: 'node ui-copy-lint.mjs', when: '发布前' });
assert.equal(suggested.asked, true);
assert.match(suggested.id, /^sug_[a-z0-9]+$/);
assert.match(render('memory_suggest', {}, suggested), /^memory · suggested "发布前跑文案检查" · sug_[a-z0-9]+$/);

const duplicate = await exec('memory_suggest', { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint' });
assert.equal(duplicate.asked, false);
assert.match(render('memory_suggest', {}, duplicate), /^memory · skipped\n48 小时内已经建议过一条$/);

const kept = await call('/lite-memory/keep', { op: 'keep', candidateId: suggested.id, operationId: 'op_contract', cwd });
assert.equal(kept.status, 200);
assert.equal(kept.body.ok, true);
assert.equal(kept.body.mode, 'created');
const stored = store.search(store.scopeOf(cwd), '发布前跑文案检查')[0];
assert.equal(stored.when, '发布前');
assert.equal(store.readEntry(store.scopeOf(cwd), stored.id).body, 'node ui-copy-lint.mjs');

const replay = await call('/lite-memory/keep', { op: 'keep', candidateId: suggested.id, operationId: 'op_contract', cwd });
assert.equal(replay.status, 200);
assert.equal(replay.body.replay, true);
assert.equal(replay.body.id, kept.body.id);
const reused = await call('/lite-memory/keep', { op: 'keep', candidateId: suggested.id, operationId: 'op_contract_other', cwd });
assert.equal(reused.status, 404);
assert.equal(reused.body.ok, false);

const scope = store.scopeOf(cwd);
const reset = store.loadIndex(scope);
reset.lastSuggestedAt = '';
store.saveIndex(scope, reset);
const another = await exec('memory_suggest', { title: '另一条待确认建议', summary: '用来测试拒绝的候选' });
assert.equal(another.asked, true);
const rejected = await call('/lite-memory/reject', { op: 'reject', candidateId: another.id, cwd });
assert.equal(rejected.status, 200);
assert.equal(rejected.body.ok, true);

// ── undo by id; old title-based payloads are refused ─────────────────────────
const undoRevision = store.readEntry(store.scopeOf(cwd), kept.body.id).revision;
assert.equal((await call('/lite-memory/undo', { op: 'undo', id: kept.body.id, cwd })).status, 400);
const undone = await call('/lite-memory/undo', { op: 'undo', id: kept.body.id, revision: undoRevision, cwd });
assert.equal(undone.status, 200);
assert.equal(undone.body.mode, 'archived');
assert.equal(store.loadIndex(store.scopeOf(cwd)).entries.some((entry) => entry.id === kept.body.id), false);
const byTitle = await call('/lite-memory/undo', { op: 'undo', title: '发布顺序', cwd });
assert.equal(byTitle.status, 400);
const missing = await call('/lite-memory/undo', { op: 'undo', id: 'mem_000000000000', cwd });
assert.equal(missing.status, 404);

// ── route guards ─────────────────────────────────────────────────────────────
assert.equal((await call('/lite-memory/keep', { candidateId: 'sug_000000', cwd }, { origin: 'http://evil.example' })).status, 403);
assert.equal((await call('/lite-memory/keep', { candidateId: 'sug_000000' })).status, 400);
assert.equal((await call('/lite-memory/keep', { cwd })).status, 400);
assert.equal((await call('/lite-memory/undo', { cwd })).status, 400);
assert.equal((await call('/lite-memory/unknown', { cwd })).status, 404);
assert.equal((await call('/lite-memory/keep', {}, { method: 'GET' })).status, 405);

// ── global layer ─────────────────────────────────────────────────────────────
const global = await exec('memory_save', { title: '回复用中文', summary: '用户要求回复用中文', scope: 'global' });
assert.equal(global.scope, 'global');
assert.match(render('memory_save', {}, global), /^memory · saved \[全局\] "回复用中文" · mem_[a-z0-9]+ · 第 1 版$/);
const globalSearch = await exec('memory_search', { query: '回复用中文' });
assert.equal(globalSearch.count, 1);
assert.match(render('memory_search', {}, globalSearch), /\[全局\] mem_/);
assert.equal(typeof globalThis.__liteMemoryStats, 'function');
const stats = globalThis.__liteMemoryStats(cwd);
assert.ok(stats.count >= 1);

// ── 引用条：会话读过哪几条，点开能拿到正文 ───────────────────────────────────
const cited = await exec('memory_save', { title: '引用测试', summary: '底部引用条要能点开正文', body: '引用正文第一行' });
await exec('memory_read', { id: cited.id });
const cites = await call('/lite-memory/citations', { sessionId: 'session-contract' });
assert.equal(cites.status, 200);
assert.ok(cites.body.items.some((item) => item.id === cited.id && item.title === '引用测试'));
assert.equal(cites.body.items.some((item) => 'path' in item), false);
const opened = await call('/lite-memory/body', { sessionId: 'session-contract', id: cited.id });
assert.equal(opened.status, 200);
assert.match(opened.body.body, /引用正文第一行/);
assert.equal(opened.body.scopeLabel, path.basename(cwd));
const gone = await call('/lite-memory/body', { sessionId: 'session-contract', id: 'mem_999999999999' });
assert.equal(gone.status, 200);
assert.equal(gone.body.status, 'gone');
assert.equal('title' in gone.body, false);
/** 别的会话、别的工作目录都不能拿 id 探正文；本会话引用过或本目录这一层才行。 */
const foreignSession = await call('/lite-memory/body', { sessionId: 'session-contract-2', id: cited.id });
assert.equal(foreignSession.status, 200);
assert.equal(foreignSession.body.status, 'gone');
assert.equal('body' in foreignSession.body, false);
const viaCwd = await call('/lite-memory/body', { cwd, id: cited.id });
assert.equal(viaCwd.status, 200);
assert.match(viaCwd.body.body, /引用正文第一行/);
const foreignCwd = await call('/lite-memory/body', { cwd: path.join(os.tmpdir(), 'lite-memory-contract-foreign'), id: cited.id });
assert.equal(foreignCwd.body.status, 'gone');
assert.equal((await call('/lite-memory/body', { id: cited.id })).status, 400);
assert.equal((await call('/lite-memory/citations', {})).status, 400);
assert.equal((await call('/lite-memory/citations', {}, { origin: 'http://evil.example' })).status, 403);
assert.notEqual((await call('/lite-memory/citations', { sessionId: 'session-contract' }, { origin: 'dsh-app://app' })).status, 403);
assert.notEqual((await call('/lite-memory/keep', { candidateId: 'sug_000000', cwd }, { origin: 'dsh-app://app' })).status, 403);
assert.equal((await call('/lite-memory/citations', {}, { method: 'GET' })).status, 405);

// ── 项目实验开关：每个项目各自一份，默认关闭，切换不碰别的项目 ─────────────────
const evoCwd = path.join(os.tmpdir(), 'lite-memory-contract-evolution');
const evoOther = path.join(os.tmpdir(), 'lite-memory-contract-evolution-other');
fs.mkdirSync(evoCwd, { recursive: true });
fs.mkdirSync(evoOther, { recursive: true });
sessionCwds.set('session-evo', evoCwd);
sessionCwds.set('session-evo-other', evoOther);
const evoOff = await call('/lite-memory/evolution', { sessionId: 'session-evo' });
assert.equal(evoOff.status, 200);
assert.equal(evoOff.body.ok, true);
assert.equal(evoOff.body.enabled, false);
assert.equal(evoOff.body.compatible, true);
assert.equal(evoOff.body.project, path.basename(evoCwd));
const evoOn = await call('/lite-memory/evolution', { sessionId: 'session-evo', enabled: true, operationId: 'op_evo_on' });
assert.equal(evoOn.status, 200);
assert.equal(evoOn.body.enabled, true);
assert.equal(evoOn.body.changed, true);
assert.notEqual(evoOn.body.epoch, evoOff.body.epoch);
const evoStatus = await call('/lite-memory/evolution', { sessionId: 'session-evo' });
assert.equal(evoStatus.body.enabled, true);
const evoSnapshot = await call('/lite-memory/evolution', { sessionId: 'session-evo', learningAction: 'snapshot' });
assert.equal(evoSnapshot.status, 200);
assert.equal(Array.isArray(evoSnapshot.body.rules), true);
assert.equal(typeof evoSnapshot.body.counts.active, 'number');
assert.equal(evoSnapshot.body.payload.bytes, null);
assert.equal(evoSnapshot.body.economy.inputTokens, null);
const evoOtherStatus = await call('/lite-memory/evolution', { sessionId: 'session-evo-other' });
assert.equal(evoOtherStatus.body.enabled, false);
const evoStateFile = path.join(store.scopeOf(evoCwd).dir, 'state.json');
const evoDisk = JSON.parse(fs.readFileSync(evoStateFile, 'utf8'));
assert.equal(evoDisk.format, 'dsh-lite-memory/state@4');
assert.equal(evoDisk.payload.experimental.projectEvolution.enabled, true);
const evoOffAgain = await call('/lite-memory/evolution', { sessionId: 'session-evo', enabled: false });
assert.equal(evoOffAgain.body.enabled, false);
assert.equal(evoOffAgain.body.compatible, true);
assert.equal((await call('/lite-memory/evolution', {})).status, 400);
assert.equal((await call('/lite-memory/evolution', { sessionId: 'session-evo' }, { origin: 'http://evil.example' })).status, 403);
// 身份拿不准时拒绝写，也不拿进程 cwd 顶替
const evoUnknown = path.join(os.tmpdir(), 'lite-memory-contract-evolution-unknown');
fs.mkdirSync(evoUnknown, { recursive: true });
const savedPath = process.env.PATH;
process.env.PATH = '';
sessionCwds.set('session-evo-unknown', evoUnknown);
const evoUnconfirmed = await call('/lite-memory/evolution', { sessionId: 'session-evo-unknown', enabled: true });
process.env.PATH = savedPath;
assert.equal(evoUnconfirmed.status, 409);
assert.equal(evoUnconfirmed.body.confirmed, false);
assert.equal(fs.existsSync(path.join(store.scopeOf(evoUnknown).dir, 'state.json')), false);

// ── 自动召回：只在这句话跟已有记忆有关时出现，且不改命中计数 ─────────────────
const hinted = await exec('memory_save', { title: 'Chrome 弹钥匙串窗口要带 mock keychain', summary: '临时 profile 起 Chrome 会弹钥匙串窗口' });
// 只有一句 when、没有结构化条件的条目属于未解决，不自动注入
await exec('memory_save', { title: '发布窗口在周四晚上', summary: '只在周四晚上发版', when: '周四晚上' });
const recallAgent = { id: 'session-contract', cwd, session: { id: 'session-recall', header: { cwd } } };
currentAgent = recallAgent;
const preStep = subscriptions.get('agent/pre-step');
assert.equal(typeof preStep, 'function');
const pass = (text, id) => async () => ({
  kind: 'enter',
  messages: [{ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text }] }],
});
const recall = promptContexts.find((entry) => entry.name === 'lite-memory:recall');
assert.ok(recall, 'recall context registered');
assert.equal(recall.order, 60);
assert.equal(recall.interpolate, false);
assert.equal(recall.required, false);

const sig1 = new AbortController().signal;
const hitsBefore = store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.id === hinted.id).hits;
await preStep({ agent: recallAgent, signal: sig1, turn: '2' }, pass('又弹钥匙串窗口了，怎么弄', 'h1'));
const hintText = recall.text({ agent: recallAgent, signal: sig1 });
assert.match(hintText, new RegExp(hinted.id));
assert.match(hintText, /需要细节用 memory_read/);
const hitsAfter = store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.id === hinted.id).hits;
assert.equal(hitsAfter, hitsBefore);

const sig2 = new AbortController().signal;
await preStep({ agent: recallAgent, signal: sig2, turn: '3' }, pass('周四晚上发版要注意什么', 'h2'));
assert.equal(recall.text({ agent: recallAgent, signal: sig2 }).includes('发布窗口在周四晚上'), false);

const sig3 = new AbortController().signal;
await preStep({ agent: recallAgent, signal: sig3, turn: '4' }, pass('把这个按钮的圆角改小一点', 'h3'));
assert.equal(recall.text({ agent: recallAgent, signal: sig3 }), '');
assert.equal(subscriptions.has('agent/disposed'), true);

// ── 项目实验：宿主事件顺序下由最终人类消息决定读取 ───────────────────────────
const evoReadCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-evo-read-'));
sessionCwds.set('session-evo-read', evoReadCwd);
const evoReadOn = await call('/lite-memory/evolution', { sessionId: 'session-evo-read', enabled: true });
assert.equal(evoReadOn.status, 200);
assert.equal(evoReadOn.body.enabled, true);
const evoReadScope = store.scopeOf(evoReadCwd);
const evoAgentSeed = { id: 'session-evo-read', cwd: evoReadCwd, session: { id: 'session-evo-read', header: { cwd: evoReadCwd } } };
const evoRule = await defs.get('memory_save').execute(
  { title: '口播开头', summary: '口播开头三句内给结论', body: '开场三句内给结论。' },
  { agent: evoAgentSeed },
);
state.transact(evoReadScope, {}, (draft) => {
  const row = draft.entries.find((entry) => entry.id === evoRule.id);
  row.origin = 'project_evolution';
  row.current.conditions = [{ key: 'seriesId', value: '口播' }];
  row.maintenance = { ...(row.maintenance || {}), learning: { state: 'active', source: 'evolution' } };
  return { changed: true };
});
await store.setTaskDefault(evoReadScope, { seriesId: '口播' });

const evoAgent = { id: 'session-evo-read', cwd: evoReadCwd, session: { id: 'session-evo-read', header: { cwd: evoReadCwd } } };
currentAgent = evoAgent;
const evoSig = new AbortController().signal;
const evoEnter = async () => ({
  kind: 'enter',
  messages: [
    // 宿主可能先给出被拒/草稿消息，只有最终收下的 user 消息算新的人类输入
    { role: 'user', id: 'draft-1', source: { kind: 'synthetic' }, content: [{ type: 'text', text: '改做 README 文案' }] },
    { role: 'user', id: 'final-1', source: { kind: 'user' }, content: [{ type: 'text', text: '这期口播怎么开头' }] },
  ],
});
await preStep({ agent: evoAgent, signal: evoSig, turn: '21' }, evoEnter);
const evoRecall = promptContexts.find((entry) => entry.name === 'lite-memory:recall');
assert.match(evoRecall.text({ agent: evoAgent, signal: evoSig }), /开场三句内给结论/);
assert.equal(evoRecall.text({ agent: evoAgent, signal: evoSig }).includes('README'), false);

// 工具续步没有新人类消息：沿用本批快照，交给 refreshContext 的是同一份内容
await preStep({ agent: evoAgent, signal: evoSig, turn: '21' }, async () => ({ kind: 'enter', messages: [] }));
assert.match(evoRecall.text({ agent: evoAgent, signal: evoSig }), /开场三句内给结论/);

// 事件确实触发：本回合停止后快照立即失效，下一批必须重新算
const stopping = subscriptions.get('agent/turn-stopping');
assert.equal(typeof stopping, 'function');
stopping({ turn: '21', signal: evoSig });
assert.equal(evoRecall.text({ agent: evoAgent, signal: evoSig }), '');

// 管理面：读当前项目的成果和上次载荷，删除按看到的版本
const evoManage = await call('/lite-memory/evolution', { sessionId: 'session-evo-read', learningAction: 'snapshot' });
assert.equal(evoManage.status, 200);
assert.equal(evoManage.body.rules.length, 1);
assert.equal(evoManage.body.rules[0].id, evoRule.id);
assert.ok(evoManage.body.payload.bytes > 0);
const evoDeleteStale = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'delete', id: evoRule.id, expectedRevision: evoManage.body.rules[0].revision - 1,
});
assert.equal(evoDeleteStale.status, 409);
const evoDelete = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'delete', id: evoRule.id, expectedRevision: evoManage.body.rules[0].revision,
});
assert.equal(evoDelete.status, 200);
assert.equal(evoDelete.body.ok, true);

// ── 界面只吃持久元数据，不猜文案 ─────────────────────────────────────────────
const metaOf = (name, args, value) => defs.get(name).output.presentationMeta(args, value);
const savedMeta = metaOf('memory_save', {}, saved);
assert.equal(savedMeta.kind, 'memory-save');
assert.equal(savedMeta.id, saved.id);
assert.equal(savedMeta.title, '发布顺序');
assert.equal(savedMeta.changed, true);
assert.ok(['created', 'updated'].includes(savedMeta.mode));
assert.equal('path' in savedMeta, false);
const searchMeta = metaOf('memory_search', {}, globalSearch);
assert.deepEqual(Object.keys(searchMeta.refs[0]).sort(), ['id', 'origin', 'revision', 'scope', 'status', 'title']);
assert.equal(searchMeta.refs[0].id, global.id);
const readValue = await exec('memory_read', { id: global.id });
const readMeta = metaOf('memory_read', {}, readValue);
assert.equal(readMeta.kind, 'memory-read');
assert.equal(readMeta.title, '回复用中文');
assert.equal(readMeta.revision, 1);
const suggestValue = await exec('memory_suggest', { title: '元数据建议', summary: '建议行只认元数据里的候选 id' });
const suggestMeta = metaOf('memory_suggest', {}, suggestValue);
assert.equal(suggestMeta.kind, 'memory-suggest');
assert.equal(typeof suggestMeta.asked, 'boolean');
assert.equal('path' in suggestMeta, false);
if (suggestMeta.asked === true) assert.match(suggestMeta.id, /^sug_[a-z0-9]+$/);

// ── 撤销带着当时的版本：过期就冲突，不覆盖后来的修改 ─────────────────────────
const guarded = await exec('memory_save', { title: '版本守卫', summary: '撤销要带当时版本' });
await exec('memory_save', { title: '版本守卫', summary: '撤销要带当时版本', body: '第二版正文' });
const stale = await call('/lite-memory/undo', { op: 'undo', id: guarded.id, revision: 1, cwd });
assert.equal(stale.status, 409);
const fresh = store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.id === guarded.id);
const accepted = await call('/lite-memory/undo', { op: 'undo', id: guarded.id, revision: fresh.revision, cwd });
assert.equal(accepted.status, 200);

// ── 第二组：确认前后语义一致、比较口径统一 ──────────────────────────────────
const cwd2 = path.join(os.tmpdir(), 'lite-memory-contract-project-2');
fs.mkdirSync(cwd2, { recursive: true });
const exec2 = (name, args) => defs.get(name).execute(args, { agent: { cwd: cwd2, session: { id: 'session-contract-2', header: { cwd: cwd2 } } } });
const projectScope = store.scopeOf(cwd2);
const projectEntries = () => store.loadIndex(projectScope).entries;

/** 建议时给的适用范围与条件，确认后必须原样落盘，不能因为过了一道待确认区就变成普遍适用。 */
const condSuggest = await exec2('memory_suggest', {
  title: '只在发布机跑冒烟',
  summary: '发布机上的冒烟检查命令',
  body: 'bash smoke.sh',
  when: '发布机上',
  scope: 'project',
  applicability: 'conditional',
  conditions: [{ key: 'machine', value: 'release-box' }],
  triggers: ['冒烟'],
});
assert.equal(condSuggest.asked, true, JSON.stringify(condSuggest));
const condKept = await call('/lite-memory/keep', { op: 'keep', candidateId: condSuggest.id, operationId: 'op_cond_keep', cwd: cwd2 });
assert.equal(condKept.status, 200);
const condRecord = projectEntries().find((item) => item.title === '只在发布机跑冒烟');
assert.ok(condRecord, '确认后应写入项目层');
assert.equal(condRecord.applicability, 'conditional');
assert.deepEqual(condRecord.conditions, [{ key: 'machine', value: 'release-box' }]);
assert.deepEqual(condRecord.triggers, ['冒烟']);

/** 只改摘要不该把原来有条件的规则放宽成普遍适用。 */
const narrow = await exec2('memory_save', {
  title: 'windows 上跑构建',
  summary: 'windows 构建命令',
  body: 'pnpm build',
  when: 'windows 上',
  scope: 'project',
  applicability: 'conditional',
  conditions: [{ key: 'targetOs', value: 'windows' }],
});
assert.equal(narrow.changed, true);
const narrowed = await exec2('memory_save', { id: narrow.id, title: 'windows 上跑构建', summary: 'windows 构建用这条命令' });
assert.equal(narrowed.changed, true);
const narrowRecord = projectEntries().find((item) => item.id === narrow.id);
assert.equal(narrowRecord.applicability, 'conditional');
assert.deepEqual(narrowRecord.conditions, [{ key: 'targetOs', value: 'windows' }]);

/** 同名但机器条件不同是两条规则：新的一条不能覆盖旧的一条。 */
const boxA = await exec2('memory_save', {
  title: '冒烟顺序',
  summary: '冒烟按这个顺序跑',
  body: '先登录再下单',
  when: '冒烟时',
  scope: 'project',
  applicability: 'conditional',
  conditions: [{ key: 'machine', value: 'box-a' }],
});
assert.equal(boxA.changed, true);
const boxB = await exec2('memory_save', {
  title: '冒烟顺序',
  summary: '冒烟按这个顺序跑',
  body: '先建号再登录',
  when: '冒烟时',
  scope: 'project',
  applicability: 'conditional',
  conditions: [{ key: 'machine', value: 'box-b' }],
});
assert.equal(boxB.changed, true);
assert.notEqual(boxB.id, boxA.id);
const bothBoxes = projectEntries().filter((item) => item.title === '冒烟顺序' && item.status === 'active');
assert.equal(bothBoxes.length, 2);
assert.deepEqual(bothBoxes.map((item) => item.conditions[0].value).sort(), ['box-a', 'box-b']);
assert.equal(bothBoxes.find((item) => item.id === boxA.id).body, '先登录再下单');

/** 同一主题、条件一致但正文不同：读取要报冲突，不能悄悄挑一条当现行规范。 */
const slotA = await exec2('memory_save', {
  title: '发版检查项',
  summary: '发版前检查的固定清单',
  body: '第一步：跑 lint',
  scope: 'project',
  applicability: 'all_in_scope',
  topicKey: '发版检查',
  resolution: 'distinct',
});
const slotB = await exec2('memory_save', {
  title: '发版检查项',
  summary: '发版前检查的固定清单',
  body: '第一步：跑单测',
  scope: 'project',
  applicability: 'all_in_scope',
  topicKey: '发版检查',
  resolution: 'distinct',
});
assert.notEqual(slotA.id, slotB.id);
const resolvedSlots = store.visibleRules(projectScope, {}).resolved;
const slotRow = [...resolvedSlots.values()].find((row) => row.key === '发版检查');
assert.ok(slotRow);
assert.equal(slotRow.status, 'conflict');

/** 工具参数里的 links / selection.items / topicKey:null 是合法输入，不能被 schema 挡掉或被校验器拒绝。 */
assert.equal(saveParams.links.items.type, 'object');
assert.deepEqual(saveParams.links.items.required, ['id']);
assert.equal(saveParams.selection.properties.items.type, 'array');
assert.deepEqual(saveParams.topicKey.type, ['string', 'null']);
const linkedA = await exec2('memory_save', { title: '关联目标甲', summary: '用来当关联目标', body: '甲', scope: 'project' });
const linkedB = await exec2('memory_save', {
  title: '关联目标乙',
  summary: '带关联的那条',
  body: '乙',
  scope: 'project',
  resolution: 'distinct',
  links: [{ type: 'related', id: linkedA.id }],
});
assert.equal(linkedB.changed, true, JSON.stringify(linkedB));
const linkedRecord = projectEntries().find((item) => item.id === linkedB.id);
assert.equal(linkedRecord.links.length, 1);
assert.equal(linkedRecord.links[0].id, linkedA.id);
assert.equal(linkedRecord.links[0].type, 'related');


// ── 项目实验：正常回合结束后走一次短整理，只写后台结果 ─────────────────────────
const orgCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-organize-'));
sessionCwds.set('session-organize', orgCwd);
const orgOn = await call('/lite-memory/evolution', { sessionId: 'session-organize', enabled: true });
assert.equal(orgOn.status, 200);
const orgScope = store.scopeOf(orgCwd);
await store.setTaskDefault(orgScope, { taskKind: 'video', seriesId: '口播' });
let orgOptions = null;
let orgPrepare = null;
let orgMode = 'new';
llmImpl = {
  prepareCall: async (config, signal) => {
    orgPrepare = { config, signal };
    return {
      config: { provider: 'deepseek', model: 'chat' },
      stream: async function* (options) {
        orgOptions = options;
        const prompt = options.messages[0].content[0].text;
        const ref = (prompt.match(/"ref":"(r\d+)"/) || [])[1] || 'r0';
        const change = orgMode === 'checkpoint'
          ? { target: ref, feedbackType: 'execution_miss', currentText: '交付前先核对开头是否先给结论。', evidence: ['u0'], persistence: 'project_candidate' }
          : orgMode === 'sample'
            ? { target: ref, feedbackType: 'artifact_accept', evidence: ['u0'], persistence: 'project_candidate' }
            : { target: 'new', feedbackType: 'spec_change', topicKey: '开头', currentText: '开头先给结论。', applicability: 'all_in_scope', conditions: [], evidence: ['u0'], persistence: 'project_candidate' };
        yield { type: 'text-delta', text: JSON.stringify({ changes: [change] }) };
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
  },
};
const orgAgent = { id: 'session-organize', cwd: orgCwd, session: { id: 'session-organize', header: { id: 'session-organize', cwd: orgCwd }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }) } };
currentAgent = orgAgent;
const orgSig = new AbortController().signal;
await preStep({ agent: orgAgent, signal: orgSig, turn: '31' }, async () => ({
  kind: 'enter',
  messages: [{ role: 'user', id: 'org-m1', source: { kind: 'user' }, content: [{ type: 'text', text: '以后开头先给结论，别再铺垫。' }] }],
}));
assert.equal(store.learningSnapshot(orgScope).rules.length, 0);
const orgTurnEnd = subscriptions.get('session/event');
assert.equal(typeof orgTurnEnd, 'function');
orgTurnEnd(orgAgent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
for (let i = 0; i < 100 && store.learningSnapshot(orgScope).rules.length === 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const orgRules = store.learningSnapshot(orgScope).rules;
assert.equal(orgRules.length, 1);
assert.equal(orgRules[0].body, '开头先给结论。');
assert.equal(orgRules[0].state, 'active');
assert.equal(orgPrepare.config.maxTokens, 768);
assert.equal(orgOptions.purpose, 'project-evolution');
assert.equal('tools' in orgOptions, false);
assert.equal(orgOptions.sessionId, 'session-organize');
assert.equal(orgRules[0].origin, 'project_evolution');
const orgEconomy = store.learningSnapshot(orgScope).economy;
assert.equal(orgEconomy.calls, 1);
assert.equal(orgEconomy.knownCalls, 1);
assert.equal(orgEconomy.inputTokens, 12);

/** 第二步：执行没做到，后台只补检查点；主持人新开一版也不改正文。 */
orgMode = 'checkpoint';
await preStep({ agent: orgAgent, signal: orgSig, turn: '32' }, async () => ({
  kind: 'enter',
  messages: [{ role: 'user', id: 'org-m2', source: { kind: 'user' }, content: [{ type: 'text', text: '之前说过开头先给结论，这次怎么又没做到。' }] }],
}));
orgTurnEnd(orgAgent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
const orgRuleId = store.learningSnapshot(orgScope).rules[0].id;
const orgFlat = () => store.loadIndex(orgScope).entries.find((row) => row.id === orgRuleId);
for (let i = 0; i < 100 && !(orgFlat()?.learning?.checkpoints || []).length; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(orgFlat().body, '开头先给结论。');
assert.equal((orgFlat().learning.checkpoints || []).length, 1);
assert.match(orgFlat().learning.checkpoints[0].text, /核对/);
assert.equal(orgFlat().learning.state, 'active');
assert.equal(orgFlat().learning.evidence.length, 1);

/** 第三步：另一期作品认可这个开头，只记一条有版本、有维度的样例。 */
sessionCwds.set('session-organize-2', orgCwd);
const orgScope2 = orgScope;
orgMode = 'sample';
const orgAgent2 = { id: 'session-organize-2', cwd: orgCwd, session: { id: 'session-organize-2', header: { id: 'session-organize-2', cwd: orgCwd }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }) } };
currentAgent = orgAgent2;
await preStep({ agent: orgAgent2, signal: orgSig, turn: '41' }, async () => ({
  kind: 'enter',
  messages: [{ role: 'user', id: 'org-m3', source: { kind: 'user' }, content: [{ type: 'text', text: '这版可以，开头这样就行。' }] }],
}));
orgMode = 'sample';
orgTurnEnd(orgAgent2.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
const orgRule2 = () => store.loadIndex(orgScope2).entries.find((row) => row.origin === 'project_evolution');
for (let i = 0; i < 100 && !(orgRule2()?.learning?.samples || []).length; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(orgRule2().body, '开头先给结论。');
assert.equal((orgRule2().learning.samples || []).length, 1);
assert.equal(orgRule2().learning.samples[0].dimension, '开头');
assert.equal(orgRule2().learning.samples[0].verified, false);
assert.ok(orgRule2().learning.samples[0].artifactVersion);
const orgSnapshot2 = await call('/lite-memory/evolution', { sessionId: 'session-organize-2', learningAction: 'snapshot' });
assert.equal(orgSnapshot2.status, 200);
assert.equal(orgSnapshot2.body.rules.length, 1);
assert.equal(orgSnapshot2.body.rules[0].samples.length, 1);
assert.equal(orgSnapshot2.body.rules[0].checkpoints.length, 1);
const orgEconomy2 = store.learningSnapshot(orgScope2).economy;
assert.equal(orgEconomy2.calls, 3);
assert.equal(orgEconomy2.knownCalls, 3);
assert.equal(orgEconomy2.inputTokens, 36);
llmImpl = null;

console.log('contract.test.mjs: all passed');
