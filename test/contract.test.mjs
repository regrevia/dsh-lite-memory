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

/** 按已注册的 output.schema 校验真实 execute 结果：宿主校验失败会整条工具报错。 */
function assertSchema(name, value) {
  const schema = defs.get(name).output.schema;
  const walk = (node, data, where) => {
    if (node.type === 'object') {
      assert.ok(data && typeof data === 'object' && !Array.isArray(data), `${where} 应为对象`);
      for (const key of node.required || []) assert.ok(key in data, `${where} 缺少 ${key}`);
      for (const [key, item] of Object.entries(data)) {
        if (node.properties && node.properties[key]) walk(node.properties[key], item, `${where}.${key}`);
        else assert.equal(node.additionalProperties, true, `${where} 多出 ${key}`);
      }
    } else if (node.type === 'array') {
      assert.ok(Array.isArray(data), `${where} 应为数组`);
      if (node.items) data.forEach((item, index) => walk(node.items, item, `${where}[${index}]`));
    } else if (node.type === 'string') assert.equal(typeof data, 'string', `${where} 应为字符串`);
    else if (node.type === 'boolean') assert.equal(typeof data, 'boolean', `${where} 应为布尔值`);
    else if (node.type === 'integer') assert.ok(Number.isInteger(data), `${where} 应为整数`);
    else if (node.type === 'number') assert.equal(typeof data, 'number', `${where} 应为数字`);
    if (node.enum) assert.ok(node.enum.includes(data), `${where} 不在枚举里`);
  };
  walk(schema, value, name);
}

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
const names = ['memory_save', 'memory_suggest', 'memory_search', 'memory_read', 'memory_forget', 'memory_persona'];
assert.deepEqual([...defs.keys()].sort(), [...names].sort());
const TITLE_ADDRESSED = ['memory_read', 'memory_forget'];
for (const name of names) {
  const def = defs.get(name);
  assert.equal(def.parameters.type, 'object');
  assert.equal(def.parameters.additionalProperties, false);
  assert.equal(typeof def.output.render, 'function');
  assert.equal(typeof def.output.schema, 'object');
  assert.ok(Object.keys(def.parameters.properties).length >= 1);
  if (TITLE_ADDRESSED.includes(name)) assert.equal('title' in def.parameters.properties, true, `${name} 按标题定位`);
}

const saveParams = defs.get('memory_save').parameters.properties;
/** 来源只能由服务端判定：参数里不存在可伪造成「用户明确要求」的字段。 */
for (const key of ['source', 'origin', 'confirmed', 'force', 'autoRecall']) {
  assert.equal(key in saveParams, false, `memory_save 不该接受 ${key}`);
}
assert.equal(saveParams.mode.enum.includes('replace_current'), true);
/** 关联目标也按标题给，参数里不该出现 mem_ 开头的 id 字段。 */
assert.equal(saveParams.links.items.properties.id, undefined);
assert.equal(saveParams.links.items.properties.title.type, 'string');
assert.equal(JSON.stringify(saveParams.applicability.enum), JSON.stringify(['all_in_scope', 'conditional', 'unresolved']));

assert.deepEqual(saveParams.resolution.enum, ['distinct']);
/** 一次检索最多回 4 条：列表是给下一步取正文用的，不是索引。 */
assert.equal(defs.get('memory_search').parameters.properties.limit.maximum, 4);
/** 空检索结果会带 noTriggerReason，输出 schema 必须声明它，否则宿主校验直接报错。 */
assert.equal(defs.get('memory_search').output.schema.properties.noTriggerReason.type, 'string');
/** 更新句柄只暴露标题：id 是底层实现，参数表里不该出现。 */
assert.equal(saveParams.updateTitle.type, 'string');
assert.equal(saveParams.id, undefined);
assert.deepEqual(saveParams.scope.enum, ['auto', 'project', 'global']);
assert.equal(saveParams.memoryClass.type, 'string');
assert.deepEqual(saveParams.memoryClass.enum, ['personal_preference', 'project_fact', 'environment_fact', 'portable_procedure']);
assert.deepEqual(saveParams.durability.enum, ['durable', 'task']);
assert.deepEqual(saveParams.sameTopicAs.required, ['scope', 'title']);
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

assert.equal(typeof saved.title, 'string');
assert.equal(saved.id, undefined);
assert.match(render('memory_save', {}, saved), /^memory · saved \[[^\]]+\] "发布顺序"$/);

const merged = await exec('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', body: '第一步\n第二步' });
assert.equal(merged.merged, true);
assert.equal(merged.title, saved.title);
assert.equal(merged.revision, 2);
assert.match(render('memory_save', {}, merged), /^memory · merged \[[^\]]+\] "发布顺序"$/);

const patch = await exec('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', when: '发版当天' });
assert.equal(patch.when, '发版当天');
assert.match(render('memory_save', {}, patch), /（发版当天）/);

/** 同样的字段再存一次不算修改：不改版次，也不该被读成「存过一次」。 */
const again = await exec('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', when: '发版当天' });
assert.equal(again.changed, false);
assert.equal(again.title, saved.title);
assert.equal(again.revision, 3);
assert.match(render('memory_save', {}, again), /^memory · unchanged \[[^\]]+\] "发布顺序"$/);

// ── similar title asks before overwriting ────────────────────────────────────
const probe = await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '另一条' });
assert.equal(probe.needsResolution, true);
assert.equal(probe.id, undefined);
assert.equal(probe.revision, 0);
assert.ok(probe.similarTitles.length > 0);
assert.doesNotMatch(probe.similarTitles, /mem_[a-z0-9]{6,}/, '相近候选按标题点名');
const probeText = render('memory_save', {}, probe);
assert.match(probeText.split('\n')[0], /^memory · 需要确认：「发布顺序是啥」与已有条目相近$/);
assert.match(probeText, /要更新它：用同一个标题再存一次/);
assert.match(probeText, /「发布顺序」/);
assert.doesNotMatch(probeText, /mem_[a-z0-9]{6,}/, '相近提示只给标题');
const distinct = await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '另一条', resolution: 'distinct' });
assert.equal(distinct.needsResolution, false);
assert.equal(distinct.merged, false);
assert.equal(distinct.id, undefined);
assert.notEqual(distinct.title, saved.title);
/** 刚存完就能查回来：不是只统计条数，命中的必须是刚存的那一条。 */
const justSaved = await exec('memory_search', { query: '发布顺序是啥' });
assert.ok(justSaved.count >= 1);
assert.match(render('memory_search', {}, justSaved), /「发布顺序是啥」/);

// ── search / read / forget ───────────────────────────────────────────────────
const hits = await exec('memory_search', { query: '发布流程' });
assert.ok(hits.count >= 1);
assert.ok(hits.chars > 0);
const hitText = render('memory_search', {}, hits);
assert.match(hitText, new RegExp(`^memory · 命中 ${hits.count} 条 · 引用 ${hits.chars} 字\\n- \\[[^\\]]+\\] 「`));
assert.doesNotMatch(hitText, /mem_[a-z0-9]{6,}/, '检索结果只给标题与适用范围');
assert.doesNotMatch(hitText, /第 .* 版/);
/** 用量只在真交付后才记：检索候选（尤其被预算/上限丢掉的那些）不算用过。 */
const contractScope = store.scopeOf(cwd);
await exec('memory_save', { title: '用量记账探针', summary: '只在交付后记 lastUsed', kind: 'note' });
const usedRow = () => store.loadIndex(contractScope).entries.find((item) => item.title === '用量记账探针');
const oldUse = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const probeId = usedRow().id;
state.transact(contractScope, {}, (draft) => {
  const row = draft.entries.find((item) => item.id === probeId);
  row.maintenance.lastUsed = oldUse;
  return { changed: true };
});
assert.equal(usedRow().lastUsed, oldUse);
const silent = store.search(contractScope, '用量记账探针', 50, { markUsed: false });
assert.ok(silent.length >= 1);
assert.equal(usedRow().lastUsed, oldUse, '候选检索不记 usage');
await exec('memory_search', { query: '用量记账探针' });
assert.notEqual(usedRow().lastUsed, oldUse, '真交付给模型后才记 usage');
/** 「发版当天」这类自由文本条件没有可信上下文，不能当成适用条目塞给模型。 */
const miss = await exec('memory_search', { query: '完全没有出现过的主题' });
assert.equal(miss.count, 0);
assert.equal(typeof miss.noTriggerReason, 'string');
assert.equal(render('memory_search', {}, miss), 'memory · 没有命中');

const read = await exec('memory_read', { title: saved.title });
assert.equal(read.status, 'needs_context');
assert.equal(read.body, '', '条件未知时标题只能定位，不能证明适用，正文不返回');
assert.doesNotMatch(render('memory_read', {}, read), /发版/);
assertSchema('memory_read', read);
const plain = await exec('memory_read', { title: distinct.title });
/** 工具写入的来源一路带到正文回执：界面靠它标 [模型]，不靠猜。 */
assert.equal(plain.origin, 'model_drafted');
assertSchema('memory_read', plain);
assert.equal(plain.body, '另一条');
assert.equal(plain.revision, 1);
assert.match(render('memory_read', {}, plain), /^memory · \[[^\]]+\] 「发布顺序是啥」/);
assert.ok(!render('memory_read', {}, plain).includes('mem_'));
assert.equal(plain.title, distinct.title);

/* 界面与工具文本一律不出现内部编号：id 只是存储地址。 */
for (const [name, value] of [['memory_save', saved], ['memory_save', merged], ['memory_save', patch],
  ['memory_search', hits], ['memory_read', plain], ['memory_save', probe]]) {
  assert.doesNotMatch(render(name, {}, value), /\b(mem|sug|cf)_[a-z0-9]{6,}/, `${name} 文案里没有内部编号`);
}

// 没点明归档还是彻底忘掉时不动盘，先返回待确认
const undecided = await exec('memory_forget', { title: distinct.title });
assert.equal(undecided.mode, 'needs_resolution');
assert.match(render('memory_forget', {}, undecided), /^memory · 先确认是归档还是彻底忘掉 · 「发布顺序是啥」$/);
const distinctRow = store.search(store.scopeOf(cwd), distinct.title).find((row) => row.title === distinct.title);
assert.ok(distinctRow);
assert.ok(store.locate(store.scopeOf(cwd), distinctRow.id));
const archived = await exec('memory_forget', { title: distinct.title, mode: 'archive' });
assert.equal(archived.title, distinct.title);
assert.equal(archived.id, undefined);
assert.match(render('memory_forget', {}, archived), /^memory · archived \[[^\]]+\] "发布顺序是啥"，可找回$/);
const readArchived = await exec('memory_read', { title: distinct.title });
assert.equal(readArchived.status, 'archived');
assert.equal(readArchived.body, '');
assert.match(render('memory_read', { title: distinct.title }, readArchived), /^memory · 这条记忆已归档$/);
assertSchema('memory_read', readArchived);
assert.equal(await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '第三条' }).then((v) => v.merged), false);

// ── 失败回执同样过输出 schema：不能再返裸 {error} 让界面渲染 undefined ──────────
await exec('memory_save', { title: '跨层同名', summary: '项目层这一条', body: '项目正文' });
/** 直接落全局层：正常保存有跨层相近拦截，同层/跨层同名只可能来自历史数据。 */
store.saveEntry(store.globalScope(), { title: '跨层同名', summary: '全局层另一条', body: '全局正文', writeMode: 'patch' });
/** 同名两层各有一条时，读哪条由 scope 决定：默认项目层，显式 global 才拿全局正文。 */
const readTwin = await exec('memory_read', { title: '跨层同名' });
assert.equal(readTwin.scope, 'project');
assert.equal(readTwin.body, '项目正文');
const readGlobalTwin = await exec('memory_read', { title: '跨层同名', scope: 'global' });
assert.equal(readGlobalTwin.scope, 'global');
assert.equal(readGlobalTwin.body, '全局正文');
const readProjectTwin = await exec('memory_read', { title: '跨层同名', scope: 'project' });
assert.equal(readProjectTwin.scope, 'project');
assert.equal(readProjectTwin.body, '项目正文');
const ambiguousSave = await exec('memory_save', { title: '别的标题', summary: '尝试改同名条目', updateTitle: '跨层同名' });
assert.ok(ambiguousSave.error, '跨层同名要报改哪一层');
assertSchema('memory_save', ambiguousSave);
assert.match(render('memory_save', {}, ambiguousSave), /^memory · /);
assert.doesNotMatch(render('memory_save', {}, ambiguousSave), /undefined|saved|merged/);
/** 同层同名不是「取第一条」：读、忘、更新都必须报歧义，按 id 仍能精确到条。 */
const twinScope = store.scopeOf(cwd);
const twinA = store.saveEntry(twinScope, { title: '同层重名探针', summary: '第一条', body: '正文甲', when: '机器甲', writeMode: 'patch' });
const twinB = store.saveEntry(twinScope, { title: '同层重名探针', summary: '第二条', body: '正文乙', when: '机器乙', writeMode: 'patch' });
const twinAId = twinA.record?.id ?? twinA.id;
const twinBId = twinB.record?.id ?? twinB.id;
assert.notEqual(twinAId, twinBId);
await assert.rejects(() => exec('memory_read', { title: '同层重名探针' }), /有 2 条同名/);
await assert.rejects(() => exec('memory_forget', { title: '同层重名探针', mode: 'archive' }), /有 2 条同名/);
const twinUpdate = await exec('memory_save', { title: '换个标题', summary: '尝试更新同名条目', updateTitle: '同层重名探针' });
assert.ok(twinUpdate.error, '同层同名更新要报歧义');
assert.match(twinUpdate.error, /有 2 条同名/);
assertSchema('memory_save', twinUpdate);
assert.equal(store.readEntry(twinScope, twinAId).body, '正文甲', '按 id 读不能被同名条目串走');
assert.equal(store.readEntry(twinScope, twinBId).body, '正文乙');

/** 上下文里常只剩缩短的标题：精确匹配失败时要把完整标题就地报出来，不让模型再猜一轮。 */
store.saveEntry(twinScope, { title: '生效验证顺序（含：桌面端没有 Cmd+R）', summary: '缩短标题的探针', body: '正文', writeMode: 'patch' });
await assert.rejects(
  () => exec('memory_read', { title: '生效验证顺序' }),
  /相近的里有：「生效验证顺序（含：桌面端没有 Cmd\+R）」/,
);
const hintedRead = await exec('memory_read', { title: '生效验证顺序（含：桌面端没有 Cmd+R）' });
assert.equal(hintedRead.body, '正文');
const hintedUpdate = await exec('memory_save', { title: '缩短标题的探针', summary: '改正文', body: '新正文', updateTitle: '生效验证顺序' });
assert.ok(hintedUpdate.error);
assert.match(hintedUpdate.error, /相近的里有：「生效验证顺序（含：桌面端没有 Cmd\+R）」/);
assert.doesNotMatch(hintedUpdate.error, /undefined/);


/** 重命名后仍按原 id 定位到同一条；归档后重建同名条目也不能冒领旧 id。 */
const renameSaved = store.saveEntry(twinScope, { title: '改名前的探针', summary: '旧身份', body: '旧正文', writeMode: 'patch' });
const renameSeedId = renameSaved.record?.id ?? renameSaved.id;
const renamed = await exec('memory_save', { title: '改名后的探针', summary: '旧身份', updateTitle: '改名前的探针' });
assert.equal(renamed.changed, true);
assert.equal(store.locateByTitle(twinScope, '改名后的探针').record.id, renameSeedId, '改名必须落在同一条记录上');
const oldIdRead = store.readEntry(twinScope, renameSeedId);
assert.equal(oldIdRead.title, '改名后的探针');
assert.equal(oldIdRead.body, '旧正文');
await exec('memory_forget', { id: renameSeedId, mode: 'archive' });
const recreated = await exec('memory_save', { title: '改名后的探针', summary: '新身份', body: '新正文' });
const recreatedId = store.locateByTitle(twinScope, '改名后的探针').record.id;
assert.notEqual(recreatedId, renameSeedId, '删掉再建是新的身份');
const staleRead = await exec('memory_read', { id: renameSeedId });
assert.equal(staleRead.status, 'archived', '旧 id 只能读到旧条目的归档状态');
assert.equal(staleRead.body, '');
const freshRead = await exec('memory_read', { id: recreatedId });
assert.equal(freshRead.body, '新正文');

const missingSave = await exec('memory_save', { title: '别的标题', summary: '没有这条', updateTitle: '根本不存在的条目' });
assert.ok(missingSave.error);
assertSchema('memory_save', missingSave);
const badLink = await exec('memory_save', { title: '关联写法不对', summary: '关联要写标题', links: [{}] });
assert.ok(badLink.error);
assertSchema('memory_save', badLink);
const missingLink = await exec('memory_save', { title: '关联目标不存在', summary: '目标没有落盘', links: [{ type: 'related', title: '根本没这条' }] });
assert.ok(missingLink.error);
assertSchema('memory_save', missingLink);
assert.match(render('memory_save', {}, missingLink), /^memory · 没有「根本没这条」这条记忆/);

// 成功回执也必须过同一份 schema
for (const value of [saved, merged, patch, probe, distinct]) assertSchema('memory_save', value);

// ── suggestion → keep → replay → reject ──────────────────────────────────────
const suggested = await exec('memory_suggest', { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint', body: 'node ui-copy-lint.mjs', when: '发布前' });
assert.equal(suggested.asked, true);
assert.match(suggested.id, /^sug_[a-z0-9]+$/);
assert.match(render('memory_suggest', {}, suggested), /^memory · suggested "发布前跑文案检查"$/);

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
const proposedGlobal = await exec('memory_save', { title: '回复语言模型提案', summary: '模型建议回复语言用中文', scope: 'global' });
assert.equal(proposedGlobal.scope, 'project', '模型自填 scope 只是提案，默认落项目层');
assert.match(proposedGlobal.scopeNote, /模型归类只是提案/, '降级要能解释');
const global = store.saveEntry(store.globalScope(), {
  title: '回复用中文', summary: '用户要求回复用中文', body: '回复默认用中文', scopeConfirmed: true,
});
assert.ok(global.record, '人明确要全局时才落全局层');
assert.equal(global.chosenScope, 'global');
assert.equal(exec === null, false);

// 显式写 global 也不再被悄无声息地改层：本机痕迹和项目事实各有一条能解释的降级。
const machineGlobal = await exec('memory_save', {
  title: '本机目录同步步骤',
  summary: '流程里写了本机路径，写全局也会留在项目层',
  body: '在 /Users/apple/Desktop/DSH 下改完再同步。',
  scope: 'global',
  memoryClass: 'portable_procedure',
});
assert.equal(machineGlobal.scope, 'project');
assert.match(machineGlobal.scopeNote, /按本机痕迹留在项目层/);
const factGlobal = await exec('memory_save', {
  title: '发版顺序只在仓库成立',
  summary: '项目事实换项目不成立，写全局也会留在项目层',
  body: '这个仓库的发版顺序是先前置检查再打包。',
  scope: 'global',
  memoryClass: 'project_fact',
});
assert.equal(factGlobal.scope, 'project');
assert.match(factGlobal.scopeNote, /按项目事实留在项目层/);
const globalSearch = await exec('memory_search', { query: '回复用中文' });
assert.ok(globalSearch.count >= 1, '全局层条目能被搜到');
assert.match(render('memory_search', {}, globalSearch), /\[global\] 「/);
assert.equal(typeof globalThis.__liteMemoryStats, 'function');
const stats = globalThis.__liteMemoryStats(cwd);
assert.ok(stats.count >= 1);

// ── 引用条：会话读过哪几条，点开能拿到正文 ───────────────────────────────────
const cited = await exec('memory_save', { title: '引用测试', summary: '底部引用条要能点开正文', body: '引用正文第一行' });
await exec('memory_read', { title: cited.title });
const citedRow = store.search(store.scopeOf(cwd), '引用测试').find((row) => row.title === '引用测试');
assert.ok(citedRow);
const cites = await call('/lite-memory/citations', { sessionId: 'session-contract' });
assert.equal(cites.status, 200);
assert.ok(cites.body.items.some((item) => item.id === citedRow.id && item.title === '引用测试'));
assert.equal(cites.body.items.some((item) => 'path' in item), false);
const opened = await call('/lite-memory/body', { sessionId: 'session-contract', id: citedRow.id });
assert.equal(opened.status, 200);
assert.match(opened.body.body, /引用正文第一行/);
/** 界面只有标题：按标题也要能点开，不能因为引用行不存 title 就报已删除。 */
const openedByTitle = await call('/lite-memory/body', { sessionId: 'session-contract', title: '引用测试', revision: opened.body.revision });
assert.equal(openedByTitle.status, 200);
assert.equal(openedByTitle.body.status, 'active');
assert.match(openedByTitle.body.body, /引用正文第一行/);
assert.equal((await call('/lite-memory/body', { sessionId: 'session-contract', title: '没有这条' })).body.status, 'gone');
assert.equal(opened.body.scopeLabel, path.basename(cwd));
const gone = await call('/lite-memory/body', { sessionId: 'session-contract', id: 'mem_999999999999' });
assert.equal(gone.status, 200);
assert.equal(gone.body.status, 'gone');
assert.equal('title' in gone.body, false);
/** 别的会话、别的工作目录都不能拿 id 探正文；本会话引用过或本目录这一层才行。 */
const foreignSession = await call('/lite-memory/body', { sessionId: 'session-contract-2', id: citedRow.id });
assert.equal(foreignSession.status, 200);
assert.equal(foreignSession.body.status, 'gone');
assert.equal('body' in foreignSession.body, false);
const viaCwd = await call('/lite-memory/body', { cwd, id: citedRow.id });
assert.equal(viaCwd.status, 200);
assert.match(viaCwd.body.body, /引用正文第一行/);
const foreignCwd = await call('/lite-memory/body', { cwd: path.join(os.tmpdir(), 'lite-memory-contract-foreign'), id: citedRow.id });
assert.equal(foreignCwd.body.status, 'gone');
assert.equal((await call('/lite-memory/body', { id: citedRow.id })).status, 400);
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
const hintedRow = store.search(store.scopeOf(cwd), 'mock keychain').find((row) => row.title === hinted.title);
assert.ok(hintedRow);
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
  /* CI 冷启动偶尔超过召回耗时上限，逻辑断言不该被「这轮先不注入」判失败。 */
  globalThis.__liteMemoryRecall?.setDeadlineMs?.(5000);
assert.ok(recall, 'recall context registered');
assert.equal(recall.order, 60);
assert.equal(recall.interpolate, false);
assert.equal(recall.required, false);

const sig1 = new AbortController().signal;
const hitsBefore = store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.id === hintedRow.id).hits;
await preStep({ agent: recallAgent, signal: sig1, turn: '2' }, pass('又弹钥匙串窗口了，怎么弄', 'h1'));
const hintText = recall.text({ agent: recallAgent, signal: sig1 });
assert.equal(store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.id === hintedRow.id).hits, hitsBefore, '注入正文本身是纯读，不写 hits');
assert.doesNotMatch(hintText, /mem_[a-z0-9]{6,}/, '召回卡只给标题，不给内部编号');
assert.match(hintText, /需要细节用 memory_read/);
sessionCwds.set('session-recall', cwd);
const recallReceipt = await call('/lite-memory/overview', { sessionId: 'session-recall' });
assert.equal(recallReceipt.status, 200);
assert.equal(recallReceipt.body.current.recall.reason, 'hit', '面板能回答这次为什么提醒');
assert.equal(recallReceipt.body.current.recall.limit, 3);
assert.equal(recallReceipt.body.current.recall.cards, 1);
assert.ok(recallReceipt.body.current.recall.chars > 0);
assert.ok(!/mem_[a-z0-9]{6,}/.test(JSON.stringify(recallReceipt.body.current.recall)), '判断依据不带内部编号');
const missTurn = await preStep({ agent: recallAgent, signal: sig1, turn: '3' }, pass('把这段视频的字幕导出来', 'h2'));
assert.equal(missTurn.kind, 'enter');
assert.equal(recall.text({ agent: recallAgent, signal: sig1 }), '');
const missReceipt = await call('/lite-memory/overview', { sessionId: 'session-recall' });
assert.ok(['no_overlap', 'needs_context'].includes(missReceipt.body.current.recall.reason), '没提醒时也说明依据');
assert.equal(missReceipt.body.current.recall.cards, 0);
const hitsAfter = store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.id === hintedRow.id).hits;
assert.equal(hitsAfter, hitsBefore + 1, '交付过的卡片在下一轮开头记一次使用');

const sig2 = new AbortController().signal;
await preStep({ agent: recallAgent, signal: sig2, turn: '3' }, pass('周四晚上发版要注意什么', 'h2'));
assert.equal(recall.text({ agent: recallAgent, signal: sig2 }).includes('发布窗口在周四晚上'), false);
const waitingReceipt = await call('/lite-memory/overview', { sessionId: 'session-recall' });
assert.equal(waitingReceipt.body.current.recall.reason, 'needs_context', '有候选但条件未确认时，不误报成没有匹配');
assert.equal(waitingReceipt.body.current.recall.cards, 0);

// 同一主题的两条现行规范互相冲突：整组不进自动召回，但面板要说是「相关但没确认」，不是「没有匹配」
await exec('memory_save', { title: '发版前检查清单', summary: '发版前先跑一遍检查清单', topicKey: 'release-checklist' });
await exec('memory_save', { title: '发版前通知渠道', summary: '发版前在群里通知相关人', topicKey: 'release-checklist', resolution: 'distinct' });
await preStep({ agent: recallAgent, signal: sig2, turn: '4' }, pass('发版前要做哪些检查', 'h4'));
const conflictReceipt = await call('/lite-memory/overview', { sessionId: 'session-recall' });
assert.equal(conflictReceipt.body.current.recall.reason, 'needs_context', '冲突未解决时也不能报成没有匹配');
assert.equal(conflictReceipt.body.current.recall.cards, 0);
assert.ok(conflictReceipt.body.current.recall.matched >= 1);

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
const evoRow = store.loadIndex(evoReadScope).entries.find((entry) => entry.title === evoRule.title);
assert.ok(evoRow, '口播开头落在这一层');
state.transact(evoReadScope, {}, (draft) => {
  const row = draft.entries.find((entry) => entry.id === evoRow.id);
  row.origin = 'project_evolution';
  row.current.conditions = [{ key: 'seriesId', value: '口播' }];
  row.maintenance = { ...(row.maintenance || {}), learning: { state: 'active', source: 'evolution', specDigest: 'seeded' } };
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
  /* CI 冷启动偶尔超过召回耗时上限，逻辑断言不该被「这轮先不注入」判失败。 */
  globalThis.__liteMemoryRecall?.setDeadlineMs?.(5000);
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
assert.equal(evoManage.body.rules[0].id, evoRow.id);
assert.ok(evoManage.body.payload.bytes > 0);
const evoDeleteStale = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'delete', id: evoRow.id, expectedRevision: evoManage.body.rules[0].revision - 1,
});
assert.equal(evoDeleteStale.status, 409);
const evoDelete = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'delete', id: evoRow.id, expectedRevision: evoManage.body.rules[0].revision,
});
assert.equal(evoDelete.status, 200);
assert.equal(evoDelete.body.ok, true);

// 管理面成功路径：候选可修改、采纳、暂停、恢复、放弃，每次返回后能继续操作
const manageSeed = await defs.get('memory_save').execute(
  { title: '口播收尾', summary: '口播收尾留一句行动', body: '结尾给一句具体行动。' },
  { agent: evoAgent },
);
const manageRow = store.loadIndex(evoReadScope).entries.find((entry) => entry.title === manageSeed.title);
assert.ok(manageRow, '口播收尾落在这一层');
state.transact(evoReadScope, {}, (draft) => {
  const row = draft.entries.find((entry) => entry.id === manageRow.id);
  row.origin = 'project_evolution';
  row.current.conditions = [{ key: 'seriesId', value: '口播' }];
  row.maintenance = { ...(row.maintenance || {}), learning: { state: 'pending', source: 'evolution', specDigest: 'seeded' } };
  return { changed: true };
});
const manageSnap = await call('/lite-memory/evolution', { sessionId: 'session-evo-read', learningAction: 'snapshot' });
const manageRule = manageSnap.body.rules.find((rule) => rule.id === manageRow.id);
assert.ok(manageRule);
assert.equal(manageRule.state, 'pending');
const manageEdit = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'edit', id: manageRow.id,
  expectedRevision: manageRule.revision, body: '结尾给一句具体动作。',
});
assert.equal(manageEdit.status, 200);
assert.equal(manageEdit.body.ok, true);
const afterManageEdit = (await call('/lite-memory/evolution', { sessionId: 'session-evo-read', learningAction: 'snapshot' })).body.rules.find((rule) => rule.id === manageRow.id);
assert.equal(afterManageEdit.state, 'pending');
assert.equal(afterManageEdit.body, '结尾给一句具体动作。');
const manageAdopt = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'adopt', id: manageRow.id, expectedRevision: afterManageEdit.revision,
});
assert.equal(manageAdopt.status, 200);
assert.equal((await call('/lite-memory/evolution', { sessionId: 'session-evo-read', learningAction: 'snapshot' })).body.rules.find((rule) => rule.id === manageRow.id).state, 'active');
const managePause = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'pause', ids: [manageRow.id],
});
assert.equal(managePause.status, 200);
assert.equal((await call('/lite-memory/evolution', { sessionId: 'session-evo-read', learningAction: 'snapshot' })).body.rules.find((rule) => rule.id === manageRow.id).state, 'paused');
const manageResume = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'resume', id: manageRow.id,
});
assert.equal(manageResume.status, 200);
const manageResumed = (await call('/lite-memory/evolution', { sessionId: 'session-evo-read', learningAction: 'snapshot' })).body.rules.find((rule) => rule.id === manageRow.id);
assert.equal(manageResumed.state, 'trial');
const manageDiscard = await call('/lite-memory/evolution', {
  sessionId: 'session-evo-read', learningAction: 'discard', id: manageRow.id, expectedRevision: manageResumed.revision,
});
assert.equal(manageDiscard.status, 200);
assert.equal((await call('/lite-memory/evolution', { sessionId: 'session-evo-read', learningAction: 'snapshot' })).body.rules.length, 0);

// ── 关闭项目记忆后：面板只读，管理面写操作全部拒绝，工具也不落盘 ─────────────
const closedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-closed-'));
sessionCwds.set('session-closed', closedCwd);
const closedScope = store.scopeOf(closedCwd);
const closedAgent = { id: 'session-closed', cwd: closedCwd, session: { id: 'session-closed', header: { cwd: closedCwd } } };
const closedSeed = await defs.get('memory_save').execute(
  { title: '口播开头', summary: '口播开头三句内给结论', body: '开场三句内给结论。' },
  { agent: closedAgent },
);
const closedRow = store.loadIndex(closedScope).entries.find((entry) => entry.title === closedSeed.title);
assert.ok(closedRow, '关闭前的样例落在这一层');
state.transact(closedScope, {}, (draft) => {
  const row = draft.entries.find((entry) => entry.id === closedRow.id);
  row.origin = 'project_evolution';
  row.maintenance = { ...(row.maintenance || {}), learning: { state: 'active', specDigest: 'seeded' } };
  return { changed: true };
});
assert.equal((await call('/lite-memory/evolution', { sessionId: 'session-closed', enabled: true })).status, 200);
const closedOff = await call('/lite-memory/control', { sessionId: 'session-closed', enabled: false, operationId: 'op_close_contract' });
assert.equal(closedOff.status, 200);
assert.equal(closedOff.body.enabled, false);
const closedFile = path.join(closedScope.dir, 'state.json');
const closedBefore = fs.readFileSync(closedFile);
const closedSnapshot = await call('/lite-memory/evolution', { sessionId: 'session-closed', learningAction: 'snapshot' });
assert.equal(closedSnapshot.status, 200);
assert.equal(closedSnapshot.body.enabled, false);
assert.equal(closedSnapshot.body.rules.length, 1);
assert.equal(Buffer.compare(closedBefore, fs.readFileSync(closedFile)), 0);
const closedRevision = closedSnapshot.body.rules[0].revision;
for (const action of ['adopt', 'edit', 'delete', 'pause', 'resume', 'pin', 'undo']) {
  const payload = { sessionId: 'session-closed', learningAction: action, id: closedSeed.id, expectedRevision: closedRevision, body: '改过的正文' };
  if (action === 'pin') payload.pinned = true;
  if (action === 'pause') payload.ids = [closedRow.id];
  const result = await call('/lite-memory/evolution', payload);
  assert.equal(result.status, 409, action);
  assert.equal(result.body.code, 'memory_disabled', action);
}
const closedTool = await defs.get('memory_save').execute(
  { title: '关闭后写入', summary: '应当拒绝', body: '不该落盘' },
  { agent: closedAgent },
);
assert.equal(closedTool.changed, false);
assert.equal(closedTool.reason, 'memory_disabled');
assertSchema('memory_save', closedTool);
assert.equal(closedTool.id, undefined);
/** 关闭态的保存回执也要能渲染：不能等用户真去写一条才报 ReferenceError。 */
assert.match(render('memory_save', {}, closedTool), /^memory · 本项目记忆已关闭/);
/** 关闭状态下的读取也只报状态，不返回正文。 */
const closedRead = await defs.get('memory_read').execute({ title: closedSeed.title }, { agent: closedAgent });
assert.equal(closedRead.status, 'memory_disabled');
assert.equal(closedRead.body, undefined, '关闭时连空正文也不占位');
assertSchema('memory_read', closedRead);
assert.match(render('memory_read', {}, closedRead), /^memory · 记忆检索已关闭$/);
assert.equal(Buffer.compare(closedBefore, fs.readFileSync(closedFile)), 0);
const toolOnly = await call('/lite-memory/control', { sessionId: 'session-closed', enabled: true, mode: 'tool_only', operationId: 'op_mode_contract' });
assert.equal(toolOnly.status, 200);
assert.equal(toolOnly.body.enabled, true);
assert.equal(toolOnly.body.mode, 'tool_only');
const backToAuto = await call('/lite-memory/control', { sessionId: 'session-closed', enabled: true, mode: 'adaptive', operationId: 'op_mode_back_contract' });
assert.equal(backToAuto.status, 200);
assert.equal(backToAuto.body.mode, 'adaptive');
const reopened = await call('/lite-memory/control', { sessionId: 'session-closed', enabled: true, operationId: 'op_reopen_contract' });
assert.equal(reopened.status, 200);
const reopenedSnapshot = await call('/lite-memory/evolution', { sessionId: 'session-closed', learningAction: 'snapshot' });
assert.equal(reopenedSnapshot.body.enabled, false);
assert.equal(reopenedSnapshot.body.rules.length, 1);

// ── 界面只吃持久元数据，不猜文案 ─────────────────────────────────────────────
const metaOf = (name, args, value) => defs.get(name).output.presentationMeta(args, value);
const savedMeta = metaOf('memory_save', {}, saved);
assert.equal(savedMeta.kind, 'memory-save');
assert.equal(savedMeta.recordKind, saved.kind);
assert.equal(savedMeta.id, undefined);
assert.equal(savedMeta.title, '发布顺序');
assert.equal(savedMeta.changed, true);
assert.ok(['created', 'updated'].includes(savedMeta.mode));
assert.equal('path' in savedMeta, false);
const searchMeta = metaOf('memory_search', {}, globalSearch);
assert.deepEqual(Object.keys(searchMeta.refs[0]).sort(), ['kind', 'origin', 'revision', 'scope', 'status', 'title', 'updated', 'when']);
/** 输出 schema 不能再要求内部 id：引用对外只有标题，宿主校验会因此整条工具报错。 */
const searchRefSchema = defs.get('memory_search').output.schema.properties.refs.items;
assert.equal('id' in searchRefSchema.properties, false);
assert.deepEqual([...searchRefSchema.required].sort(), ['kind', 'origin', 'revision', 'scope', 'status', 'title', 'when']);
assert.equal(searchMeta.refs[0].title, '回复用中文');
assert.equal(searchMeta.refs[0].scope, 'global');
/** 引用要能区分偏好/约定/流程/资料，界面才不必猜标题文案。 */
assert.equal(searchMeta.refs[0].kind, store.loadIndex(store.globalScope()).entries.find((item) => item.title === '回复用中文').kind);
assert.equal(searchMeta.refs[0].when, '');
/** 出处行要说「N 天前更新」，只给时间不进正文。 */
assert.equal(typeof searchMeta.refs[0].updated, 'string');
const readValue = await exec('memory_read', { title: '回复用中文' });
const readMeta = metaOf('memory_read', {}, readValue);
assert.equal(readMeta.kind, 'memory-read');
assert.equal(readMeta.recordKind, readValue.kind);
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
const stale = await call('/lite-memory/undo', { op: 'undo', title: '版本守卫', revision: 1, cwd });
assert.equal(stale.status, 409);
const fresh = store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.title === '版本守卫');
const accepted = await call('/lite-memory/undo', { op: 'undo', title: '版本守卫', revision: fresh.revision, cwd });
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
const narrowed = await exec2('memory_save', { title: 'windows 上跑构建', summary: 'windows 构建用这条命令' });
assert.equal(narrowed.changed, true);
const narrowRecord = projectEntries().find((item) => item.title === 'windows 上跑构建');
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
const bothBoxes = projectEntries().filter((item) => item.title === '冒烟顺序' && item.status === 'active');
assert.equal(bothBoxes.length, 2);
assert.deepEqual(bothBoxes.map((item) => item.conditions[0].value).sort(), ['box-a', 'box-b']);
assert.equal(bothBoxes.find((item) => item.conditions[0].value === 'box-a').body, '先登录再下单');
assert.equal(bothBoxes.find((item) => item.conditions[0].value === 'box-b').body, '先建号再登录');

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
const slotEntries = projectEntries().filter((item) => item.title === '发版检查项');
assert.equal(slotEntries.length, 2);
assert.notEqual(slotEntries[0].id, slotEntries[1].id);
const resolvedSlots = store.visibleRules(projectScope, {}).resolved;
const slotRow = [...resolvedSlots.values()].find((row) => row.key === '发版检查');
assert.ok(slotRow);
assert.equal(slotRow.status, 'conflict');

/** 工具参数里的 links / selection.items / topicKey:null 是合法输入，不能被 schema 挡掉或被校验器拒绝。 */
assert.equal(saveParams.links.items.type, 'object');
assert.deepEqual(saveParams.links.items.required, ['title']);
assert.equal(saveParams.selection.properties.items.type, 'array');
assert.deepEqual(saveParams.topicKey.type, ['string', 'null']);
const linkedA = await exec2('memory_save', { title: '关联目标甲', summary: '用来当关联目标', body: '甲', scope: 'project' });
const linkedB = await exec2('memory_save', {
  title: '关联目标乙',
  summary: '带关联的那条',
  body: '乙',
  scope: 'project',
  resolution: 'distinct',
  links: [{ type: 'related', title: linkedA.title }],
});
assert.equal(linkedB.changed, true, JSON.stringify(linkedB));
const linkedRecord = projectEntries().find((item) => item.title === '关联目标乙');
const linkedTarget = projectEntries().find((item) => item.title === '关联目标甲');
assert.ok(linkedRecord && linkedTarget);
assert.equal(linkedRecord.links.length, 1);
assert.equal(linkedRecord.links[0].id, linkedTarget.id);
assert.equal(linkedRecord.links[0].type, 'related');
/** 关联清单也要给标题：只发内部 id 会让界面显示 undefined。 */
const linkRead = await exec2('memory_read', { title: '关联目标乙', view: 'links' });
assert.equal(linkRead.title, '关联目标乙');
assert.match(linkRead.links, /关联目标甲/);
assert.doesNotMatch(render('memory_read', { title: '关联目标乙', view: 'links' }, linkRead), /undefined/);
/** 更新句柄也是标题：抄标题改这一条，不需要任何内部编号。 */
const retitled = await exec2('memory_save', { updateTitle: linkedA.title, title: linkedA.title, summary: '改过的摘要' });
assert.equal(retitled.changed, true);
assert.equal(retitled.summary, '改过的摘要');
const missingUpdate = await exec2('memory_save', { updateTitle: '从来没有存过的标题', title: '新的一条', summary: '新' });
assert.match(missingUpdate.error, /没有「从来没有存过的标题」这条记忆/);


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
            : { target: 'new', feedbackType: 'spec_change', topicKey: '开头', currentText: '开头先给结论。', applicability: 'conditional', conditions: [{ key: 'taskKind', value: 'video' }, { key: 'seriesId', value: '口播' }, { key: 'phase', value: 'brief' }], evidence: ['u0'], persistence: 'project_candidate' };
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

// ── 记忆面板总览：只读枚举各项目层，正文按 scopeKey 单读，不泄露内部路径 ──────
const ovCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-overview-'));
const ovOtherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-overview-other-'));
sessionCwds.set('session-overview', ovCwd);
sessionCwds.set('session-overview-other', ovOtherCwd);
const ovAgent = { id: 'session-overview', cwd: ovCwd, session: { id: 'session-overview', header: { cwd: ovCwd } } };
const ovFirst = await defs.get('memory_save').execute(
  { title: '开场先给结论', summary: '口播开头先给结论', body: '开场三句内给结论。', tags: ['口播', '开头'], links: [] },
  { agent: ovAgent },
);
const ovSecond = await defs.get('memory_save').execute(
  { title: '封面留白', summary: '封面别放满', body: '右侧留白。', tags: ['封面'] },
  { agent: ovAgent },
);
await defs.get('memory_save').execute(
  { title: '发布窗口', summary: '只在周四晚上发版', body: '周四晚上再发版。', when: '周四晚上' },
  { agent: ovAgent },
);
store.saveEntry(store.globalScope(), {
  title: '观察全局', summary: '跨项目通用说明', body: '全局正文。', scopeConfirmed: true,
});
const ovOther = await defs.get('memory_save').execute(
  { title: '别的项目', summary: '只在别的项目里', body: '另一层的正文。', tags: ['别的'] },
  { agent: { id: 'session-overview-other', cwd: ovOtherCwd, session: { id: 'session-overview-other', header: { cwd: ovOtherCwd } } } },
);
const ov = await call('/lite-memory/overview', { sessionId: 'session-overview' });
assert.equal(ov.status, 200);
assert.equal(ov.body.ok, true);
assert.equal(ov.body.current.key, store.scopeOf(ovCwd).key);
assert.equal(ov.body.current.label, path.basename(ovCwd));
assert.equal(ov.body.current.evolution.enabled, false);
assert.equal(ov.body.current.recall, null, '没发生过自动召回时不给判断依据');
assert.equal(ov.body.selected.key, ov.body.current.key);
assert.equal(ov.body.selected.kind, 'project');
assert.equal(ov.body.selected.evolution.enabled, false);
assert.ok(Array.isArray(ov.body.selected.evolution.rules));
assert.ok(ov.body.selected.records.some((row) => row.title === '开场先给结论'));
assert.equal(ov.body.selected.records.some((row) => 'body' in row), false, '列表不带正文');
assert.equal(ov.body.selected.stats.total, 3);
assert.equal(ov.body.selected.stats.tags, 3);
assert.equal(JSON.stringify(ov.body).includes('"dir"'), false, '不暴露内部目录');
assert.equal(JSON.stringify(ov.body).includes(process.env.DSH_HOME), false);
const ovKeys = ov.body.scopes.map((row) => row.key);
assert.ok(ovKeys.includes(ov.body.current.key));
assert.ok(ovKeys.includes(store.scopeOf(ovOtherCwd).key));
assert.ok(ovKeys.includes('global'), '全局层总在列表里');

// 切到别的项目只是换一面看，不写那个项目
const ovOtherView = await call('/lite-memory/overview', { sessionId: 'session-overview', scopeKey: store.scopeOf(ovOtherCwd).key });
assert.equal(ovOtherView.status, 200);
assert.equal(ovOtherView.body.selected.key, store.scopeOf(ovOtherCwd).key);
assert.deepEqual(ovOtherView.body.selected.records.map((row) => row.title), ['别的项目']);
assert.equal(ovOtherView.body.selected.evolution.enabled, false, '别的项目也要给只读实验状态');
assert.equal(ovOtherView.body.current.key, ov.body.current.key);
const ovGlobal = await call('/lite-memory/overview', { sessionId: 'session-overview', scopeKey: 'global' });
assert.equal(ovGlobal.status, 200);
assert.equal(ovGlobal.body.selected.kind, 'global');
assert.ok(ovGlobal.body.selected.records.some((row) => row.title === '观察全局'));

// 面板改正文：只动当前项目、必须带读到的版本，冲突和改名撞车都不覆盖
const ovRow = ov.body.selected.records.find((row) => row.title === '开场先给结论');
const ovEntry = await call('/lite-memory/entry', {
  sessionId: 'session-overview', scopeKey: ov.body.current.key, id: ovRow.id,
  title: '开场先给结论', body: '开场 2 句内给结论，结尾留 3 秒；本地端口 49631。', expectedRevision: ovRow.revision,
});
assert.equal(ovEntry.status, 200);
assert.equal(ovEntry.body.ok, true);
assert.equal(ovEntry.body.title, '开场先给结论');
assert.ok(ovEntry.body.revision > ovRow.revision, '改过就升版本');
const ovKept = store.readEntry(store.scopeOf(ovCwd), ovRow.id);
assert.deepEqual(ovKept.tags, ['口播', '开头'], '只改标题正文，标签等字段保持');
assert.equal(ovKept.kind, 'note');
const ovEditedBody = await call('/lite-memory/body', { sessionId: 'session-overview', title: '开场先给结论', scopeKey: ov.body.current.key });
assert.equal(ovEditedBody.body.body, '开场 2 句内给结论，结尾留 3 秒；本地端口 49631。');
const ovStale = await call('/lite-memory/entry', {
  sessionId: 'session-overview', scopeKey: ov.body.current.key, id: ovRow.id,
  title: '开场先给结论', body: '被旧版本覆盖。', expectedRevision: ovRow.revision,
});
assert.equal(ovStale.status, 409);
assert.equal(ovStale.body.retry, true, '版本过期要明说可以重试');
const ovAfterStale = await call('/lite-memory/body', { sessionId: 'session-overview', title: '开场先给结论', scopeKey: ov.body.current.key });
assert.equal(ovAfterStale.body.body, '开场 2 句内给结论，结尾留 3 秒；本地端口 49631。', '旧版本写不进去');
const ovRenameClash = await call('/lite-memory/entry', {
  sessionId: 'session-overview', scopeKey: ov.body.current.key, id: ovRow.id,
  title: '封面留白', body: '开场 2 句内给结论，结尾留 3 秒；本地端口 49631。', expectedRevision: ovEntry.body.revision,
});
assert.equal(ovRenameClash.status, 400, '改名撞上另一条要拒绝');
assert.match(ovRenameClash.body.reason, /同名/);
const ovOtherEdit = await call('/lite-memory/entry', {
  sessionId: 'session-overview', scopeKey: ov.body.current.key, id: ovOther.body && ovOther.body.record ? ovOther.body.record.id : 'mem_other',
  title: '别的项目', body: '想跨项目改。', expectedRevision: 1,
});
assert.equal(ovOtherEdit.status >= 400, true, '别的项目不能从这里改');
const ovGlobalRow = ovGlobal.body.selected.records.find((row) => row.title === '观察全局');
const ovGlobalEdit = await call('/lite-memory/entry', {
  sessionId: 'session-overview', scopeKey: 'global', id: ovGlobalRow.id,
  title: '观察全局', body: '想改全局。', expectedRevision: ovGlobalRow.revision,
});
assert.equal(ovGlobalEdit.status, 409, '全局层在项目会话里只读');
assert.equal((await call('/lite-memory/entry', { sessionId: 'session-overview', scopeKey: ov.body.current.key, id: ovRow.id, title: '', body: 'x', expectedRevision: 1 })).status, 400);

// 适用范围只有两种来源：模型当时没确认，或人看过之后明确确认。面板能补后者，不替模型猜。
const ovPendingRow = ov.body.selected.records.find((row) => row.title === '发布窗口');
assert.equal(ovPendingRow.applicability, 'unresolved');
const ovPendingBody = await call('/lite-memory/body', { sessionId: 'session-overview', title: '发布窗口', scopeKey: ov.body.current.key });
assert.equal(ovPendingBody.status, 200);
assert.equal(ovPendingBody.body.applicability, 'unresolved');
const ovConfirmBad = await call('/lite-memory/entry', {
  sessionId: 'session-overview', scopeKey: ov.body.current.key, id: ovPendingRow.id,
  title: '发布窗口', body: '周四晚上再发版。', expectedRevision: ovPendingRow.revision, applicability: 'always',
});
assert.equal(ovConfirmBad.status, 400, '三档之外的值不能写进记忆');
const ovConfirm = await call('/lite-memory/entry', {
  sessionId: 'session-overview', scopeKey: ov.body.current.key, id: ovPendingRow.id,
  title: '发布窗口', body: '周四晚上再发版。', expectedRevision: ovPendingRow.revision,
  applicability: 'all_in_scope', conditions: [],
});
assert.equal(ovConfirm.status, 200);
assert.equal(ovConfirm.body.ok, true);
const ovPendingAfter = await call('/lite-memory/body', { sessionId: 'session-overview', title: '发布窗口', scopeKey: ov.body.current.key });
assert.equal(ovPendingAfter.body.applicability, 'all_in_scope');
assert.deepEqual(ovPendingAfter.body.conditions, []);
assert.equal(store.readEntry(store.scopeOf(ovCwd), ovPendingRow.id).applicability, 'all_in_scope', '确认落到那一条上');
assert.equal(store.readEntry(store.scopeOf(ovCwd), ovRow.id).applicability, 'all_in_scope', '别条不受影响');

// 详情按服务端枚举过的 scopeKey 取；内部路径、未知键一律不放行。
// 宫殿里点开一条只走这个只读入口：不改记忆、不记用量、不占额度。
const ovStateFile = path.join(store.scopeOf(ovCwd).dir, 'state.json');
const ovStateBefore = fs.readFileSync(ovStateFile, 'utf8');
const ovBody = await call('/lite-memory/body', { sessionId: 'session-overview', title: '开场先给结论', scopeKey: ov.body.current.key });
assert.equal(ovBody.status, 200);
assert.equal(fs.readFileSync(ovStateFile, 'utf8'), ovStateBefore, '面板看正文不写状态');
assert.equal(ovBody.body.body, '开场 2 句内给结论，结尾留 3 秒；本地端口 49631。');
assert.equal(ovBody.body.scopeLabel, path.basename(ovCwd));
const ovOtherBody = await call('/lite-memory/body', { sessionId: 'session-overview', title: '别的项目', scopeKey: store.scopeOf(ovOtherCwd).key });
assert.equal(ovOtherBody.status, 200);
assert.equal(ovOtherBody.body.scopeLabel, path.basename(ovOtherCwd));
assert.equal((await call('/lite-memory/body', { sessionId: 'session-overview', title: '开场先给结论', scopeKey: 'nope' })).status, 404);
assert.equal((await call('/lite-memory/body', { sessionId: 'session-overview', title: '开场先给结论', scopeKey: '../x' })).status, 404);
assert.equal((await call('/lite-memory/overview', {})).status, 400);
assert.equal((await call('/lite-memory/overview', { sessionId: 'session-overview' }, { origin: 'http://evil.example' })).status, 403);
const ovUnknownCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-overview-unknown-'));
sessionCwds.set('session-overview-unknown', ovUnknownCwd);
const ovUnconfirmedSaved = process.env.PATH;
process.env.PATH = '';
const ovUnconfirmed = await call('/lite-memory/overview', { sessionId: 'session-overview-unknown' });
process.env.PATH = ovUnconfirmedSaved;
assert.equal(ovUnconfirmed.status, 409);
assert.equal(fs.existsSync(path.join(store.scopeOf(ovUnknownCwd).dir, 'state.json')), false);

// 实验条目也画进图里，但只有面板能看见；普通读取面仍然拿不到
state.transact(store.scopeOf(ovCwd), {}, (draft) => {
  const row = draft.entries.find((entry) => (entry.current || {}).title === '封面留白');
  row.origin = 'project_evolution';
  row.maintenance = { ...(row.maintenance || {}), learning: { state: 'trial', source: 'evolution', specDigest: 'seeded' } };
  return { changed: true };
});
const ovExperimental = await call('/lite-memory/overview', { sessionId: 'session-overview' });
assert.equal(ovExperimental.body.selected.stats.experimental, 1);
assert.equal(ovExperimental.body.selected.records.find((row) => row.title === '封面留白').experimental, true);
assert.equal(store.loadIndex(store.scopeOf(ovCwd), { allowExperimental: true }).entries.some((row) => row.title === '封面留白'), true);

// 归档不是死数字：总数诚实，列表单独取，正文还能按 id 打开
state.transact(store.scopeOf(ovCwd), {}, (draft) => {
  const row = draft.entries.find((entry) => (entry.current || {}).title === '封面留白');
  row.status = 'archived';
  return { changed: true };
});
const ovArchived = await call('/lite-memory/overview', { sessionId: 'session-overview' });
assert.equal(ovArchived.body.selected.stats.archived, 1);
assert.equal(ovArchived.body.selected.records.some((row) => row.title === '封面留白'), false);
assert.equal(ovArchived.body.selected.archived.some((row) => row.title === '封面留白'), true);
const ovArchivedBody = await call('/lite-memory/body', { sessionId: 'session-overview', title: '封面留白', scopeKey: ovArchived.body.selected.key });
assert.equal(ovArchivedBody.status, 200);
assert.equal(ovArchivedBody.body.status, 'archived');
assert.equal(ovArchivedBody.body.body, '右侧留白。');

// 待裁决：面板看得到队列，确认后按草稿另存，不预写正文
const cfCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-conflict-'));
sessionCwds.set('session-conflict-panel', cfCwd);
sessionCwds.set('session-conflict-other', fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-conflict-other-')));
const cfAgent = { id: 'session-conflict-panel', cwd: cfCwd, session: { id: 'session-conflict-panel', header: { cwd: cfCwd } } };
store.saveEntry(store.globalScope(), { title: '发布窗口', summary: '只在周四晚上发版', body: '周四晚上再发版。', scopeConfirmed: true });
const cfSave = await defs.get('memory_save').execute({ title: '发布窗口', summary: '本项目周五发版', body: '周五发版。' }, { agent: cfAgent });
assert.equal(cfSave.needsResolution, true);
assert.equal(store.loadIndex(store.scopeOf(cfCwd)).entries.length, 0, '没确认前不落库');
const cfBefore = await call('/lite-memory/overview', { sessionId: 'session-conflict-panel' });
assert.equal(cfBefore.status, 200);
assert.equal(cfBefore.body.selected.conflicts.length, 1);
const cfRow = cfBefore.body.selected.conflicts[0];
assert.equal(cfRow.title, '发布窗口');
assert.equal(cfRow.draft.body, '周五发版。');
assert.ok(cfRow.id, '待裁决要有稳定 id');
assert.equal(cfRow.revision, 1);
const cfScopeKey = cfBefore.body.selected.key;

// 跨项目：当前会话是 A，请求 B 的范围必须拒绝，且不能动到 A 的草稿
const cfCross = await call('/lite-memory/conflict', {
  sessionId: 'session-conflict-panel', scopeKey: '另一个项目', conflictId: cfRow.id, expectedRevision: 1, op: 'drop',
});
assert.equal(cfCross.status, 409);
assert.match(cfCross.body.reason, /只读/);
assert.equal(store.loadIndex(store.scopeOf(cfCwd)).conflicts.length, 1, '跨项目请求不改数据');

// 关闭项目记忆后，本入口也不能落盘
await call('/lite-memory/control', { sessionId: 'session-conflict-panel', enabled: false, operationId: 'op_cf_close' });
const cfClosed = await call('/lite-memory/conflict', {
  sessionId: 'session-conflict-panel', scopeKey: cfScopeKey, conflictId: cfRow.id, expectedRevision: 1, op: 'keep',
});
assert.equal(cfClosed.status, 409);
assert.equal(cfClosed.body.code, 'memory_disabled');
assert.equal(store.loadIndex(store.scopeOf(cfCwd)).entries.length, 0, '关闭状态不写记忆');
await call('/lite-memory/control', { sessionId: 'session-conflict-panel', enabled: true, operationId: 'op_cf_reopen' });

// 草稿被后来的反馈替换：旧版本点击必须拒绝
await defs.get('memory_save').execute({ title: '发布窗口', summary: '本项目改成周六发版', body: '周六发版。' }, { agent: cfAgent });
const cfStale = await call('/lite-memory/conflict', {
  sessionId: 'session-conflict-panel', scopeKey: cfScopeKey, conflictId: cfRow.id, expectedRevision: 1, op: 'keep',
});
assert.equal(cfStale.status, 409);
assert.equal(cfStale.body.code, 'stale_draft');
const cfStaleView = await call('/lite-memory/overview', { sessionId: 'session-conflict-panel' });
assert.equal(cfStaleView.body.selected.conflicts[0].revision, 2, '草稿换了版本要涨');
assert.equal(cfStaleView.body.selected.conflicts[0].draft.body, '周六发版。');

const cfKeep = await call('/lite-memory/conflict', {
  sessionId: 'session-conflict-panel', scopeKey: cfScopeKey, conflictId: cfRow.id, expectedRevision: 2, op: 'keep',
});
assert.equal(cfKeep.status, 200);
assert.equal(cfKeep.body.ok, true);
const cfAfter = await call('/lite-memory/overview', { sessionId: 'session-conflict-panel' });
assert.equal(cfAfter.body.selected.conflicts.length, 0);
assert.ok(cfAfter.body.selected.records.some((row) => row.title === '发布窗口' && row.summary === '本项目改成周六发版'));
const cfAgain = await call('/lite-memory/conflict', {
  sessionId: 'session-conflict-panel', scopeKey: cfScopeKey, conflictId: cfRow.id, expectedRevision: 2, op: 'keep',
});
assert.equal(cfAgain.status, 409, '队列没了就明确说，不重复落库');

// 项目记忆关闭时，选全局待裁决也不能借这个入口落盘
const cfgCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-conflict-global-'));
sessionCwds.set('session-conflict-global', cfgCwd);
const cfgAgent = { id: 'session-conflict-global', cwd: cfgCwd, session: { id: 'session-conflict-global', header: { cwd: cfgCwd } } };
await defs.get('memory_save').execute({ title: '命名规则', summary: '项目里用短横线', body: '短横线。' }, { agent: cfgAgent });
const cfgSave = store.saveEntry(store.scopeOf(cfgCwd), { title: '命名规则', summary: '所有项目用下划线', body: '下划线。', scope: 'global', scopeConfirmed: true });
assert.equal(cfgSave.needsResolution, true);
const cfgView = await call('/lite-memory/overview', { sessionId: 'session-conflict-global', scopeKey: 'global' });
assert.equal(cfgView.body.selected.conflicts.length, 1, '全局层也要有这条待裁决');
const cfgRow = cfgView.body.selected.conflicts[0];
await call('/lite-memory/control', { sessionId: 'session-conflict-global', enabled: false, operationId: 'op_cfg_close' });
const cfgClosed = await call('/lite-memory/conflict', {
  sessionId: 'session-conflict-global', scopeKey: 'global', conflictId: cfgRow.id, expectedRevision: cfgRow.revision, op: 'keep',
});
assert.equal(cfgClosed.status, 409);
assert.equal(cfgClosed.body.code, 'memory_disabled');
assert.equal(store.conflictsOf(store.globalScope()).length, 1, '关闭状态不批准全局草稿');
await call('/lite-memory/control', { sessionId: 'session-conflict-global', enabled: true, operationId: 'op_cfg_reopen' });
const cfgKeep = await call('/lite-memory/conflict', {
  sessionId: 'session-conflict-global', scopeKey: 'global', conflictId: cfgRow.id, expectedRevision: cfgRow.revision, op: 'keep',
});
assert.equal(cfgKeep.status, 200);
assert.equal(store.conflictsOf(store.globalScope()).length, 0);

// ── 面板搬移：只带会话就能换层，身份按 id 换但正文与条件跟着走 ─────────────
const moveCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-move-'));
sessionCwds.set('session-move', moveCwd);
store.saveEntry(store.scopeOf(moveCwd), {
  title: '搬移探针', summary: '只在项目层', body: '搬移正文。', tags: ['搬移'], writeMode: 'patch',
});
const movedOut = await call('/lite-memory/move', {
  sessionId: 'session-move', target: 'global',
  id: store.loadIndex(store.scopeOf(moveCwd)).entries.find((row) => row.title === '搬移探针').id,
});
assert.equal(movedOut.status, 200);
assert.equal(movedOut.body.ok, true);
assert.equal(movedOut.body.status, 'moved');
assert.equal(movedOut.body.to, 'global');
assert.ok(movedOut.body.id && movedOut.body.id !== movedOut.body.previousId, '换层后身份换新 id');
assert.equal(store.loadIndex(store.scopeOf(moveCwd)).entries.some((row) => row.title === '搬移探针'), false, '项目层不再有这条');
assert.equal(store.loadIndex(store.globalScope()).entries.some((row) => row.id === movedOut.body.id), true, '全局层拿到这条');
const movedBack = await call('/lite-memory/move', {
  sessionId: 'session-move', target: 'project', id: movedOut.body.id,
});
assert.equal(movedBack.status, 200);
assert.equal(movedBack.body.to, 'project');
assert.equal(store.loadIndex(store.scopeOf(moveCwd)).entries.some((row) => row.id === movedBack.body.id), true, '搬回当前项目');
assert.equal(store.loadIndex(store.globalScope()).entries.some((row) => row.id === movedOut.body.id), false, '全局层不再有这条');

// ── 「记住我」路由：只有枚举值，动作失败必须带原因 ────────────────────────────
const personaFresh = await call('/lite-memory/persona', {});
assert.equal(personaFresh.status, 200);
assert.equal(personaFresh.body.ok, true);
assert.equal(personaFresh.body.enabled, false, '默认关闭');
assert.equal(personaFresh.body.catalog.length, 8, '八个维度都要能选');
assert.ok(personaFresh.body.formed.length === 0 && personaFresh.body.observing.length === 0);

assert.equal((await call('/lite-memory/persona', { op: '乱来' })).status, 400);
assert.equal((await call('/lite-memory/persona', { op: 'edit', dimension: 'tone' })).status, 400);
assert.equal((await call('/lite-memory/persona', { op: 'reject' })).status, 400);
const unknownDimension = await call('/lite-memory/persona', { op: 'reject', dimension: '根本不存在的维度' });
assert.equal(unknownDimension.status, 409);
assert.equal(unknownDimension.body.ok, false);
assert.equal(unknownDimension.body.reason, '没有这个维度');

const enabled = await call('/lite-memory/persona', { op: 'enable' });
assert.equal(enabled.body.enabled, true);
assert.equal(enabled.body.changed, true);
const shaped = await call('/lite-memory/persona', { op: 'edit', dimension: 'tone', value: 'direct' });
assert.equal(shaped.status, 200);
assert.equal(shaped.body.formed.length, 1, '人工确认立即形成');
assert.equal(shaped.body.formed[0].dimension, 'tone');
assert.equal(shaped.body.formed[0].valueLabel, '直接');
assert.equal(shaped.body.formed[0].lockedByUser, true);
const badValue = await call('/lite-memory/persona', { op: 'edit', dimension: 'tone', value: '不存在的取值' });
assert.equal(badValue.status, 409);
assert.equal(badValue.body.reason, '这个取值不在该维度里');
const paused = await call('/lite-memory/persona', { op: 'reject', dimension: 'tone' });
assert.equal(paused.status, 200);
assert.equal(paused.body.formed.length, 0, '「不用这个」立即停用，不再出现在已形成里');
const reformed = await call('/lite-memory/persona', { op: 'edit', dimension: 'tone', value: 'plain' });
assert.equal(reformed.body.formed.length, 1, '人手改回来就重新形成');
assert.equal(reformed.body.formed[0].value, 'plain');
// 「记住我」第一段：本回合先本地筛，只有明确偏好信号才进待确认队列；不用模型
const personaStoreMod = await import('../persona-store.js');
const queuedBefore = (personaStoreMod.readPersona().persona.pending || []).length;
const personaSig = new AbortController().signal;
await preStep({ agent: recallAgent, signal: personaSig, turn: '41' }, pass('以后都先给结论，别铺垫', 'p1'));
const queued = personaStoreMod.readPersona().persona.pending || [];
assert.equal(queued.length, queuedBefore + 1, '明确偏好信号要进待确认队列');
assert.equal(queued.at(-1).dimension, 'answer_order');
assert.equal(queued.at(-1).value, 'conclusion_first');
await preStep({ agent: recallAgent, signal: personaSig, turn: '42' }, pass('今天看了个电影', 'p2'));
assert.equal((personaStoreMod.readPersona().persona.pending || []).length, queuedBefore + 1, '没有偏好信号就不写文件');
// 「记住我」第二段：模型通道缺席时直接放过，不烧掉 24 小时窗口
for (let i = 0; i < 5; i += 1) {
  personaStoreMod.queuePersonaPending({ snippet: { text: '以后都先给结论，别铺垫', sessionId: 'session-recall', taskId: '' } });
}
const learningBefore = personaStoreMod.readPersona().persona.learning || {};
llmImpl = null;
const turnEnd = subscriptions.get('session/event');
assert.equal(typeof turnEnd, 'function');
turnEnd({ id: 'session-recall', header: { cwd } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
await new Promise((resolve) => setTimeout(resolve, 150));
const learningAfter = personaStoreMod.readPersona().persona.learning || {};
assert.equal(learningAfter.lastPassAt || '', learningBefore.lastPassAt || '', '没有模型就不占这次窗口');
const cleared = await call('/lite-memory/persona', { op: 'clear' });
assert.equal(cleared.status, 200);
assert.equal(cleared.body.formed.length, 0);
assert.equal(cleared.body.observing.length, 0);
const turnedOff = await call('/lite-memory/persona', { op: 'disable' });
assert.equal(turnedOff.body.enabled, false);

console.log('contract.test.mjs: all passed');
