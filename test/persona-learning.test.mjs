import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * 端到端：假模型按当前提示协议回一行 JSON，走真实的 learnPersonaOnce → parse → commit → 落盘。
 * 这里验的是链路，不是模型质量；所以只断言盘上证据与面板状态。
 */
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-persona-learning-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');
const personaStore = await import('../persona-store.js');

const ORIGIN = 'http://127.0.0.1:60403';
const defs = new Map();
let route = null;
const webServer = { getOrigin: () => ORIGIN, register: (entry) => { route = entry; return () => {}; } };
const effect = (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; };
const subscriptions = new Map();
let modelReply = '';

const llm = {
  prepareCall: async () => ({
    config: { model: 'stub' },
    stream: async function* stream() {
      yield { type: 'text-delta', text: modelReply };
    },
  }),
};

const ctx = {
  tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
  effect,
  inject: (deps, callback) => { if (deps.includes('webServer')) callback({ webServer, effect }); return () => {}; },
  get: (name) => {
    if (name === 'llm') return llm;
    if (name === 'agents') return { currentInitiator: () => null };
    if (name === 'sessions') return { get: () => undefined };
    if (name === 'systemPrompt') return { context: () => () => {} };
    return undefined;
  },
  on: (event, handler) => { subscriptions.set(event, handler); return () => {}; },
};
apply(ctx);

const cwd = path.join(os.tmpdir(), 'lite-memory-persona-learning-project');
fs.mkdirSync(cwd, { recursive: true });
const personaFile = path.join(process.env.DSH_HOME, 'lite-memory', 'persona.json');
const session = {
  id: 'session-persona',
  header: { id: 'session-persona', cwd },
  requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }),
};

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

/** 每个场景从空画像开始，顺带跳过 10 分钟冷却。 */
function reset() {
  clockOffset += 11 * 60000;
  try { fs.rmSync(personaFile, { force: true }); } catch { /* 不存在就算了 */ }
  const enabled = personaStore.setPersonaEnabled({ enabled: true });
  assert.equal(enabled.ok, true, enabled.reason);
}

function seedPending(count) {
  for (let index = 0; index < count; index += 1) {
    const queued = personaStore.queuePersonaPending({
      snippet: { text: '以后先给结论，别铺垫', sessionId: 's-persona', taskId: `t${index}`, projectId: 'p1' },
    });
    assert.equal(queued.ok, true, queued.reason);
  }
}

function finishTurn() {
  const handler = subscriptions.get('session/event');
  assert.equal(typeof handler, 'function', '应当注册了回合结束的监听');
  handler(session, { type: 'turn/end', data: { reason: { kind: 'completed' }, turn: '1' } });
}

async function waitFor(check, label) {
  for (let tick = 0; tick < 150; tick += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等不到：${label}`);
}

const personaNow = () => personaStore.readPersona().persona;

await test('正常模型输出经共享解析器落地一条证据，面板记成 added', async () => {
  reset();
  seedPending(6);
  const shown = personaStore.readPersona().persona.pending.slice(-6);
  const cited = shown[0].id;
  modelReply = JSON.stringify({
    snippetId: cited, dimension: 'answer_order', polarity: 'support', value: 'conclusion_first', basis: 'explicit_feedback',
  });
  finishTurn();
  await waitFor(() => personaNow().learning.lastResult, '代码处理结果落盘');
  const data = personaNow();
  assert.equal(data.evidence.length, 1, '模型说的这句话应当变成一条证据');
  assert.equal(data.evidence[0].dimension, 'answer_order');
  assert.equal(data.evidence[0].value, 'conclusion_first');
  assert.equal(data.evidence[0].taskId, shown[0].taskId, '证据落在模型点名的那段片段上');
  assert.equal(data.learning.lastResult.outcome, 'added');
  assert.equal(data.pending.length, 0, '模型看过的整批一次结算');
});

await test('有效但没发现偏好：整批结算、证据不增，面板记成 no_change', async () => {
  reset();
  seedPending(6);
  const cited = personaStore.readPersona().persona.pending.slice(-1)[0].id;
  modelReply = JSON.stringify({ snippetId: cited, no_change: true });
  finishTurn();
  await waitFor(() => personaNow().learning.lastResult, '代码处理结果落盘');
  const data = personaNow();
  assert.equal(data.evidence.length, 0);
  assert.equal(data.pending.length, 0);
  assert.equal(data.learning.lastResult.outcome, 'no_change');
});

await test('坏 JSON 不算成功：证据不写、片段留着，面板记成 invalid', async () => {
  reset();
  seedPending(6);
  modelReply = '我觉得他喜欢先看结论，但我不太确定。';
  finishTurn();
  await waitFor(() => personaNow().learning.lastResult, '代码处理结果落盘');
  const data = personaNow();
  assert.equal(data.evidence.length, 0);
  assert.equal(data.pending.length, 6, '解析失败不能把整批吃掉');
  assert.equal(data.learning.lastResult.outcome, 'invalid');
});

await test('模型编造片段编号：提交门禁拒绝，证据不写，面板记成 invalid', async () => {
  reset();
  seedPending(6);
  modelReply = JSON.stringify({
    snippetId: 'made-up-id', dimension: 'answer_order', polarity: 'support', value: 'conclusion_first', basis: 'explicit_feedback',
  });
  finishTurn();
  await waitFor(() => personaNow().learning.lastResult, '代码处理结果落盘');
  const data = personaNow();
  assert.equal(data.evidence.length, 0);
  assert.equal(data.pending.length, 6, '被拒的那批不算处理过');
  assert.equal(data.learning.lastResult.outcome, 'invalid');
  assert.equal(data.learning.lastResult.reason, 'citation_invalid');
});

console.log(`persona-learning.test.mjs: ${passed} passed`);
