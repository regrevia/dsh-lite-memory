import assert from 'node:assert/strict';

let seen = null;
let plugin = null;
const makeNode = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const fakeReact = { createElement: makeNode, useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}], useEffect: () => {}, useMemo: (fn) => fn() };
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

const EMPTY_CHILDREN = [];
const { metaOf, citationOf, citationsOfMeta, citationsOfTurn, dedupe, undoRefOf, graphOf, ruleGraphOf, processingStatusOf, currentBodyOf, historyDiffsOf, MemoryPanel, MemoryGraph, displayKeyOf, readDisplaySettings, writeDisplaySettings, graphViewOf, viewModeOf, filterRecords, projectionOf, failureStateOf, evidenceTextOf, evidenceMetaOf, MemoryPalace, palaceRoomsOf, palaceRoomPageOf, palacePageWindow, palaceToggleOf, palaceMotionOf, palaceRoomIdOf, TurnMemory, refMetaOf, explainKeyOf, explainModeOf, setExplainMode, recallLineOf, agoLabel, checkupOf, titleCountsOf, rowKeyOf, rowKeepFlags } = seen;

// 图谱只按真实数据画：共享标签成枢纽，显式关联成边，位置由 id 决定。
const graph = graphOf([
  { id: 'mem_aaaaaaaa', title: 'A', tags: ['发布'], topicKey: '上线', experimental: false, links: [{ id: 'mem_bbbbbbbb' }] },
  { id: 'mem_bbbbbbbb', title: 'B', tags: ['发布'], topicKey: '上线', experimental: true, links: [] },
  { id: 'mem_cccccccc', title: 'C', tags: ['环境'], topicKey: '', experimental: false, links: [] },
]);
assert.equal(graph.nodes.filter((node) => node.kind === 'memory').length, 3);
assert.equal(graph.nodes.some((node) => node.id === 'tag:发布'), true);
assert.equal(graph.nodes.some((node) => node.id === 'tag:环境'), false);
assert.equal(graph.nodes.some((node) => node.id === 'topic:上线'), false);
assert.equal(graph.edges.filter((edge) => edge.type === 'tag').length, 2);
assert.equal(graph.edges.filter((edge) => edge.type === 'link').length, 1);
assert.deepEqual(graphOf([{ id: 'mem_aaaaaaaa', title: 'A' }]).nodes[0].x, graphOf([{ id: 'mem_aaaaaaaa', title: 'A' }]).nodes[0].x);
const pair = graphOf([{ id: 'mem_aaaaaaaa', title: 'A' }, { id: 'mem_bbbbbbbb', title: 'B' }]);
assert.notEqual(pair.nodes[0].x, pair.nodes[1].x);
assert.notEqual(pair.nodes[0].y, pair.nodes[1].y);

// 共享标签是组：枢纽点比成员大，成员围着它，孤立记忆留在外圈；被更强组吸收的次要标签不另画。
const hubNode = graph.nodes.find((node) => node.id === 'tag:发布');
const memberA = graph.nodes.find((node) => node.id === 'mem_aaaaaaaa');
const memberC = graph.nodes.find((node) => node.id === 'mem_cccccccc');
assert.ok(hubNode && memberA && memberC);
assert.ok(hubNode.radius > memberA.radius + 4, '共享标签枢纽应比成员大');
assert.ok(Math.hypot(memberA.x - hubNode.x, memberA.y - hubNode.y) < 90, '成员应靠近所属枢纽');
assert.ok(Math.hypot(memberC.x - hubNode.x, memberC.y - hubNode.y) > 90, '无共享标签的记忆应留在外圈');

// 一条记忆只连自己所属组的枢纽：别的共享标签不画跨组虚线。
const overlap = graphOf([
  { id: 'mem_dddddddd', title: 'D', tags: ['X', 'Y'] },
  { id: 'mem_eeeeeeee', title: 'E', tags: ['X', 'Y'] },
  { id: 'mem_ffffffff', title: 'F', tags: ['X'] },
  { id: 'mem_gggggggg', title: 'G', tags: ['Y'] },
  { id: 'mem_hhhhhhhh', title: 'H', tags: ['Y'] },
  { id: 'mem_iiiiiiii', title: 'I', tags: ['X'] },
]);
const overlapTags = overlap.edges.filter((edge) => edge.type === 'tag').map((edge) => `${edge.from}>${edge.to}`);
assert.equal(overlapTags.length, 6);
assert.equal(overlapTags.includes('mem_dddddddd>tag:Y'), false);
assert.equal(overlapTags.includes('mem_eeeeeeee>tag:Y'), false);

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
const save = citationOf({ kind: 'memory-save', title: 'A', scope: 'project', revision: 3, changed: false, mode: 'unchanged' }, 'memory-save');
assert.equal(save, null);
const changed = citationOf({ kind: 'memory-save', title: 'A', scope: 'global', revision: 2, changed: true, mode: 'updated' }, 'memory-save');
assert.equal(changed.exposure, 'update');
assert.equal(changed.scope, 'global');

// 没有真改动、缺版本、缺工作目录的写入行不产生撤销入口。
assert.equal(undoRefOf({ kind: 'memory-save', title: 'A', revision: 3, changed: false }, '/tmp/p'), null);
assert.equal(undoRefOf({ kind: 'memory-save', title: 'A', revision: 3 }, '/tmp/p'), null);
assert.equal(undoRefOf({ kind: 'memory-save', title: 'A', revision: 3, changed: true }, ''), null);
assert.equal(undoRefOf({ kind: 'memory-save', revision: 2, changed: true }, '/tmp/p'), null);
assert.equal(undoRefOf({ kind: 'memory-save', title: 'A', revision: 2, changed: true }, '/tmp/p').revision, 2);

// 搜索的多条引用按 refs 展开；删除/归档状态原样保留。
const refs = citationsOfMeta({ kind: 'memory-search', refs: [
  { title: 'A', scope: 'project', revision: 1, status: 'ok' },
  { title: 'B', scope: 'global', revision: 4, status: 'archived' },
  { title: '', scope: 'global', revision: 1, status: 'ok' },
] });
assert.equal(refs.length, 2);
assert.equal(refs[1].status, 'archived');
assert.equal(refs[0].exposure, 'reference');

// 一轮里 PTC 子结果也算；同 id 同用途只留一条，位置不变、内容取最新。
const nodes = [
  { root: settled({ kind: 'memory-search', refs: [
    { title: 'A', scope: 'project', revision: 1, status: 'ok' },
  ] }) },
  { root: settled({ kind: 'memory-read', title: 'A', scope: 'project', revision: 2, status: 'ok' }, { subCalls: [settled({ kind: 'memory-read', title: 'A', scope: 'project', revision: 2, status: 'ok' })] }) },
  { root: settled({ kind: 'memory-read', title: 'B', scope: 'global', revision: 1, status: 'ok' }) },
];
const turn = dedupe(citationsOfTurn(nodes));
assert.equal(turn.length, 2);
assert.equal(turn[0].title, 'A');
assert.equal(turn[0].revision, 2);
assert.equal(turn[1].title, 'B');
assert.equal('id' in turn[0], false);

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

// 显示设置只决定画不画；按项目 key 分开存，默认都关。
const memoryStore = new Map();
globalThis.localStorage = { getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null), setItem: (key, value) => memoryStore.set(key, String(value)) };
assert.equal(displayKeyOf('project:/a'), 'lite-memory:display:project:/a');
assert.notEqual(displayKeyOf('project:/a'), displayKeyOf('project:/b'));
assert.deepEqual(readDisplaySettings('project:/a'), { graph: false, palace: false });
writeDisplaySettings('project:/a', { graph: true, palace: false });
assert.deepEqual(readDisplaySettings('project:/a'), { graph: true, palace: false });
assert.deepEqual(readDisplaySettings('project:/b'), { graph: false, palace: false });
memoryStore.set(displayKeyOf('project:/c'), '{oops');
assert.deepEqual(readDisplaySettings('project:/c'), { graph: false, palace: false });
assert.equal(graphViewOf(false, 'graph'), 'list');
assert.equal(graphViewOf(true, 'graph'), 'graph');
assert.equal(graphViewOf(undefined, 'graph'), 'list');

// 点标签/主题按精确值筛，不把「发布」发散成「发布会」。
const tagged = [
  { id: 'mem_aaaaaaaa', title: '发布记录', tags: ['发布'], topicKey: '上线' },
  { id: 'mem_bbbbbbbb', title: '发布会记录', tags: ['发布会'], topicKey: '上线复盘' },
];
assert.deepEqual(filterRecords(tagged, '', { kind: 'tag', value: '发布' }).map((row) => row.id), ['mem_aaaaaaaa']);
assert.deepEqual(filterRecords(tagged, '', { kind: 'topic', value: '上线' }).map((row) => row.id), ['mem_aaaaaaaa']);
assert.deepEqual(filterRecords(tagged, '发布会', null).map((row) => row.id), ['mem_bbbbbbbb']);

// 60 条投影外也要保住当前选中项，不能点开就消失。
const long = Array.from({ length: 65 }, (_, index) => ({ id: `mem_${String(index).padStart(8, '0')}`, title: `T${index}` }));
const kept = projectionOf(long, long[64].id);
assert.equal(kept.length, 60);
assert.equal(kept[59].id, long[64].id);
assert.equal(graphOf(long, long[64].id).nodes.some((node) => node.id === long[64].id), true);
assert.equal(graphOf(long).nodes.some((node) => node.id === long[64].id), false);

// 失败分当前和过去：只有最近一次失败才提示现有经验没更新。
assert.equal(failureStateOf({ economy: { recent: [{ status: 'failed' }, { status: 'applied' }] } }), 'current');
assert.equal(failureStateOf({ economy: { recent: [{ status: 'applied' }, { status: 'failed' }] } }), 'past');
assert.equal(failureStateOf({ economy: { recent: [{ status: 'applied' }] } }), '');
assert.equal(failureStateOf(null), '');

// 学习依据读真实摘录与样例元数据，不再拿「样例」占位。
assert.equal(evidenceTextOf({ sourceExcerpt: '用户说别用渐变' }), '用户说别用渐变');
assert.equal(evidenceTextOf({ excerpt: '原文' }), '原文');
assert.equal(evidenceTextOf({ note: '备注' }), '备注');
assert.equal(evidenceTextOf({ feedbackType: 'negative' }), '');
assert.equal(evidenceMetaOf({ artifactVersion: 2, dimension: '排版', verified: true, at: '2026-03-04T00:00:00Z' }), '第 2 版 · 排版 · 已核对 · 2026-03-04');
assert.equal(evidenceMetaOf({ verified: false }), '未核对');

// 显示设置默认关闭：面板首帧只出列表，不挂载图谱组件。
const nodeTypes = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.type) out.push(node.type);
  for (const child of node.children || EMPTY_CHILDREN) nodeTypes(child, out);
  return out;
};
const firstPaint = MemoryPanel({ sessionId: 'demo', onClose: () => {} });
assert.ok(firstPaint, '面板首帧应渲染');
assert.equal(nodeTypes(firstPaint).includes(MemoryGraph), false);
assert.equal(JSON.stringify(nodeTypes(firstPaint)).includes('MemoryGraph'), false);
assert.equal(nodeTypes(firstPaint).includes(MemoryPalace), false);
assert.equal(JSON.stringify(nodeTypes(firstPaint)).includes('MemoryPalace'), false);


// 记忆宫殿：固定四间，空房保留位置，未知类型有归处。
const palaceRecord = (id, kind, title = id) => ({ id, kind, title });
const palaceRooms = palaceRoomsOf([
  palaceRecord('mem_1', 'note'), palaceRecord('mem_2', 'pointer'), palaceRecord('mem_3', 'procedure'),
  palaceRecord('mem_4', 'preference'), palaceRecord('mem_5', 'convention'), palaceRecord('mem_6', 'pitfall'),
  palaceRecord('mem_7', 'credential_hint'), palaceRecord('mem_8', 'unknown_kind'),
]);
assert.deepEqual(palaceRooms.map((room) => room.name), ['习惯与规范', '方法与经验', '资料与入口', '其他记录']);
assert.deepEqual(palaceRooms.map((room) => room.total), [2, 2, 2, 2]);
assert.equal(palaceRoomIdOf('unknown_kind'), 'notes');
assert.deepEqual(palaceRoomsOf([palaceRecord('mem_9', 'note')]).map((room) => room.total), [0, 0, 0, 1]);
assert.equal(palaceRoomsOf([]).length, 4);
// 每页 24 条；页码夹在有效范围内。
const palaceMany = Array.from({ length: 25 }, (_, index) => palaceRecord(`mem_${index}`, 'preference', `P${index}`));
assert.equal(palaceRoomsOf(palaceMany)[0].pages, 2);
assert.equal(palaceRoomPageOf(palaceMany, 'habits', 1).items.length, 24);
assert.equal(palaceRoomPageOf(palaceMany, 'habits', 2).items.length, 1);
assert.equal(palaceRoomPageOf(palaceMany, 'habits', 99).page, 2);
assert.equal(palaceRoomPageOf(palaceMany, 'habits', 0).page, 1);
assert.deepEqual(palacePageWindow(1, 3), [1, 2, 3]);
assert.deepEqual(palacePageWindow(5, 12), [2, 3, 4, 5, 6, 7, 8]);
assert.equal(palacePageWindow(12, 12).includes(12), true);
// 同一时刻只展开一间，再点收起。
assert.equal(palaceToggleOf('', 'methods'), 'methods');
assert.equal(palaceToggleOf('methods', 'methods'), '');
assert.equal(palaceToggleOf('methods', 'habits'), 'habits');
// 关闭时回列表；减少动态时 0ms，否则 180ms。
assert.equal(viewModeOf({ graph: true, palace: false }, 'palace'), 'list');
assert.equal(viewModeOf({ graph: false, palace: true }, 'palace'), 'palace');
assert.equal(palaceMotionOf(true).duration, 0);
assert.equal(palaceMotionOf(false).duration, 180);
// 展品点开只把 id 交给现有详情入口，不另造详情。
let palacePicked = '';
const palaceTree = MemoryPalace({
  records: [palaceRecord('mem_a', 'preference', 'A')],
  selectedId: '', onPick: (id) => { palacePicked = id; }, emptyText: '这个项目还没有记忆',
});
const expandNodes = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.type === 'function') return expandNodes(node.type(node.props), out);
  out.push(node);
  for (const child of node.children || []) expandNodes(child, out);
  return out;
};
const palaceExhibit = expandNodes(palaceTree).find((node) => node.type === 'button' && node.props.title === 'A');
assert.ok(palaceExhibit, '展品应是原生按钮');
palaceExhibit.props.onClick();
assert.equal(palacePicked, 'mem_a');
const palaceEmpty = MemoryPalace({ records: [], selectedId: '', onPick: () => {}, emptyText: '这个项目还没有记忆' });
assert.equal(expandNodes(palaceEmpty).some((node) => node.children.includes('这个项目还没有记忆')), true);

// 引用行只标层与来源：类型留在数据里给检索用，不上会话界面。
const typedSearch = citationOf({ title: 'A', scope: 'global', revision: 1, status: 'ok', kind: 'preference' }, 'memory-search');
assert.equal(typedSearch.entryKind, 'preference');
assert.equal(refMetaOf(typedSearch), '[全局]');
assert.equal(citationOf({ kind: 'memory-read', title: 'P', recordKind: 'procedure', scope: 'project', revision: 2 }, 'memory-read').entryKind, 'procedure');
assert.equal(refMetaOf({ scope: 'project', origin: 'user_explicit' }), '[项目]');
assert.equal(refMetaOf({ scope: 'global', origin: 'project_evolution' }), '[全局][自进化]');
/** 模型整理稿只多一个信任标记，层级仍按落盘作用域。 */
assert.equal(refMetaOf({ scope: 'project', origin: 'model_drafted' }), '[项目][模型]');
assert.equal(citationOf({ kind: 'memory-save', title: 'M', scope: 'global', revision: 1, origin: 'model_drafted', changed: true }, 'memory-save').origin, 'model_drafted');
/** 更新距今照旧，只是不再拼类型与「你记的」。 */
const aged = citationOf({ kind: 'preference', title: 'C', scope: 'global', revision: 1, updated: new Date(Date.now() - 3 * 86_400_000).toISOString() }, 'memory-search');
assert.equal(aged.entryKind, 'preference');
assert.equal(refMetaOf(aged), '[全局] · 3 天前更新');
assert.equal(agoLabel(''), '');
assert.equal(agoLabel(new Date(Date.now() - 40 * 86_400_000).toISOString()), '');

// 解释模式按会话存在本机，缺省关闭；关着零命中不出提示，打开后才说原因。
assert.equal(explainModeOf('s1'), false);
const quietRefs = [];
Object.defineProperty(quietRefs, 'noTriggerReason', { value: '当前任务不适用', enumerable: false, configurable: true });
assert.equal(TurnMemory({ sessionId: 's1', turn: '7', useRefs: () => quietRefs }), null);
setExplainMode('s1', true);
assert.equal(explainModeOf('s1'), true);
assert.equal(explainModeOf('s2'), false);
const told = TurnMemory({ sessionId: 's1', turn: '7', useRefs: () => quietRefs });
assert.ok(told);
assert.equal(JSON.stringify(told).includes('当前任务不适用'), true);
assert.equal(explainKeyOf('s1').startsWith('lite-memory:explain:'), true);


const checkupRows = [
  { id: 'mem_c0000001', title: '同一件事', when: '', lastUsed: '' },
  { id: 'mem_c0000002', title: '同一件事', when: '当 A 时', lastUsed: '2026-01-01T00:00:00.000Z' },
  { id: 'mem_c0000003', title: '另一件', when: '当 B 时', lastUsed: '2026-01-01T00:00:00.000Z' },
];
const checkupScopes = [{ key: 'p', kind: 'project', entries: 3 }, { key: 'global', kind: 'global', entries: 213 }];
assert.deepEqual(checkupOf(checkupRows, checkupScopes, false), { duplicate: 1, unread: 1, globalEntries: 213, globalMissingWhen: null });
assert.deepEqual(checkupOf(checkupRows, checkupScopes, true), { duplicate: 1, unread: 1, globalEntries: 213, globalMissingWhen: 1 });
assert.deepEqual(filterRecords(checkupRows, '', { kind: 'duplicate' }).map((row) => row.id), ['mem_c0000001', 'mem_c0000002']);
assert.deepEqual(filterRecords(checkupRows, '', { kind: 'unread' }).map((row) => row.id), ['mem_c0000001']);
assert.deepEqual(filterRecords(checkupRows, '', { kind: 'noWhen' }).map((row) => row.id), ['mem_c0000001']);
assert.deepEqual([...titleCountsOf(checkupRows).values()], [2, 1]);
assert.equal(checkupOf([], [], false).globalEntries, null);
// 两条一模一样的拦截结果在同一轮里只展示一行：拦截结果没有 id，只能按曝光类型 + 文案 + 正文认。
const blockedBlock = (text) => ({ kind: 'tool-result', callId: 'call-a', content: [{ type: 'text', text }], subCalls: [] });
const blockedText = 'memory · 这条记忆的适用条件还没确认，先说明当前任务再读';
assert.equal(blockedText.includes('mem_'), false);
const blockedKeys = [rowKeyOf('memory_read', blockedBlock(blockedText)), rowKeyOf('memory_read', blockedBlock(blockedText))];
assert.equal(blockedKeys[0].length > 0, true);
assert.deepEqual(rowKeepFlags(blockedKeys), [true, false]);
assert.equal(blockedKeys.filter((_key, at) => rowKeepFlags(blockedKeys)[at]).length, 1);
assert.deepEqual(rowKeepFlags([rowKeyOf('memory_search', blockedBlock(blockedText)), rowKeyOf('memory_read', blockedBlock(blockedText))]), [true, true]);
assert.deepEqual(rowKeepFlags([rowKeyOf('memory_read', blockedBlock('memory · stopped'))]), [true]);
// 面板要能回答「为什么这次没提醒我」：只给结论和条数，不露原因码。
assert.equal(recallLineOf(null), '');
assert.equal(recallLineOf({ reason: 'hit', cards: 1, matched: 1 }), '上次自动提醒 1 条');
assert.equal(recallLineOf({ reason: 'budget', cards: 0, matched: 2 }), '上次没提醒，2 条相关记忆，本轮自动提醒已用满');
assert.equal(recallLineOf({ reason: 'needs_context', cards: 0, matched: 1 }), '上次没提醒，1 条相关记忆，适用条件未确认');
assert.equal(recallLineOf({ reason: 'conflict', cards: 0, matched: 2 }), '上次没提醒，2 条相关记忆，存在冲突的结论');
assert.equal(recallLineOf({ reason: 'no_overlap', cards: 0, matched: 0 }), '上次没提醒，没有匹配的记忆');
assert.equal(recallLineOf({ reason: 'memory_off', cards: 0, matched: 0 }), '上次没提醒，记忆已关闭');
assert.equal(recallLineOf({ reason: 'tools_only', cards: 0, matched: 0 }), '上次没提醒，只在你问时检索');
assert.equal(recallLineOf({ reason: 'made_up', cards: 0, matched: 0 }), '');
assert.doesNotMatch(recallLineOf({ reason: 'needs_context', cards: 0, matched: 1 }), /needs_context|reasonCode/);
console.log('client.test.mjs: 22 passed + palace');

