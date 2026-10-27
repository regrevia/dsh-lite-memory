import assert from 'node:assert/strict';

let seen = null;
const makeNode = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const fakeReact = {
  createElement: makeNode,
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
};
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      definition.factory((name) => (name === 'react' ? fakeReact : null));
    },
  },
};
globalThis.__LITE_MEMORY_TEST__ = (helpers) => { seen = helpers; };
await import('../client.js');
assert.ok(seen, 'client test seam missing');

const {
  MemoryPalace, MemoryPanel, viewModeOf, palaceRoomsOf, palaceRoomPageOf,
  palacePageWindow, palaceToggleOf, palaceMotionOf, palaceRoomIdOf,
} = seen;

const record = (id, kind, title = id) => ({ id, kind, title });

// 房间按固定顺序归类，未知类型落到「其他记录」，不丢记录。
const rooms = palaceRoomsOf([
  record('mem_1', 'note'),
  record('mem_2', 'pointer'),
  record('mem_3', 'procedure'),
  record('mem_4', 'preference'),
  record('mem_5', 'convention'),
  record('mem_6', 'pitfall'),
  record('mem_7', 'credential_hint'),
  record('mem_8', 'unknown_kind'),
]);
assert.deepEqual(rooms.map((room) => room.name), ['习惯与规范', '方法与经验', '资料与入口', '其他记录']);
assert.deepEqual(rooms.map((room) => room.total), [2, 2, 2, 2]);
assert.equal(palaceRoomIdOf('unknown_kind'), 'notes');
assert.deepEqual(palaceRoomsOf([record('mem_9', 'note')]).map((room) => room.total), [0, 0, 0, 1], '空房间保留位置');

// 一页固定 24 个槽位，页码夹在有效范围内。
const many = Array.from({ length: 25 }, (_, index) => record(`mem_${index}`, 'preference', `P${index}`));
const manyRooms = palaceRoomsOf(many);
assert.equal(manyRooms.length, 4);
assert.equal(manyRooms[0].total, 25);
assert.equal(manyRooms[0].pages, 2);
const first = palaceRoomPageOf(many, 'habits', 1);
assert.equal(first.items.length, 24);
assert.equal(first.page, 1);
const second = palaceRoomPageOf(many, 'habits', 2);
assert.equal(second.items.length, 1);
assert.equal(second.page, 2);
assert.equal(palaceRoomPageOf(many, 'habits', 99).page, 2);
assert.equal(palaceRoomPageOf(many, 'habits', 0).page, 1);
assert.deepEqual(palacePageWindow(1, 3), [1, 2, 3]);
assert.deepEqual(palacePageWindow(5, 12), [2, 3, 4, 5, 6, 7, 8]);
assert.equal(palacePageWindow(12, 12).includes(12), true);

// 同一时刻只展开一间：再点已展开的房间会收起。
assert.equal(palaceToggleOf('', 'methods'), 'methods');
assert.equal(palaceToggleOf('methods', 'methods'), '');
assert.equal(palaceToggleOf('methods', 'habits'), 'habits');

// 视图开关关闭时回列表，关闭的宫殿不进入组件树。
assert.equal(viewModeOf({ graph: true, palace: false }, 'palace'), 'list');
assert.equal(viewModeOf({ graph: false, palace: true }, 'palace'), 'palace');
assert.equal(viewModeOf({ graph: false, palace: false }, 'graph'), 'list');

// 减少动态时无动画，普通情况 180ms。
assert.equal(palaceMotionOf(true).duration, 0);
assert.equal(palaceMotionOf(false).duration, 180);

// 点击展品只把 record.id 交给现有详情入口，不另造详情。
let picked = '';
const tree = MemoryPalace({
  records: [record('mem_a', 'preference', 'A')],
  selectedId: '', onPick: (id) => { picked = id; }, emptyText: '这个项目还没有记忆',
});
const walk = (node, out = [], expand = false) => {
  if (!node || typeof node !== 'object') return out;
  if (expand && typeof node.type === 'function') return walk(node.type(node.props), out, true);
  out.push(node);
  for (const child of node.children || []) walk(child, out, expand);
  return out;
};
const exhibit = walk(tree, [], true).find((node) => node.type === 'button' && node.props.title === 'A');
assert.ok(exhibit, '展品应是原生按钮');
exhibit.props.onClick();
assert.equal(picked, 'mem_a');

// 首帧列表视图不挂载宫殿；空数据时给下一步提示。
const firstPaint = MemoryPanel({ sessionId: 'demo', onClose: () => {} });
assert.equal(walk(firstPaint).some((node) => node.type === MemoryPalace), false);
const emptyTree = MemoryPalace({ records: [], selectedId: '', onPick: () => {}, emptyText: '这个项目还没有记忆' });
assert.equal(walk(emptyTree).some((node) => node.children.includes('这个项目还没有记忆')), true);

console.log('palace.test.mjs: all passed');
