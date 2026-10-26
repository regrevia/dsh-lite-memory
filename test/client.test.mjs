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

const { metaOf, citationOf, citationsOfMeta, citationsOfTurn, dedupe, undoRefOf, graphOf } = seen;

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

console.log('client.test.mjs: 11 passed');
