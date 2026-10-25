/**
 * 项目自进化实验的本地成本基准：固定 32 条实验规则、64 条回执。
 * 只打印可复现的存储/视图成本与边界；不调用模型，不声称效果提升。
 *
 *   node bench/evolution.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-evolution-bench-'));
const store = await import('../store.js');
const learning = await import('../learning.js');
const state = await import('../state.js');
const view = await import('../view.js');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-evolution-project-'));
const scope = store.scopeOf(cwd, { projectRoot: cwd });
store.setEvolution(scope, true, { operationId: 'bench_on' });
store.setTaskDefault(scope, { taskKind: 'video', seriesId: '口播' });

const started = Date.now();
for (let i = 0; i < learning.LIMITS.rules; i += 1) {
  store.saveEntry(scope, {
    title: `口播规范 ${i}`,
    summary: `第 ${i} 条制作习惯`,
    when: '口播',
    body: `第 ${i} 条：开头先给结论，正文再展开。`,
    applicability: 'conditional',
    conditions: [{ key: 'seriesId', value: '口播' }],
    resolution: 'distinct',
  });
}

state.transact(scope, { operationId: 'bench_mark' }, (draft) => {
  const evolution = draft.experimental.projectEvolution;
  evolution.tasks = evolution.tasks || { sessions: {}, episodes: [] };
  evolution.learning = evolution.learning || { attempts: {}, recent: [], receipts: [] };
  const now = Date.now();
  for (const [index, entry] of draft.entries.entries()) {
    entry.origin = 'project_evolution';
    entry.reviewState = 'active';
    entry.revision = 2;
    entry.current.topicKey = `口播规范-${index}`;
    entry.maintenance = entry.maintenance || {};
    entry.maintenance.learning = {
      state: 'active',
      supportedEpisodeIds: ['ep_bench'],
      evidence: Array.from({ length: learning.LIMITS.evidence }, (_, n) => ({ sourceType: 'human_feedback', feedbackType: 'spec_change', episodeId: `ep_${n}`, at: new Date(now).toISOString() })),
      samples: Array.from({ length: learning.LIMITS.samples }, (_, n) => ({ episodeId: `ep_${n}`, artifactVersion: `v${n}`, dimension: '开头', verified: false, at: new Date(now).toISOString() })),
      checkpoints: Array.from({ length: learning.LIMITS.checkpoints }, (_, n) => ({ text: `检查点 ${n}`, at: new Date(now).toISOString() })),
      specDigest: `sd_bench_${index}`,
    };
  }
  evolution.learning.receipts = Array.from({ length: learning.LIMITS.receipts }, (_, n) => ({
    operationId: `bench_${n}`,
    episodeId: `ep_bench`,
    status: n % 5 === 0 ? 'failed' : 'applied',
    changes: n % 5 === 0 ? 0 : 1,
    at: new Date(now - n * 1000).toISOString(),
    ...(n % 4 === 0 ? { usage: { known: true, inputTokens: 100, outputTokens: 20 } } : {}),
  }));
  return { changed: true };
});
const seedMs = Date.now() - started;

const coldStart = process.hrtime.bigint();
const cold = store.learningSnapshot(scope);
const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;
const samples = [];
for (let i = 0; i < 50; i += 1) {
  const at = process.hrtime.bigint();
  store.learningSnapshot(scope);
  samples.push(Number(process.hrtime.bigint() - at) / 1e6);
}
samples.sort((a, b) => a - b);
const pct = (p) => Math.round(samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)] * 1000) / 1000;
const organizerInput = learning.buildCallInput({
  projectId: 'bench', episodeId: 'ep_bench', taskKind: 'video', seriesId: '口播', phase: 'brief',
  feedback: { messageIds: ['m1'], text: '之前说过开头先给结论，这次怎么又没做到。', cue: { type: 'execution_miss', explicitLongTerm: false } },
  rules: store.learningRulesForOrganizer(scope),
  ranges: { taskKinds: ['video'], series: ['口播'] },
});
const record = cold.rules[0];
const context = { taskKind: 'video', seriesId: '口播' };
const measured = {
  rules: cold.rules.length,
  organizerRules: organizerInput.rules.length,
  organizerBytes: organizerInput.bytes,
  stateBytes: fs.statSync(state.stateFiles(scope).current).size,
  sampleDepth: Math.max(...cold.rules.map((rule) => rule.samples.length)),
  checkpointDepth: Math.max(...cold.rules.map((rule) => rule.checkpoints.length)),
  evidenceDepth: Math.max(...cold.rules.map((rule) => rule.learning.evidence.length)),
  effect: cold.effect,
  evaluate: view.evaluate(record, context).status,
  modelViewBytes: Buffer.byteLength(JSON.stringify(view.toModelView(record, 'read', { context }))),
  coldMs: Math.round(coldMs * 1000) / 1000,
  warmP50Ms: pct(50),
  warmP95Ms: pct(95),
  seedMs,
};
const checks = {
  ruleCap: measured.rules === learning.LIMITS.rules,
  sampleCap: measured.sampleDepth === learning.LIMITS.samples,
  checkpointCap: measured.checkpointDepth === learning.LIMITS.checkpoints,
  evidenceCap: measured.evidenceDepth === learning.LIMITS.evidence,
  receiptWindow: measured.effect.window === learning.LIMITS.receipts,
  effectKnownUsage: Number.isInteger(measured.effect.inputTokens),
  stateBudget: measured.stateBytes <= 256 * 1024,
  organizerBudget: measured.organizerBytes <= 8 * 1024,
};
if (Object.values(checks).some((ok) => !ok)) {
  console.error(JSON.stringify({ checks, measured }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  kind: 'project-evolution',
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  modelQuality: 'not measured',
  measured,
  checks,
}, null, 2));
