import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-auth-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');

const effect = (fn) => {
  const dispose = fn();
  return typeof dispose === 'function' ? dispose : () => {};
};

function boot(mode = 'adaptive') {
  const defs = new Map();
  const handlers = new Map();
  const ctx = {
    tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
    effect,
    inject: () => () => {},
    get: (name) => (name === 'systemPrompt'
      ? { context: () => () => {} }
      : name === 'agents' ? { currentInitiator: () => null } : undefined),
    on: (event, handler) => {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  };
  apply(ctx, { mode });
  return { exec: (name, args, agent) => defs.get(name).execute(args, { agent }), preStep: (payload, decision) => handlers.get('agent/pre-step').at(-1)(payload, async () => decision) };
}

let seq = 0;
const human = (body) => ({ role: 'user', id: `msg-${(seq += 1)}`, source: { kind: 'user' }, content: [{ type: 'text', text: body }] });
const enter = (...messages) => ({ kind: 'enter', messages });

const global = store.globalScope();
const titlesIn = (scope) => new Set((store.loadIndex(scope).entries || []).map((row) => row.title));
const projectOf = (dir) => store.scopeOf(dir);

function agentFor(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lite-memory-auth-${label}-`));
  return { agent: { id: `agent-${label}`, cwd: dir, session: { id: `session-${label}`, header: { cwd: dir } } }, dir };
}

const saveArgs = (title, extra = {}) => ({
  title, summary: `${title}的摘要`, body: `${title}的正文`, memoryClass: 'personal_preference', scope: 'global', ...extra,
});

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${name}`); };

await test('真人说过所有项目：落全局层', async () => {
  const runtime = boot('adaptive');
  const { agent } = agentFor('grant');
  await runtime.preStep({ agent, signal: new AbortController().signal, turn: 't1' }, enter(human('记住：以后所有项目都这样，我偏好 pnpm')));
  const out = await runtime.exec('memory_save', saveArgs('统一用 pnpm 安装依赖'), agent);
  assert.equal(out.scope, 'global');
  assert.ok(titlesIn(global).has('统一用 pnpm 安装依赖'));
});

await test('引号里的按钮文字不授权全局', async () => {
  const runtime = boot('adaptive');
  const { agent, dir } = agentFor('quote');
  await runtime.preStep({ agent, signal: new AbortController().signal, turn: 't1' }, enter(human('把按钮「以后都存全局」这句文案改成 保存')));
  const out = await runtime.exec('memory_save', saveArgs('按钮文案统一'), agent);
  assert.notEqual(out.scope, 'global');
  assert.ok(titlesIn(projectOf(dir)).has('按钮文案统一'));
});

await test('「不要存全局」保持项目层', async () => {
  const runtime = boot('adaptive');
  const { agent, dir } = agentFor('negate');
  await runtime.preStep({ agent, signal: new AbortController().signal, turn: 't1' }, enter(human('这条不要存全局，留在本项目里')));
  const out = await runtime.exec('memory_save', saveArgs('本项目只在本地跑'), agent);
  assert.notEqual(out.scope, 'global');
  assert.ok(titlesIn(projectOf(dir)).has('本项目只在本地跑'));
});

await test('tool_only 也保留本轮授权', async () => {
  const runtime = boot('tool_only');
  const { agent } = agentFor('toolonly');
  await runtime.preStep({ agent, signal: new AbortController().signal, turn: 't1' }, enter(human('以后所有项目都用 dsh-npm 发布')));
  const out = await runtime.exec('memory_save', saveArgs('发布统一走 dsh-npm'), agent);
  assert.equal(out.scope, 'global');
  assert.ok(titlesIn(global).has('发布统一走 dsh-npm'));
});

await test('没有本轮原话时模型的 scope 提案不生效', async () => {
  const runtime = boot('adaptive');
  const { agent, dir } = agentFor('noauth');
  const out = await runtime.exec('memory_save', saveArgs('无授权也想进全局'), agent);
  assert.notEqual(out.scope, 'global');
  assert.ok(titlesIn(projectOf(dir)).has('无授权也想进全局'));
});

console.log(`authorize.test.mjs: ${passed} passed`);
