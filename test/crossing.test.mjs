import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-cross-'));
const store = await import('../store.js');
const state = await import('../state.js');
const view = await import('../view.js');

const {
  saveEntry, routeScope, visibleRules, move, resumeMove, movePending,
  upsert, forget, readLinks, loadIndex, scopeOf, globalScope, readEntry, pendingConflictsOf,
} = store;

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

const dirs = [];
const fresh = (label) => {
  const dir = path.join(os.tmpdir(), `lite-memory-cross-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return scopeOf(dir);
};
const stateOf = (scope) => {
  const file = path.join(scope.dir, 'state.json');
  if (!fs.existsSync(file)) return { entries: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8')).payload;
};
const idsOf = (scope) => stateOf(scope).entries.map((row) => row.id);
const idsOfPrev = (scope) => {
  const file = path.join(scope.dir, 'state.prev.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).payload.entries.map((row) => row.id) : [];
};

// ── S03 范围路由 ────────────────────────────────────────────────────────────
await test('S03 个人偏好没有显式范围就进全局层，项目层不落副本', () => {
  const scope = fresh('route-pref');
  const saved = saveEntry(scope, { title: '回答用中文', summary: '回复语言偏好', body: '中文、简短', memoryClass: 'personal_preference' });
  assert.equal(saved.chosenScope, 'global');
  assert.equal(saved.reasonCode, 'class_personal_preference');
  assert.equal(idsOf(scope).length, 0);
  assert.equal(stateOf(globalScope()).entries.filter((row) => row.current.title === '回答用中文').length, 1);
});

await test('S03 项目事实留在项目层', () => {
  const scope = fresh('route-project');
  const saved = saveEntry(scope, { title: '构建命令', summary: '构建用 pnpm', body: 'pnpm build', memoryClass: 'project_fact' });
  assert.equal(saved.chosenScope, 'project');
  assert.equal(idsOf(scope).length, 1);
});

await test('S03 设备事实没给设备条件就返回 needsScope，不落盘', () => {
  const scope = fresh('route-env');
  const saved = saveEntry(scope, { title: '本机 Node', summary: '本机 Node 版本', body: 'v24', memoryClass: 'environment_fact' });
  assert.equal(saved.needsScope, true);
  assert.equal(saved.reasonCode, 'needs_environment');
  assert.equal(idsOf(scope).length, 0);
  assert.deepEqual(saved.requiredConditions.map((row) => row.key), ['machine', 'runtime']);
});

await test('S03 设备事实带条件进全局层且是条件适用', () => {
  const scope = fresh('route-env-ok');
  const saved = saveEntry(scope, {
    title: '本机 Node', summary: '本机 Node 版本', body: 'v24', memoryClass: 'environment_fact',
    conditions: [{ key: 'machine', value: 'mac-mini' }],
  });
  assert.equal(saved.chosenScope, 'global');
  assert.equal(saved.record.applicability, 'conditional');
  assert.equal(idsOf(scope).length, 0);
});

await test('S03 一次性任务参数不落盘；显式范围压过类别提案', () => {
  const scope = fresh('route-explicit');
  const task = saveEntry(scope, { title: '临时端口', summary: '这次跑在 8080', body: '8080', durability: 'task' });
  assert.equal(task.needsScope, true);
  assert.equal(task.reasonCode, 'task_state');
  const explicit = saveEntry(scope, { title: '项目内偏好', summary: '只在这个项目用', body: 'x', memoryClass: 'personal_preference', scope: 'project' });
  assert.equal(explicit.chosenScope, 'project');
  assert.equal(explicit.reasonCode, 'explicit');
});

// ── S06 两层去重 ────────────────────────────────────────────────────────────
await test('S06 两层完全相同只返回已有引用，不写第二条', () => {
  const scope = fresh('dedupe-exact');
  const globalSaved = saveEntry(globalScope(), {
    title: '统一时区', summary: '日志都写 UTC', body: 'UTC', scope: 'global', resolution: 'distinct',
  });
  assert.equal(globalSaved.chosenScope, 'global');
  const again = saveEntry(scope, { title: '统一时区', summary: '日志都写 UTC', body: 'UTC' });
  assert.ok(again.existing);
  assert.equal(again.existing.id, globalSaved.record.id);
  assert.equal(again.existing.scope, 'global');
  assert.equal(idsOf(scope).length, 0);
});

await test('S06 两层只是相近只给候选或确认，不直接新增', () => {
  const scope = fresh('dedupe-near');
  saveEntry(globalScope(), { title: '发布前检查清单', summary: '发版前逐项确认', body: '清单', scope: 'global', resolution: 'distinct' });
  const near = saveEntry(scope, { title: '发布前检查清单', summary: '发版前逐项确认（项目补充）', body: '项目清单' });
  assert.equal(near.needsResolution, true);
  assert.equal(near.crossLayer, true);
  assert.equal(idsOf(scope).length, 0);
  assert.equal(near.similarList.length >= 1, true);
});

// ── S07 槽位：项目覆盖 / 回落 / 条件未知 ────────────────────────────────────
const seedSlot = (scope, layer, extra) => saveEntry(layer === 'global' ? globalScope() : scope, {
  title: extra.title, summary: extra.summary, body: extra.body || '正文',
  topicKey: 'tooling.pm', resolution: 'distinct', ...extra,
});

await test('S07 项目层命中时只给项目规范，全局同名槽位被压住', () => {
  const scope = fresh('slot-match');
  seedSlot(scope, 'global', { title: '包管理器', summary: '用 pnpm', applicability: 'all_in_scope' });
  seedSlot(scope, 'project', {
    title: '包管理器', summary: '这个项目用 npm', applicability: 'conditional',
    conditions: [{ key: 'runtime', value: 'node' }],
  });
  const { winners } = visibleRules(scope, { runtime: 'node' });
  const titles = winners.filter((row) => row.key === 'tooling.pm').map((row) => row.record.summary);
  assert.deepEqual(titles, ['这个项目用 npm']);
});

await test('S07 项目层条件不匹配时回落到全局', () => {
  const scope = fresh('slot-fallback');
  seedSlot(scope, 'global', { title: '包管理器', summary: '用 pnpm', applicability: 'all_in_scope' });
  seedSlot(scope, 'project', {
    title: '包管理器', summary: '这个项目用 npm', applicability: 'conditional',
    conditions: [{ key: 'runtime', value: 'node' }],
  });
  const { winners } = visibleRules(scope, { runtime: 'bun' });
  const rows = winners.filter((row) => row.key === 'tooling.pm');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record.summary, '用 pnpm');
  assert.equal(rows[0].scope, 'global');
});

await test('S07 项目层条件未知时整组暂缓，不拿全局顶上', () => {
  const scope = fresh('slot-unknown');
  seedSlot(scope, 'global', { title: '包管理器', summary: '用 pnpm', applicability: 'all_in_scope' });
  seedSlot(scope, 'project', {
    title: '包管理器', summary: '这个项目用 npm', applicability: 'conditional',
    conditions: [{ key: 'runtime', value: 'node' }],
  });
  const { resolved } = visibleRules(scope, {});
  const group = resolved.get('tooling.pm');
  assert.equal(group.status, 'needs_context');
  assert.equal(group.record, null);
});

await test('S08 同层同槽位不同内容判冲突，不靠命中顺序仲裁', () => {
  const scope = fresh('slot-conflict');
  upsert(scope, { title: '包管理器一', summary: '用 pnpm', body: 'a', topicKey: 'tooling.pm', applicability: 'all_in_scope' });
  const second = saveEntry(scope, {
    title: '包管理器二', summary: '用 npm', body: 'b', topicKey: 'tooling.pm', applicability: 'all_in_scope', resolution: 'distinct',
  });
  assert.equal(second.chosenScope, 'project');
  const { resolved } = visibleRules(scope, {});
  assert.equal(resolved.get('tooling.pm').status, 'conflict');
});

await test('S08 同层同槽位同条件再存要确认，不静默新建', () => {
  const scope = fresh('slot-same');
  const first = upsert(scope, { title: '唯一槽位甲', summary: '槽位测试甲', body: 'a', topicKey: 'tooling.slotonly', applicability: 'all_in_scope' });
  const again = saveEntry(scope, { title: '唯一槽位甲 补充', summary: '槽位测试甲', body: 'b', topicKey: 'tooling.slotonly', applicability: 'all_in_scope' });
  assert.equal(again.needsResolution, true);
  assert.equal(again.sameTopic, true);
  assert.equal(again.similarList[0].id, first.record.id);
  assert.equal(idsOf(scope).length, 1);
});

// ── S09 / D09 搬移 ──────────────────────────────────────────────────────────
await test('S09 项目搬到全局：新 id、旧 id 失效、prev 不留旧条目', () => {
  const scope = fresh('move-up');
  const saved = saveEntry(scope, {
    title: '提交信息格式', summary: '都用 type: 前缀', body: 'type: subject', topicKey: 'git.commit',
  });
  const before = saved.record.id;
  const done = move(scope, before, { target: 'global' });
  assert.equal(done.status, 'moved');
  assert.notEqual(done.id, before);
  assert.equal(idsOf(scope).includes(before), false);
  assert.equal(idsOfPrev(scope).includes(before), false);
  const moved = stateOf(globalScope()).entries.find((row) => row.id === done.id);
  assert.ok(moved);
  assert.equal(moved.current.body, 'type: subject');
  assert.equal(moved.current.topicKey, 'git.commit');
  assert.equal(movePending(), null);
  assert.equal(readEntry(globalScope(), done.id).body, 'type: subject');
});

await test('S09 续跑只认发起项目的身份，换项目被拒绝', () => {
  const a = fresh('resume-a');
  const b = fresh('resume-b');
  const saved = saveEntry(a, {
    title: '续跑归属', summary: '搬移中断后只能回原项目续跑', body: 'x', scope: 'project', resolution: 'distinct',
  });
  const pending = move(a, saved.record.id, { target: 'global', stopAfter: 'source' });
  assert.equal(pending.status, 'move_pending');
  assert.throws(() => resumeMove(b), (error) => error.code === 'conflict' && /另一个项目/.test(error.message));
  assert.ok(movePending());
  const done = resumeMove(a);
  assert.equal(done.status, 'moved');
  assert.equal(movePending(), null);
  assert.equal(idsOf(a).includes(saved.record.id), false);
  assert.equal(stateOf(globalScope()).entries.some((row) => row.id === done.id), true);
});

await test('S09 续跑前源 current 丢失时从 prev 恢复，但不会复活旧条目', () => {
  const scope = fresh('resume-prev');
  const saved = saveEntry(scope, {
    title: '恢复不复活', summary: 'prev 里有旧条目也不能带回来', body: 'x', scope: 'project', resolution: 'distinct',
  });
  const stale = fs.readFileSync(path.join(scope.dir, 'state.json'), 'utf8');
  const pending = move(scope, saved.record.id, { target: 'global', stopAfter: 'source' });
  assert.equal(pending.stage, 'source_cleaned');
  fs.rmSync(path.join(scope.dir, 'state.json'));
  fs.writeFileSync(path.join(scope.dir, 'state.prev.json'), stale);
  const done = resumeMove(scope);
  assert.equal(done.status, 'moved');
  assert.equal(idsOf(scope).includes(saved.record.id), false);
  assert.equal(idsOfPrev(scope).includes(saved.record.id), false);
  assert.equal(movePending(), null);
});

await test('S09 收尾会重建 prev；两侧状态对不上就保留协调文件', () => {
  const scope = fresh('resume-verify');
  const saved = saveEntry(scope, {
    title: '收尾校验', summary: 'prev 可重建，状态对不上不结案', body: 'x', scope: 'project', resolution: 'distinct',
  });
  const pending = move(scope, saved.record.id, { target: 'global', stopAfter: 'source' });
  assert.equal(pending.status, 'move_pending');
  fs.rmSync(path.join(globalScope().dir, 'state.prev.json'), { force: true });
  const repaired = resumeMove(scope);
  assert.equal(repaired.status, 'moved');
  assert.equal(idsOfPrev(globalScope()).includes(repaired.id), true);
  assert.equal(movePending(), null);

  const other = fresh('resume-verify-2');
  const record = saveEntry(other, {
    title: '两侧对不上', summary: '源层状态丢了就不假装搬完', body: 'x', scope: 'project', resolution: 'distinct',
  });
  const pending2 = move(other, record.record.id, { target: 'global', stopAfter: 'source' });
  assert.equal(pending2.status, 'move_pending');
  fs.rmSync(path.join(other.dir, 'state.json'));
  fs.rmSync(path.join(other.dir, 'state.prev.json'), { force: true });
  assert.throws(() => resumeMove(other), (error) => error.code === 'recover_failed' || error.code === 'unavailable');
  assert.ok(movePending());
  state.clearMoveIntent();
});

await test('S09 全局搬回项目走同一套协议', () => {
  const scope = fresh('move-down');
  const saved = saveEntry(globalScope(), { title: '回滚命令', summary: '回滚用 rollback', body: 'rollback', scope: 'global', resolution: 'distinct' });
  const done = move(scope, saved.record.id, { target: 'project' });
  assert.equal(done.status, 'moved');
  assert.equal(done.from, 'global');
  assert.equal(done.to, 'project');
  assert.equal(stateOf(globalScope()).entries.some((row) => row.id === saved.record.id), false);
  assert.ok(idsOf(scope).includes(done.id));
});

await test('D09 目标层已有相同内容就拒绝搬移，不落协调文件', () => {
  const scope = fresh('move-dup');
  const source = saveEntry(scope, { title: '日志目录', summary: '日志在 logs', body: 'logs/', scope: 'project', resolution: 'distinct' });
  saveEntry(globalScope(), { title: '日志目录', summary: '日志在 logs', body: 'logs/', scope: 'global', resolution: 'distinct' });
  assert.throws(() => move(scope, source.record.id, { target: 'global' }), /目标层已有相同内容/);
  assert.equal(movePending(), null);
  assert.equal(idsOf(scope).includes(source.record.id), true);
});

await test('S09 出边在目标层不可见就拒绝搬移', () => {
  const scope = fresh('move-links');
  const target = saveEntry(scope, { title: '发布脚本', summary: '发版执行这个', body: './release.sh', scope: 'project', resolution: 'distinct' });
  const source = saveEntry(scope, {
    title: '发布检查', summary: '发版前先检查', body: '检查', scope: 'project', resolution: 'distinct',
    links: [{ type: 'related', id: target.record.id }],
  });
  assert.throws(() => move(scope, source.record.id, { target: 'global' }), /在目标层不可见/);
  assert.equal(movePending(), null);
});

await test('D09 目标写入后中断：两层读取被屏障挡住，resume 收尾后只剩一份', () => {
  const scope = fresh('move-crash');
  const saved = saveEntry(scope, { title: '端口约定', summary: '本地端口 49631', body: '49631', scope: 'project', resolution: 'distinct' });
  const done = move(scope, saved.record.id, { target: 'global', stopAfter: 'target' });
  assert.equal(done.status, 'move_pending');
  assert.ok(movePending());
  assert.throws(() => loadIndex(scope), /正在跨层搬移/);
  assert.throws(() => loadIndex(globalScope()), /正在跨层搬移/);
  const resumed = resumeMove(scope);
  assert.equal(resumed.status, 'moved');
  assert.equal(movePending(), null);
  assert.equal(stateOf(globalScope()).entries.filter((row) => row.id === resumed.id).length, 1);
  assert.equal(idsOf(scope).includes(saved.record.id), false);
});

await test('D09 协调文件损坏时报错，不当成没有搬移', () => {
  const scope = fresh('move-corrupt');
  const saved = saveEntry(scope, { title: '缓存目录', summary: '缓存在 .cache', body: '.cache', scope: 'project', resolution: 'distinct' });
  fs.writeFileSync(path.join(state.memoryRoot(), 'move.intent.json'), '{broken');
  assert.throws(() => move(scope, saved.record.id, { target: 'global' }), /协调文件已损坏/);
  state.clearMoveIntent();
  assert.equal(movePending(), null);
});

// ── L01–L06 关联 ────────────────────────────────────────────────────────────
await test('L01/L02 关联不能指向自己，也不能重复', () => {
  const scope = fresh('link-self');
  const saved = saveEntry(scope, { title: '部署步骤', summary: '部署按这个来', body: '步骤', scope: 'project', resolution: 'distinct' });
  assert.throws(() => upsert(scope, { id: saved.record.id, title: '部署步骤', links: [{ type: 'related', id: saved.record.id }] }), /不能关联自己/);
  const other = saveEntry(scope, { title: '回滚步骤', summary: '回滚按这个来', body: '步骤', scope: 'project', resolution: 'distinct' });
  assert.throws(() => upsert(scope, { id: saved.record.id, title: '部署步骤', links: [{ type: 'related', id: other.record.id }, { type: 'related', id: other.record.id }] }), /重复/);
});

await test('L03 关联最多 3 条', () => {
  const scope = fresh('link-max');
  const ids = [];
  for (const n of [1, 2, 3, 4]) {
    ids.push(saveEntry(scope, { title: `关联目标 ${n}`, summary: `目标 ${n}`, body: 'x', scope: 'project', resolution: 'distinct' }).record.id);
  }
  assert.throws(() => upsert(scope, { title: '关联四条', summary: '四个关联', body: 'x', links: ids.map((id) => ({ type: 'related', id })) }), /最多 3/);
});

await test('L04 项目条目可以关联全局条目，全局条目不能关联项目条目', () => {
  const scope = fresh('link-layers');
  const globalSaved = saveEntry(globalScope(), { title: '全局约定', summary: '全局层的约定', body: 'x', scope: 'global', resolution: 'distinct' });
  const projectLinked = saveEntry(scope, {
    title: '项目条目', summary: '关联全局', body: 'x', scope: 'project', resolution: 'distinct', links: [{ type: 'related', id: globalSaved.record.id }],
  });
  assert.equal(projectLinked.needsResolution, false);
  assert.equal(view.linksOf(projectLinked.record).length, 1);
  assert.throws(() => upsert(globalScope(), { title: '全局条目', summary: '想关联项目', body: 'x', links: [{ type: 'related', id: projectLinked.record.id }] }), /关联目标不存在/);
});

await test('L05 关联目标被归档后读出来是失效引用，不悄悄消失', () => {
  const scope = fresh('link-archive');
  const target = saveEntry(scope, { title: '被归档目标', summary: '之后会被归档', body: 'x', scope: 'project', resolution: 'distinct' });
  const source = saveEntry(scope, {
    title: '关联方', summary: '关联了一个目标', body: 'x', scope: 'project', resolution: 'distinct', links: [{ type: 'related', id: target.record.id }],
  });
  forget(scope, target.record.id, { mode: 'archive' });
  const links = readLinks(scope, source.record.id).links;
  assert.equal(links.length, 1);
  assert.equal(links[0].status, 'invalid');
});

await test('L06 展示视图不把关联结构塞给模型', () => {
  const scope = fresh('link-view');
  const target = saveEntry(scope, { title: '视图目标', summary: '视图测试', body: 'x', scope: 'project', resolution: 'distinct' });
  const source = saveEntry(scope, {
    title: '视图关联方', summary: '视图测试', body: 'x', scope: 'project', resolution: 'distinct', links: [{ type: 'related', id: target.record.id }],
  });
  const search = view.toModelView(source.record, 'search');
  assert.equal('links' in search, false);
  const read = view.toModelView(source.record, 'read');
  assert.equal('links' in read, false);
  assert.equal(read.related, 1);
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });

// ── S12 冲突队列：相近只记待办，确认后才进库 ───────────────────────────────
await test('S12 相近保存进待办队列，确认 distinct 后出队', () => {
  const scope = fresh('conflict-queue');
  saveEntry(globalScope(), { title: '发布前检查清单', summary: '发版前逐项确认', body: '清单', scope: 'global', resolution: 'distinct' });
  assert.equal(pendingConflictsOf(globalScope()), 0);
  const near = saveEntry(scope, { title: '发布前检查清单', summary: '发版前逐项确认（项目补充）', body: '项目清单' });
  assert.equal(near.needsResolution, true);
  assert.equal(near.pendingConflicts, 1);
  assert.equal(pendingConflictsOf(scope), 1);
  const queued = loadIndex(scope).conflicts[0];
  assert.equal(queued.title, '发布前检查清单');
  assert.equal(queued.scope, 'project');
  assert.equal(queued.candidates.length >= 1, true);
  const again = saveEntry(scope, { title: '发布前检查清单', summary: '发版前逐项确认（项目补充）', body: '项目清单' });
  assert.equal(pendingConflictsOf(scope), 1);
  const distinct = saveEntry(scope, { title: '发布前检查清单', summary: '发版前逐项确认（项目补充）', body: '项目清单', resolution: 'distinct' });
  assert.equal(distinct.needsResolution, false);
  assert.equal(pendingConflictsOf(scope), 0);
});

console.log(`crossing.test.mjs: ${passed} passed`);
