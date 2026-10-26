import assert from 'node:assert/strict';

let seen = null;
let plugin = null;
const fakeReact = { createElement: () => null, useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}], useEffect: () => {}, useMemo: (fn) => fn() };
globalThis.window = { __ModuleLoader__: { load: (definition) => { plugin = definition.factory((name) => (name === 'react' ? fakeReact : null)); } } };
globalThis.__LITE_MEMORY_TEST__ = (helpers) => { seen = helpers; };
await import('../client.js');
assert.ok(seen, 'client test seam missing');

// 会话头的项目开关：注册到宿主认的位置，状态只能问服务端。
const registrations = [];
const slots = {
  inject: (_name, callback) => callback(),
  register: (definition) => { registrations.push(definition); return () => {}; },
};
plugin.apply({ slots, sessions: { binding: () => undefined }, uiConversation: {} });
const evolution = registrations.find((item) => item.id === 'lite-memory:project-evolution');
assert.ok(evolution, '项目开关没有注册');
assert.equal(evolution.name, 'conversation.session.header.utilities');
assert.equal(evolution.order, 30);

// 记忆面板占整框浮层，不挤在会话列里。
const panel = registrations.find((item) => item.id === 'lite-memory:panel');
assert.ok(panel, '记忆面板没有注册');
assert.equal(panel.name, 'shell.overlay');
assert.equal(panel.order, 30);

const { metaOf, citationOf, citationsOfMeta, citationsOfTurn, dedupe, undoRefOf, graphOf, ruleGraphOf, processingStatusOf, currentBodyOf, historyDiffsOf } = seen;

// 图谱只按真实数据画：共享标签成枢纽，显式关联成边，位置由 id 决定。
const graph = graphOf([
  { id: 'mem_aaaaaaaa', title: 'A', tags: ['发布'], topicKey: '上线', experimental: false, links: [{ id: 'mem_bbbbbbbb' }] },
  { id: 'mem_bbbbbbbb', title: 'B', tags: ['发布'], topicKey: '上线', experimental: true, links: [] },
  { id: 'mem_cccccccc', title: 'C', tags: ['环境'], topicKey: '', experimental: false, links: [] },
]);
assert.equal(graph.nodes.filter((node) => node.kind === 'memory').length, 3);
assert.equal(graph.nodes.some((node) => node.id === 'tag:发布'), true);
assert.equal(graph.nodes.some((node) => node.id === 'tag:环境'), true);
assert.equal(graph.nodes.some((node) => node.id === 'topic:上线'), true);
assert.equal(graph.edges.filter((edge) => edge.type === 'tag').length, 3);
assert.equal(graph.edges.filter((edge) => edge.type === 'link').length, 1);
assert.deepEqual(graphOf([{ id: 'mem_aaaaaaaa', title: 'A' }]).nodes[0].x, graphOf([{ id: 'mem_aaaaaaaa', title: 'A' }]).nodes[0].x);
const pair = graphOf([{ id: 'mem_aaaaaaaa', title: 'A' }, { id: 'mem_bbbbbbbb', title: 'B' }]);
assert.notEqual(pair.nodes[0].x, pair.nodes[1].x);
assert.notEqual(pair.nodes[0].y, pair.nodes[1].y);

// 经验图谱只按共享的适用条件相连，不画没有依据的关系。
const rules = [
  { id: 'ev_aaaaaaaa', title: 'A', state: 'active', conditions: [{ key: 'seriesId', value: '口播' }] },
  { id: 'ev_bbbbbbbb', title: 'B', state: 'trial', conditions: [{ key: 'seriesId', value: '口播' }, { key: 'phase', value: '初稿' }] },
  { id: 'ev_cccccccc', title: 'C', state: 'pending', conditions: [{ key: 'phase', value: '初稿' }] },
];
const ruleGraph = ruleGraphOf(rules);
assert.equal(ruleGraph.nodes.filter((node) => node.kind === 'rule').length, 3);
assert.equal(ruleGraph.nodes.some((node) => node.id === 'condition:seriesId:口播'), true);
assert.equal(ruleGraph.nodes.some((node) => node.id === 'condition:phase:初稿'), true);
assert.equal(ruleGraph.edges.length, 4);
assert.equal(ruleGraph.edges.every((edge) => edge.type === 'condition'), true);
assert.equal(ruleGraph.nodes.some((node) => node.kind === 'tag' || node.kind === 'topic'), false);
assert.deepEqual(ruleGraphOf(rules).nodes.map((node) => [node.id, node.x, node.y]), ruleGraph.nodes.map((node) => [node.id, node.x, node.y]));
assert.equal(ruleGraphOf([{ id: 'ev_aaaaaaaa', title: 'A', state: 'active', conditions: [] }]).edges.length, 0);

const settled = (meta, extra = {}) => ({ kind: 'tool-result', meta, isError: false, content: [], ...extra });

// 元数据只从落定结果里取，错误块和旧块一律不认。
assert.equal(metaOf(settled({ kind: 'memory-read', id: 'mem_aaaaaaaa' })).kind, 'memory-read');
assert.equal(metaOf({ phase: 'preparing' }), null);
assert.equal(metaOf(settled({ kind: 'memory-read', id: 'mem_aaaaaaaa' }, { isError: true })), null);
assert.equal(metaOf(settled(null)), null);
assert.equal(metaOf(settled([{ kind: 'memory-read' }])), null);

// 保存只在真的改了时进引用；正文保存不冒充引用。
const save = citationOf({ kind: 'memory-save', id: 'mem_aaaaaaaa', title: 'A', scope: 'project', revision: 3, changed: false, mode: 'unchanged' }, 'memory-save');
assert.equal(save, null);
const changed = citationOf({ kind: 'memory-save', id: 'mem_aaaaaaaa', title: 'A', scope: 'global', revision: 2, changed: true, mode: 'updated' }, 'memory-save');
assert.equal(changed.exposure, 'update');
assert.equal(changed.scope, 'global');

// 没有真改动、缺版本、缺工作目录的写入行不产生撤销入口。
assert.equal(undoRefOf({ kind: 'memory-save', id: 'mem_aaaaaaaa', revision: 3, changed: false }, '/tmp/p'), null);
assert.equal(undoRefOf({ kind: 'memory-save', id: 'mem_aaaaaaaa', revision: 3 }, '/tmp/p'), null);
assert.equal(undoRefOf({ kind: 'memory-save', id: 'mem_aaaaaaaa', revision: 3, changed: true }, ''), null);
assert.equal(undoRefOf({ kind: 'memory-save', id: 'mem_aaaaaaaa', revision: 2, changed: true }, '/tmp/p').revision, 2);

// 搜索的多条引用按 refs 展开；删除/归档状态原样保留。
const refs = citationsOfMeta({ kind: 'memory-search', refs: [
  { id: 'mem_aaaaaaaa', title: 'A', scope: 'project', revision: 1, status: 'ok' },
  { id: 'mem_bbbbbbbb', title: 'B', scope: 'global', revision: 4, status: 'archived' },
  { id: 'sug_cccccccc', title: 'C', scope: 'global', revision: 1, status: 'ok' },
] });
assert.equal(refs.length, 2);
assert.equal(refs[1].status, 'archived');
assert.equal(refs[0].exposure, 'reference');

// 一轮里 PTC 子结果也算；同 id 同用途只留一条，位置不变、内容取最新。
const nodes = [
  { root: settled({ kind: 'memory-search', refs: [
    { id: 'mem_aaaaaaaa', title: 'A', scope: 'project', revision: 1, status: 'ok' },
  ] }) },
  { root: settled({ kind: 'memory-read', id: 'mem_aaaaaaaa', title: 'A2', scope: 'project', revision: 2, status: 'ok' }, { subCalls: [settled({ kind: 'memory-read', id: 'mem_aaaaaaaa', title: 'A3', scope: 'project', revision: 2, status: 'ok' })] }) },
  { root: settled({ kind: 'memory-read', id: 'mem_bbbbbbbb', title: 'B', scope: 'global', revision: 1, status: 'ok' }) },
];
const turn = dedupe(citationsOfTurn(nodes));
assert.equal(turn.length, 2);
assert.equal(turn[0].id, 'mem_aaaaaaaa');
assert.equal(turn[0].revision, 2);
assert.equal(turn[0].title, 'A3');
assert.equal(turn[1].id, 'mem_bbbbbbbb');

// 旧行没有元数据：什么也不产出，绝不从文案猜 id。
assert.deepEqual(citationsOfTurn([{ root: null }, { root: { kind: 'tool-result', content: [{ type: 'text', text: 'memory · saved "A" mem_aaaaaaaa' }] } }]), []);

// 处理状态只认服务端枚举；中文 reason 不参与猜测。
assert.equal(processingStatusOf({ processingStatus: 'applied' }), 'applied');
assert.equal(processingStatusOf({ outcome: { status: 'superseded' } }), 'superseded');
assert.equal(processingStatusOf({ status: 'failed' }), 'failed');
assert.equal(processingStatusOf({ status: 'ok', reason: '处理失败' }), '');
assert.equal(processingStatusOf({ reason: '已应用' }), '');

// 当前正文与历史版本分开：历史行只给 old → new，不拼进当前正文。
const memoryPayload = {
  currentBody: '新的正文',
  versions: [
    { revision: 1, body: '旧的正文', at: '2026-01-01' },
    { revision: 2, body: '中间正文', at: '2026-02-01' },
  ],
};
assert.equal(currentBodyOf(memoryPayload), '新的正文');
const diffs = historyDiffsOf(memoryPayload);
assert.equal(diffs.length, 2);
assert.equal(diffs[0].old, '旧的正文');
assert.equal(diffs[0].next, '中间正文');
assert.equal(diffs[1].next, '新的正文');
assert.equal(currentBodyOf({ record: { current: { body: '记录正文' }, body: '旧字段' } }), '记录正文');
assert.deepEqual(historyDiffsOf({ body: '单版本' }), []);

// 图谱截断时保留真实总数，60 是绘制上限而不是总数。
const many = Array.from({ length: 65 }, (_, index) => ({ id: `mem_${String(index).padStart(8, '0')}`, title: `T${index}` }));
const big = graphOf(many);
assert.equal(big.shown, 60);
assert.equal(big.total, 65);
assert.equal(big.nodes.filter((node) => node.kind === 'memory').length, 60);
assert.equal(ruleGraphOf(Array.from({ length: 65 }, (_, index) => ({ id: `ev_${String(index).padStart(8, '0')}`, title: `R${index}`, conditions: [] }))).total, 65);

console.log('client.test.mjs: 14 passed');
