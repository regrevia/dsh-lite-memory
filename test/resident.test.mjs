import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-resident-'));
const { apply } = await import('../index.js');

const effect = (fn) => {
  const dispose = fn();
  return typeof dispose === 'function' ? dispose : () => {};
};

const defs = new Map();
const ctx = {
  tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
  effect,
  inject: () => () => {},
  get: () => undefined,
  on: () => () => {},
};
apply(ctx);

const bytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null));
const resident = (def) => bytes(def.description) + bytes(def.parameters) + bytes(def.output?.schema ?? null);

/* 常驻提示每轮都要发一遍：工具定义变大就是每次请求都变贵。 */
const caps = {
  memory_save: 5860,
  memory_suggest: 2900,
  memory_search: 1750,
  memory_read: 1350,
  memory_forget: 1000,
  memory_persona: 1350,
  memory_tune: 1650,
};
/* 门槛按真实注册表算：新增工具必须同时补一条上限，不能悄悄绕开这份账。 */
assert.deepEqual([...defs.keys()].sort(), Object.keys(caps).sort(), '注册的工具与常驻字节账一一对应');
let total = 0;
for (const [name, cap] of Object.entries(caps)) {
  const def = defs.get(name);
  assert.ok(def, `${name} registered`);
  const size = resident(def);
  total += size;
  assert.ok(size <= cap, `${name} resident ${size}B exceeds ${cap}B`);
}
assert.ok(total <= 15400, `resident tool text ${total}B exceeds 15400B`);
assert.ok(defs.get('memory_suggest').parameters.properties.supersedes === undefined, 'suggest does not accept supersedes');
assert.ok(defs.get('memory_suggest').parameters.properties.mode === undefined, 'suggest does not accept mode');
console.log('resident tool text', total, 'bytes');
