/**
 * 宫殿与模型行为必须解耦：开门进屋不请求、不写记忆、不改召回结果；
 * 关掉宫殿就停掉这层的动画，不留常驻开销。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
const start = source.indexOf('const PalaceNiche =');
const end = source.indexOf('const PersonaSection =');
assert.ok(start > 0 && end > start, '宫殿实现片段应能定位');
const palace = source.slice(start, end);

/** 只读：这一段里不许有网络/宿主调用、不许有异步等待、不许写记忆。 */
const forbidden = [
  ['fetch(', '不许发请求'],
  ['request(', '不许调宿主接口'],
  ['XMLHttpRequest', '不许发请求'],
  ['postMessage', '不许往宿主投消息'],
  ['await ', '宫殿不能等任何异步结果'],
  ['markUsed', '打开宫殿不算使用'],
  ['memoryWrite', '宫殿不写记忆'],
  ['recall', '宫殿不参与召回'],
];
for (const [needle, why] of forbidden) {
  assert.equal(palace.includes(needle), false, `${why}：命中 ${needle}`);
}

/** 关闭即停：动画只在走廊、靠 rAF，卸载/离开时取消；不许有定时器。 */
assert.equal(palace.includes('requestAnimationFrame'), true, '走廊灯光应是 rAF');
assert.equal(palace.includes('cancelAnimationFrame'), true, '离开走廊或卸载必须取消 rAF');
assert.equal(/setInterval|setTimeout/.test(palace), false, '宫殿不许有定时器');

// 纯函数：同一份数据算两次结果一致，且不改原记录。
const makeNode = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const fakeReact = {
  createElement: makeNode,
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
};
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { definition.factory((name) => (name === 'react' ? fakeReact : null)); } },
};
let seen = null;
globalThis.__LITE_MEMORY_TEST__ = (helpers) => { seen = helpers; };
await import('../client.js');
const { MemoryPalace, palaceCorridorOf, PALACE_DOOR_LANES } = seen;

const records = [
  { id: 'mem_a', kind: 'preference', title: 'A' },
  { id: 'mem_b', kind: 'note', title: 'B' },
  { id: 'mem_c', kind: 'procedure', title: 'C' },
];
const snapshot = JSON.stringify(records);
const corridorOnce = JSON.stringify(palaceCorridorOf(records));
const corridorTwice = JSON.stringify(palaceCorridorOf(records));
assert.equal(corridorTwice, corridorOnce, '同一份数据两次进走廊，门位一致');
assert.equal(JSON.stringify(records), snapshot, '算门位不许改记录');
assert.equal(palaceCorridorOf(records).length, 4, `走廊固定 ${PALACE_DOOR_LANES} 扇门`);
assert.equal(palaceCorridorOf(records).every((door) => Number.isInteger(door.slot) && door.slot >= 0 && door.slot < PALACE_DOOR_LANES), true, '门位落在固定槽内');

/** 分层：走廊只有门，房间只有当前层壁龛。 */
const walk = (node, out = [], expand = false) => {
  if (!node || typeof node !== 'object') return out;
  if (expand && typeof node.type === 'function') return walk(node.type(node.props), out, true);
  out.push(node);
  for (const child of node.children || []) walk(child, out, expand);
  return out;
};
const corridorTree = walk(MemoryPalace({ records, selectedId: '', onPick: () => {} }), [], true);
const labelsOf = (tree) => tree.map((node) => node.props?.['aria-label'] || '').filter(Boolean);
assert.equal(labelsOf(corridorTree).some((label) => label.includes('壁龛')), false, '走廊里不画壁龛');
assert.equal(labelsOf(corridorTree).includes('房间门'), true, '走廊给四扇门');

const roomTree = walk(MemoryPalace({ records, openedRoom: 'habits', selectedId: '', onPick: () => {} }), [], true);
assert.equal(labelsOf(roomTree).includes('房间门'), false, '进了房间不再画走廊的门');
assert.equal(labelsOf(roomTree).some((label) => label === '习惯与规范的壁龛'), true, '房间层只展开当前房间');

console.log('palace-isolation.test.mjs: passed');
