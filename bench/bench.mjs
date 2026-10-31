/**
 * Retrieval-path benchmark on a fixed 200-project + 200-global dataset.
 * Local evidence only: prints one JSON object; no cloud model, no network.
 *
 *   node bench/bench.mjs          跑基准，输出一个 JSON；有检查不过就退出码 1
 *   node bench/bench.mjs --help   只打用法
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const HELP = [
  '用法: node bench/bench.mjs',
  '',
  '在临时 DSH_HOME 里种 200 条项目记忆与 200 条全局记忆，测召回耗时、上下文体积，',
  '再跑 150 轮 save / read / search / forget 工具序列，最后输出一个 JSON。',
  '所有检查通过退出码 0，否则 1。不联网、不调用模型。',
].join('\n');

/** 顶层不裸 await：整个基准包进 main()；也不调 process.exit，只用退出码。 */
async function main() {
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
  const agent = { id: 'bench-agent', cwd, session: { id: 'bench-session', header: { cwd } } };
  const exec = (name, args) => defs.get(name).execute(args, { agent });
  const save = (args) => exec('memory_save', args);

  const pct = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  };
  const rss = () => Math.round(process.memoryUsage().rss / (1024 * 1024) * 10) / 10;

  const report = { node: process.version, platform: `${process.platform}/${process.arch}`, limits: store.LIMITS };
  const started = Date.now();

  /** 规模可调：默认 200+200 快速回归，LITE_MEMORY_BENCH_N=1000 跑规格要求的 1000+1000。 */
  const N = Math.max(1, Number(process.env.LITE_MEMORY_BENCH_N || 200) || 200);
  report.seedSize = N;
  for (let i = 0; i < N; i += 1) {
    save({
      title: `项目条目 ${i} 发布顺序`,
      summary: `项目条目 ${i} 的前置说明`,
      when: `项目场景 ${i}`,
      body: `项目正文 ${i}：先跑测试，再发布。`,
      applicability: 'all_in_scope',
      resolution: 'distinct',
    });
  }
  /**
   * 全局层用受信任写入直接种：经 memory_save 的模型提案会被降到项目层，
   * 这里要测的是两层都在时的召回路径，不是降级路径。
   */
  const globalScope = store.globalScope();
  for (let i = 0; i < N; i += 1) {
    const saved = store.saveEntry(globalScope, {
      title: `全局条目 ${i} 交付规范`,
      summary: `全局条目 ${i} 的通用说明`,
      when: `全局场景 ${i}`,
      body: `全局正文 ${i}：交付前清零告警。`,
      applicability: 'all_in_scope',
      scopeConfirmed: true,
      resolution: 'distinct',
    });
    if (!saved || !saved.record) throw new Error(`global seed ${i} failed: ${JSON.stringify(saved).slice(0, 500)}`);
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
    messages: [{ role: 'user', id: `bench-h${i}`, source: { kind: 'user' }, content: [{ type: 'text', text: `项目条目 ${i % N} 的发布顺序是什么，第 ${i} 次问` }] }],
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

  // Positive scenario: a normal question must actually receive budgeted memory text.
  const positiveSignal = new AbortController().signal;
  await preStep({ agent, signal: positiveSignal, turn: '9000' }, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', id: 'bench-positive', source: { kind: 'user' }, content: [{ type: 'text', text: '全局条目 7 的交付规范是什么' }] }],
  }));
  const positiveText = recall.text({ agent, signal: positiveSignal });
  report.positive = {
    bytes: Buffer.byteLength(positiveText, 'utf8'),
    hasGlobalCard: /全局条目 7 交付规范/.test(positiveText),
    underCap: Buffer.byteLength(positiveText, 'utf8') <= 1200,
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

  /**
   * Long sequence: save / read / search / forget, 150 rounds.
   * 每次工具调用都等结果：句柄用工具契约里的 title（memory_save 不回 id），
   * forget 必须显式 mode='archive'，否则只回 needs_resolution。
   * 换一个没进过 preStep 的 agent 对象，避免 150 轮把单条请求的读取额度用穿。
   */
  const sequence = { save: 0, read: 0, readOk: 0, search: 0, searchHit: 0, forget: 0, forgot: 0 };
  const toolAgent = { id: 'bench-tools', cwd, session: { id: 'bench-session', header: { cwd } } };
  const call = (name, args) => defs.get(name).execute(args, { agent: toolAgent });
  const seqStart = Date.now();
  for (let i = 0; i < 150; i += 1) {
    const title = `序列条目 ${i}`;
    const saved = await call('memory_save', {
      title,
      summary: `序列 ${i} 的摘要`,
      body: `序列 ${i} 的正文：发布前跑测试。`,
      applicability: 'all_in_scope',
      resolution: 'distinct',
    });
    if (!saved || !saved.title) throw new Error(`序列保存没有回 title：第 ${i} 轮 ${JSON.stringify(saved).slice(0, 300)}`);
    sequence.save += 1;

    const read = await call('memory_read', { title: saved.title });
    sequence.read += 1;
    if (read && read.status === 'ok' && typeof read.body === 'string' && read.body.includes(`序列 ${i} 的正文`)) sequence.readOk += 1;

    const found = await call('memory_search', { query: title });
    sequence.search += 1;
    if (found && found.count > 0 && (found.refs || []).some((ref) => ref.title === saved.title)) sequence.searchHit += 1;

    if (i % 3 === 0) {
      const forgot = await call('memory_forget', { title: saved.title, mode: 'archive' });
      sequence.forget += 1;
      if (forgot && forgot.mode === 'archive' && forgot.title === saved.title) sequence.forgot += 1;
    }
  }
  report.sequenceMs = Date.now() - seqStart;
  report.sequence = sequence;

  const project = store.loadIndex(store.scopeOf(cwd));
  report.afterSequence = {
    projectActive: project.entries.length,
    projectArchived: project.archived.length,
    globalActive: store.loadIndex(store.globalScope()).entries.length,
    stateBytes: fs.statSync(path.join(store.scopeOf(cwd).dir, 'state.json')).size,
    files: fs.readdirSync(store.scopeOf(cwd).dir).sort(),
  };
  report.rssEndMB = rss();
  /**
   * 归档数至少是这 50 次 forget 产生的；接近硬上限（1000 条）时，
   * 新增的序列条目会把最旧未读的挤进归档，多出来的归档是容量策略，不是 forget 出错。
   * 所以核对「所有存档到的条目都还在」而不是「归档刚好 50 条」。
   */
  const sequenceOk = sequence.save === 150
    && sequence.read === 150 && sequence.readOk === 150
    && sequence.search === 150 && sequence.searchHit === 150
    && sequence.forget === 50 && sequence.forgot === 50
    && project.archived.length >= sequence.forget
    && project.entries.length + project.archived.length >= N + sequence.save;
  report.ok = project.entries.length <= store.LIMITS.entries + store.LIMITS.hardEntries
    && report.entries.project >= N && report.entries.global >= N
    && report.prepare.avgContextBytes > 0
    && report.positive.bytes > 0 && report.positive.hasGlobalCard && report.positive.underCap
    && sequenceOk;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv.includes('--help')) {
  console.log(HELP);
} else {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-bench-'));
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
