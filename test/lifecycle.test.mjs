import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-lifecycle-'));
const store = await import('../store.js');
const learning = await import('../learning.js');
const anchor = await import('../anchor.js');
const state = await import('../state.js');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const markers = [];
const fresh = (label) => {
  const dir = path.join(os.tmpdir(), `lite-memory-life-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  const scope = store.scopeOf(dir);
  markers.push(scope);
  return scope;
};
const op = (prefix) => `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
const DAY = 24 * 60 * 60 * 1000;

const enable = (scope) => {
  const result = store.setEvolution(scope, true, { operationId: op('on') });
  assert.equal(result.ok, true, result.reason);
};

const route = (scope) => {
  const routed = anchor.routeTask(anchor.emptyTasks(), {
    sessionId: 's1', projectId: 'proj', query: '改一下这期口播开头', messageIds: ['m1'],
    batchKey: anchor.requestBatchKey(['m1']), defaults: { taskKind: 'video', seriesId: '口播' }, now: Date.now(),
  });
  const saved = store.saveTaskState(scope, routed.tasks, { operationId: op('tasks') });
  assert.equal(saved.ok, true, saved.reason);
  return routed.episode;
};

const CHANGE = {
  target: 'new',
  feedbackType: 'spec_change',
  topicKey: '口播开头',
  currentText: '开头三句内给结论。',
  applicability: 'conditional',
  conditions: [{ key: 'seriesId', value: '口播' }],
  evidence: ['u0'],
  persistence: 'project_candidate',
};

const commitRule = (scope, episode, changes = [CHANGE]) => {
  const begin = store.beginLearningAttempt(scope, { episodeId: episode.episodeId, operationId: op('begin') });
  const parsed = learning.parseOutput(JSON.stringify({ changes }), {
    finish: { kind: 'stop' }, refs: { feedback: { u0: 'm1' } }, rules: [], ranges: { taskKinds: ['video'], series: ['口播'] },
  });
  assert.equal(parsed.ok, true, parsed.reason);
  const out = store.commitLearning(scope, {
    operationId: op('commit'), epoch: begin.epoch, episodeId: episode.episodeId, episodeUpdatedAt: episode.updatedAt,
    projectId: 'proj', sessionId: 's1', messageIds: ['m1'], changes: parsed.changes, preparedTargets: [],
  });
  return out;
};

const rulesOf = (scope) => state.load(scope).state.entries.filter((row) => row.origin === 'project_evolution' && row.status === 'active');
const cloneRules = (scope, count, patch) => {
  const base = rulesOf(scope)[0];
  assert.ok(base, '先有一条实验规则');
  const oldAt = new Date(Date.now() - 31 * DAY).toISOString();
  state.transact(scope, { operationId: op('clone') }, (draft) => {
    const source = draft.entries.find((entry) => entry.id === base.id);
    for (let i = 0; i < count; i += 1) {
      const copy = JSON.parse(JSON.stringify(source));
      copy.id = `mem_${String(i).padStart(12, '0')}`;
      copy.current = { ...copy.current, topicKey: `探针-${patch.tag}-${i}`, title: `探针${patch.tag}${i}` };
      copy.maintenance = { ...(copy.maintenance || {}), learning: { ...source.maintenance.learning, ...patch.learning } };
      draft.entries.push(copy);
    }
    return { changed: true };
  });
  return oldAt;
};
const setLearning = (scope, id, patch) => {
  state.transact(scope, { operationId: op('patch') }, (draft) => {
    const entry = draft.entries.find((row) => row.id === id);
    entry.maintenance.learning = { ...entry.maintenance.learning, ...patch };
    entry.updatedAt = new Date().toISOString();
    return { changed: true };
  });
};
const clearMark = (scope) => { try { fs.unlinkSync(store.lifecycleMarkPath(scope)); } catch { /* 本来就没有 */ } };
const SAVE_TITLES = ['春秋', '米饭', '地铁', '蓝色', '键盘', '河流', '云朵', '石头', '树林', '纸张', '玻璃', '橘子', '月亮', '窗户'];
let saveCount = 0;
/** 标题用差异很大的词，避免同名判定把写入口变成 needsResolution。 */
const save = (scope) => {
  const word = SAVE_TITLES[saveCount % SAVE_TITLES.length];
  saveCount += 1;
  return store.saveEntry(scope, { title: `${word}${saveCount}`, summary: `摘要-${Math.random().toString(16).slice(2, 10)}`, body: `正文-${Math.random().toString(16).slice(2, 10)}`, writeMode: 'patch' });
};

const OLD_PENDING = { state: 'pending', createdAt: null, updatedAt: null };
const expiredPendingPatch = (tag) => {
  const old = new Date(Date.now() - 31 * DAY).toISOString();
  return { tag, learning: { state: 'pending', createdAt: old, updatedAt: old } };
};

test('过期候选不再占待确认名额：commitLearning 不误报上限', () => {
  const scope = fresh('slots');
  enable(scope);
  const episode = route(scope);
  assert.equal(commitRule(scope, episode).ok, true);
  cloneRules(scope, 12, expiredPendingPatch('槽位'));
  const pending = rulesOf(scope).filter((row) => row.maintenance.learning.state === 'pending');
  assert.equal(pending.length, 12);
  assert.equal(learning.pendingCount(pending.map((row) => ({ learning: row.maintenance.learning })), Date.now()), 0);
  const again = commitRule(scope, episode, [{
    ...CHANGE, topicKey: '口播结尾', currentText: '结尾留一个动作。',
  }]);
  assert.equal(again.ok, true, again.reason);
  assert.equal(rulesOf(scope).length, 14);
});

test('到期试用转暂停：不改内容版本，也不动 active', () => {
  const scope = fresh('trial');
  enable(scope);
  const episode = route(scope);
  assert.equal(commitRule(scope, episode).ok, true);
  const rule = rulesOf(scope)[0];
  const active = JSON.parse(JSON.stringify(rule));
  active.id = `mem_${String(7).padStart(12, '0')}`;
  active.current = { ...active.current, topicKey: '一直在岗', title: '一直在岗' };
  active.maintenance = { ...active.maintenance, learning: { ...active.maintenance.learning, state: 'active' } };
  state.transact(scope, { operationId: op('seed') }, (draft) => { draft.entries.push(active); return { changed: true }; });
  setLearning(scope, rule.id, { state: 'trial', trialUntil: new Date(Date.now() - DAY).toISOString() });
  clearMark(scope);
  const revision = state.load(scope).state.entries.find((row) => row.id === rule.id).revision;
  save(scope);
  const after = state.load(scope).state.entries.find((row) => row.id === rule.id);
  assert.equal(after.maintenance.learning.state, 'paused');
  assert.equal(after.maintenance.learning.blockedReason, 'trial_expired');
  assert.equal(after.revision, revision);
  const stillActive = state.load(scope).state.entries.find((row) => row.id === active.id);
  assert.equal(stillActive.maintenance.learning.state, 'active');
  assert.equal(stillActive.status, 'active');
  assert.ok(rule.id.startsWith('mem_'));
});

test('过期候选只转可恢复暂停：每轮最多 8 条，且过期也不自动删除', () => {
  const scope = fresh('cap');
  enable(scope);
  const episode = route(scope);
  assert.equal(commitRule(scope, episode).ok, true);
  cloneRules(scope, 12, expiredPendingPatch('上限'));
  clearMark(scope);
  save(scope);
  const rows = rulesOf(scope);
  assert.equal(rows.filter((row) => row.maintenance.learning.state === 'paused').length, 8);
  assert.equal(rows.filter((row) => row.maintenance.learning.state === 'pending').length, 4);
  assert.equal(rows.length, 13);
  // 12 小时内再写一次：同一项目不重复处理
  const markMtime = fs.statSync(store.lifecycleMarkPath(scope)).mtimeMs;
  save(scope);
  assert.equal(fs.statSync(store.lifecycleMarkPath(scope)).mtimeMs, markMtime);
  assert.equal(rulesOf(scope).filter((row) => row.maintenance.learning.state === 'paused').length, 8);
  // 即便暂停已超 30 天，过期候选也不被销毁
  state.transact(scope, { operationId: op('age') }, (draft) => {
    for (const entry of draft.entries) {
      const book = entry.maintenance && entry.maintenance.learning;
      if (book && book.state === 'paused' && book.blockedReason === 'candidate_expired') book.pausedAt = new Date(Date.now() - 40 * DAY).toISOString();
    }
    return { changed: true };
  });
  clearMark(scope);
  save(scope);
  const kept = rulesOf(scope);
  assert.equal(kept.length, 13);
  // 第三轮把剩下 4 条也收掉；12 条全部留着，只是转为可恢复暂停，不会被销毁
  assert.equal(kept.filter((row) => row.maintenance.learning.blockedReason === 'candidate_expired').length, 12);
  // 恢复入口：用户显式 resume 能把暂停的过期候选拉回试用
  const id = kept.find((row) => row.maintenance.learning.blockedReason === 'candidate_expired').id;
  const resumed = store.resumeLearningRule(scope, id, { operationId: op('resume') });
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(state.load(scope).state.entries.find((row) => row.id === id).maintenance.learning.state, 'trial');
});

test('24 小时闸门：闸门内不清理，闸门过了才处理新到期的条目', () => {
  const scope = fresh('gate');
  enable(scope);
  const episode = route(scope);
  assert.equal(commitRule(scope, episode).ok, true);
  clearMark(scope);
  save(scope);
  const target = rulesOf(scope)[0];
  setLearning(scope, target.id, { state: 'trial', trialUntil: new Date(Date.now() - DAY).toISOString() });
  save(scope);
  assert.equal(state.load(scope).state.entries.find((row) => row.id === target.id).maintenance.learning.state, 'trial');
  clearMark(scope);
  save(scope);
  assert.equal(state.load(scope).state.entries.find((row) => row.id === target.id).maintenance.learning.state, 'paused');
});

test('面板与快照读路径零写：文件数量、大小、mtime 都不变', () => {
  const scope = fresh('readonly');
  enable(scope);
  const episode = route(scope);
  assert.equal(commitRule(scope, episode).ok, true);
  save(scope);
  const walk = (dir) => {
    const rows = [];
    const visit = (current) => {
      for (const name of fs.readdirSync(current).sort()) {
        const full = path.join(current, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) visit(full);
        else rows.push([path.relative(scope.dir, full), stat.size, stat.mtimeMs]);
      }
    };
    visit(dir);
    return JSON.stringify(rows.sort());
  };
  const before = walk(scope.dir);
  store.learningSnapshot(scope);
  store.evolutionStatus(scope);
  store.capacityOf(scope, store.loadIndex(scope));
  store.loadIndex(scope).entries.length;
  assert.equal(walk(scope.dir), before);
});

test('实验开关关闭时不清理、不落生命周期标记', () => {
  const scope = fresh('off');
  const saved = save(scope);
  assert.ok(saved && saved.record && saved.record.id);
  assert.equal(fs.existsSync(store.lifecycleMarkPath(scope)), false);
});

console.log(`lifecycle: ${passed} passed`);
