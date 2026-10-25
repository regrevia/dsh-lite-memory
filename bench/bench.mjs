/**
 * Retrieval-path benchmark on a fixed 200-project + 200-global dataset.
 * Local evidence only: prints one JSON object; no cloud model, no network.
 *
 *   node bench/bench.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-bench-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');

const ORIGIN = 'http://127.0.0.1:60403';
const defs = new Map();
const subscriptions = new Map();
const promptContexts = [];
let currentAgent = null;
const webServer = { getOrigin: () => ORIGIN, register: () => () => {} };
const effect = (fn) => {
  const dispose = fn();
  return typeof dispose === 'function' ? dispose : () => {};
};
const ctx = {
  tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
  effect,
  inject: (deps, callback) => { if (deps.includes('webServer')) callback({ webServer, effect }); return () => {}; },
  get: (name) => {
    if (name === 'systemPrompt') return { context: (entry) => { promptContexts.push(entry); return () => {}; } };
    if (name === 'agents') return { currentInitiator: () => currentAgent };
    return undefined;
  },
  on: (event, handler) => { subscriptions.set(event, handler); return () => {}; },
};
apply(ctx);

const cwd = path.join(os.tmpdir(), 'lite-memory-bench-project');
fs.mkdirSync(cwd, { recursive: true });
const agent = { cwd, session: { id: 'bench-session', header: { cwd } } };
const exec = (name, args) => defs.get(name).execute(args, { agent });
const save = (args) => exec('memory_save', args);

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};
const rss = () => Math.round(process.memoryUsage().rss / (1024 * 1024) * 10) / 10;

const report = { node: process.version, platform: `${process.platform}/${process.arch}`, limits: store.LIMITS };
const started = Date.now();
const seedAgent = { ...agent };

// 200 project entries and 200 global entries, all with the same shape.
for (let i = 0; i < 200; i += 1) {
  save({
    title: `项目条目 ${i} 发布顺序`,
    summary: `项目条目 ${i} 的前置说明`,
    when: `项目场景 ${i}`,
    body: `项目正文 ${i}：先跑测试，再发布。`,
    applicability: 'all_in_scope',
    resolution: 'distinct',
  });
}
for (let i = 0; i < 200; i += 1) {
  save({
    title: `全局条目 ${i} 交付规范`,
    summary: `全局条目 ${i} 的通用说明`,
    when: `全局场景 ${i}`,
    body: `全局正文 ${i}：交付前清零告警。`,
    scope: 'global',
    applicability: 'all_in_scope',
    resolution: 'distinct',
  });
}
report.seedMs = Date.now() - started;
report.entries = {
  project: store.loadIndex(store.scopeOf(cwd)).entries.length,
  global: store.loadIndex(store.globalScope()).entries.length,
};
report.rssAfterSeedMB = rss();

// Hot retrieval path: pre-step prepare + prompt context read, 120 runs.
const preStep = subscriptions.get('agent/pre-step');
if (typeof preStep !== 'function') throw new Error('pre-step handler missing');
const recall = promptContexts.find((entry) => entry.name === 'lite-memory:recall');
if (!recall) throw new Error('recall context missing');
const userMessage = (i) => async () => ({
  kind: 'enter',
  messages: [{ role: 'user', id: `bench-h${i}`, source: { kind: 'user' }, content: [{ type: 'text', text: `项目条目 ${i % 200} 的发布顺序是什么，第 ${i} 次问` }] }],
});
const timings = [];
let bytes = 0;
for (let i = 0; i < 120; i += 1) {
  const signal = new AbortController().signal;
  const t = process.hrtime.bigint();
  await preStep({ agent, signal, turn: String(i + 2) }, userMessage(i));
  bytes += Buffer.byteLength(recall.text({ agent, signal }), 'utf8');
  timings.push(Number(process.hrtime.bigint() - t) / 1e6);
}
report.prepare = {
  runs: timings.length,
  coldMs: Math.round(timings[0] * 10) / 10,
  p50Ms: Math.round(pct(timings, 50) * 10) / 10,
  p95Ms: Math.round(pct(timings, 95) * 10) / 10,
  maxMs: Math.round(Math.max(...timings) * 10) / 10,
  avgContextBytes: Math.round(bytes / timings.length),
};

// File reads per prepare, measured on the same path.
let reads = 0;
const original = fs.readFileSync;
fs.readFileSync = function counted(...args) {
  reads += 1;
  return original.apply(this, args);
};
const before = reads;
for (let i = 0; i < 40; i += 1) {
  await preStep({ agent, signal: new AbortController().signal, turn: String(200 + i) }, userMessage(i));
}
fs.readFileSync = original;
report.fileReadsPerPrepare = Math.round(((reads - before) / 40) * 100) / 100;

// Long sequence: save / read / search / forget, 150 rounds.
const seqStart = Date.now();
for (let i = 0; i < 150; i += 1) {
  const saved = save({ title: `序列条目 ${i}`, summary: `序列 ${i} 的摘要`, applicability: 'all_in_scope', resolution: 'distinct' });
  if (saved && saved.id) exec('memory_read', { id: saved.id });
  exec('memory_search', { query: `序列条目 ${i}` });
  if (i % 3 === 0 && saved && saved.id) exec('memory_forget', { id: saved.id });
}
report.sequenceMs = Date.now() - seqStart;
const project = store.loadIndex(store.scopeOf(cwd));
report.afterSequence = {
  projectActive: project.entries.length,
  projectArchived: project.archived.length,
  globalActive: store.loadIndex(store.globalScope()).entries.length,
  stateBytes: fs.statSync(path.join(store.scopeOf(cwd).dir, 'state.json')).size,
  files: fs.readdirSync(store.scopeOf(cwd).dir).sort(),
};
report.rssEndMB = rss();
report.ok = project.entries.length <= store.LIMITS.entries + store.LIMITS.hardEntries;

console.log(JSON.stringify(report, null, 2));
