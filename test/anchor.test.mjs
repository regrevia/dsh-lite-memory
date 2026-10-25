import test from 'node:test';
import assert from 'node:assert/strict';
import * as anchor from '../anchor.js';
import * as view from '../view.js';

const base = () => ({
  projectId: '/work/demo',
  sessionId: 's1',
  messageIds: ['m1'],
  query: '帮我把这期视频的开头改快一点',
  registeredSeries: ['口播', 'Vlog'],
  now: Date.now(),
});

test('R01 首个自由任务只建 unbound 作品壳，读取只给索引', () => {
  const routed = anchor.routeTask(anchor.emptyTasks(), base());
  assert.equal(routed.anchor.status, 'unbound');
  assert.equal(routed.anchor.taskKind, undefined);
  assert.equal(routed.anchor.seriesId, undefined);
  const decision = anchor.decideRead({
    mode: 'adaptive', enabled: true, identityConfirmed: true,
    anchor: routed.anchor, ranges: ['口播', 'Vlog', '访谈'],
  });
  assert.equal(decision.kind, 'index');
  assert.deepEqual(decision.ranges, ['口播', 'Vlog', '访谈']);
  assert.ok(!('rules' in decision));
});

test('R02 前台选择只能把锚点升为 proposed，不冒充 active', () => {
  const first = anchor.routeTask(anchor.emptyTasks(), base());
  const selected = anchor.applySelection(first.tasks, {
    sessionId: 's1', batchKey: first.anchor.batchKey, messageIds: ['m1'],
    selection: { seriesId: '口播' }, now: base().now,
  });
  assert.equal(selected.anchor.status, 'proposed');
  assert.equal(selected.anchor.seriesId, '口播');
  assert.equal(selected.episode.status, 'proposed');
});

test('R03 再做一期创建新 episode，继承系列并回到 brief', () => {
  const first = anchor.routeTask(anchor.emptyTasks(), {
    ...base(), selection: { seriesId: '口播' },
  });
  const next = anchor.routeTask(first.tasks, {
    ...base(), messageIds: ['m2'], query: '再做一期口播，讲同一套开场',
  });
  assert.equal(next.decision.kind, 'continuation');
  assert.notEqual(next.anchor.episodeId, first.anchor.episodeId);
  assert.equal(next.anchor.seriesId, '口播');
  assert.equal(next.anchor.phase, 'brief');
  assert.equal(next.episode.previousEpisodeId, first.anchor.episodeId);
  assert.equal(next.episode.status, 'continuable');
});

test('R04 新一期不继承上一期的主题、脚本和临时例外', () => {
  const first = anchor.routeTask(anchor.emptyTasks(), {
    ...base(), selection: { seriesId: '口播' },
  });
  const next = anchor.routeTask(first.tasks, {
    ...base(), messageIds: ['m2'], query: '再来一期',
  });
  for (const key of ['theme', 'script', 'client', 'music', 'exceptions']) {
    assert.equal(next.anchor[key], undefined, `${key} 不应被继承`);
  }
});

test('R05 新会话有明确项目默认时建立 active 锚点', () => {
  const tasks = anchor.setDefault(anchor.emptyTasks(), { seriesId: '口播', taskKind: 'video' });
  const routed = anchor.routeTask(tasks, { ...base(), sessionId: 's2' });
  assert.equal(routed.anchor.status, 'active');
  assert.equal(routed.anchor.seriesId, '口播');
  assert.equal(routed.anchor.taskKind, 'video');
});

test('R06 明确改做别的任务时退出旧焦点，不把视频规则带过去', () => {
  const first = anchor.routeTask(anchor.emptyTasks(), {
    ...base(), selection: { seriesId: '口播' },
  });
  const switched = anchor.routeTask(first.tasks, {
    ...base(), messageIds: ['m2'], query: '改做 README 和计费说明',
  });
  assert.equal(switched.anchor.episodeId === first.anchor.episodeId, false);
  assert.equal(switched.anchor.seriesId, undefined);
  assert.equal(switched.anchor.status, 'unbound');
  assert.equal(switched.decision.switched, true);
});

test('R07 只说谢谢不注入规则，但保留后续可续指针', () => {
  const first = anchor.routeTask(anchor.emptyTasks(), {
    ...base(), selection: { seriesId: '口播' },
  });
  const thanks = anchor.routeTask(first.tasks, { ...base(), messageIds: ['m2'], query: '谢谢！' });
  assert.equal(thanks.decision.kind, 'none');
  assert.equal(thanks.decision.pointer, true);
  const decision = anchor.decideRead({
    mode: 'adaptive', enabled: true, identityConfirmed: true,
    anchor: thanks.anchor, ranges: ['口播'], thanks: true,
  });
  assert.equal(decision.kind, 'none');
});

test('R08 未知阶段的条件只算 needs_context，不当成适用', () => {
  const record = {
    id: 'mem_x', title: '口播开头', applicability: 'conditional',
    conditions: [{ key: 'seriesId', value: '口播' }, { key: 'phase', value: 'editing' }],
  };
  const context = view.trustedContext({ cwd: '/work/demo' }, { seriesId: '口播' });
  const evaluated = view.evaluate(record, context);
  assert.equal(evaluated.state, 'unknown');
  assert.deepEqual(evaluated.missing, ['phase']);
});

test('R09 任务条件键可由已确认绑定进入可信上下文', () => {
  const context = view.trustedContext({ cwd: '/work/demo' }, {
    taskKind: 'video', seriesId: '口播', phase: 'brief',
  });
  assert.equal(context.taskKind, 'video');
  assert.equal(context.seriesId, '口播');
  assert.equal(context.phase, 'brief');
});

test('R10 同一批次重放只生成一个 episode', () => {
  const first = anchor.routeTask(anchor.emptyTasks(), {
    ...base(), selection: { seriesId: '口播' },
  });
  const again = anchor.routeTask(first.tasks, {
    ...base(), selection: { seriesId: '口播' },
  });
  assert.equal(again.anchor.episodeId, first.anchor.episodeId);
  assert.equal(Object.keys(again.tasks.episodes).length, 1);
});

test('R10b 同一延续请求重试只生成一个新 episode', () => {
  const first = anchor.routeTask(anchor.emptyTasks(), {
    ...base(), selection: { seriesId: '口播' },
  });
  const a = anchor.routeTask(first.tasks, { ...base(), messageIds: ['m2', 'm3'], query: '再做一期' });
  const b = anchor.routeTask(a.tasks, { ...base(), messageIds: ['m3', 'm2'], query: '再做一期' });
  assert.equal(b.anchor.episodeId, a.anchor.episodeId);
  assert.equal(Object.keys(b.tasks.episodes).length, 2);
});

test('R11 请求批次只由本轮新人类消息决定', () => {
  assert.equal(anchor.requestBatchKey(['b', 'a']), anchor.requestBatchKey(['a', 'b', 'a']));
  assert.notEqual(anchor.requestBatchKey(['a']), anchor.requestBatchKey(['a', 'b']));
  assert.equal(anchor.requestBatchKey([]), '');
});

test('R12 contextId 带项目摘要，跨项目直接识别', () => {
  const id = anchor.contextIdFor('/work/demo', 'rb_1', 'n');
  assert.equal(anchor.projectTagOf(id), anchor.projectTag('/work/demo'));
  assert.notEqual(anchor.projectTagOf(id), anchor.projectTag('/work/other'));
});

test('R13 未绑定的索引最多三个栏目且不超过 600 字节', () => {
  const decision = anchor.decideRead({
    mode: 'adaptive', enabled: true, identityConfirmed: true, anchor: { status: 'unbound' },
    ranges: ['口播', 'Vlog', '访谈', '广告'],
  });
  assert.equal(decision.ranges.length, 3);
  assert.ok(Buffer.byteLength(decision.ranges.join('、'), 'utf8') <= anchor.TASK_LIMITS.indexBytes);
});

test('R14 实验关闭与身份未确认都不读', () => {
  assert.equal(anchor.decideRead({ mode: 'adaptive', enabled: false, identityConfirmed: true, anchor: { status: 'active' } }).kind, 'none');
  assert.equal(anchor.decideRead({ mode: 'adaptive', enabled: true, identityConfirmed: false, anchor: { status: 'active' } }).kind, 'none');
  assert.equal(anchor.decideRead({ mode: 'off', enabled: true, identityConfirmed: true, anchor: { status: 'active' } }).kind, 'none');
});

test('R15 proposed 自动路径只给索引，前台绑定后才给规则', () => {
  const auto = anchor.decideRead({
    mode: 'adaptive', enabled: true, identityConfirmed: true,
    anchor: { status: 'proposed', seriesId: '口播' }, ranges: ['口播'],
  });
  assert.equal(auto.kind, 'index');
  const bound = anchor.decideRead({
    mode: 'adaptive', enabled: true, identityConfirmed: true, boundForRequest: true,
    anchor: { status: 'proposed', seriesId: '口播' }, ranges: ['口播'],
  });
  assert.equal(bound.kind, 'rules');
});

test('R16 会话指针硬上限 8，超出按最近更新保留', () => {
  let tasks = anchor.emptyTasks();
  for (let i = 0; i < 12; i += 1) {
    const routed = anchor.routeTask(tasks, {
      ...base(), sessionId: `s${i}`, messageIds: [`m${i}`], now: base().now + i * 1000,
    });
    tasks = routed.tasks;
  }
  const normalized = anchor.normalizeTasks(tasks);
  assert.equal(Object.keys(normalized.sessions).length, 8);
  assert.equal(normalized.sessions.s11.seriesId, undefined);
  assert.equal(normalized.sessions.s0, undefined);
});

test('R17 切换任务后旧 episode 不再被当前会话引用', () => {
  const first = anchor.routeTask(anchor.emptyTasks(), {
    ...base(), selection: { seriesId: '口播' },
  });
  const switched = anchor.routeTask(first.tasks, {
    ...base(), messageIds: ['m2'], query: '换个任务，做代码审查',
  });
  assert.notEqual(switched.anchor.episodeId, first.anchor.episodeId);
  assert.equal(switched.tasks.sessions.s1.episodeId, switched.anchor.episodeId);
  assert.equal(switched.tasks.episodes[first.anchor.episodeId].status, 'proposed');
});

test('R18 自由措辞不能把未注册栏目变成已绑定', () => {
  const routed = anchor.routeTask(anchor.emptyTasks(), {
    ...base(), query: '做一期美食节目', registeredSeries: ['口播', 'Vlog'],
  });
  assert.equal(routed.anchor.status, 'unbound');
  assert.equal(routed.anchor.seriesId, undefined);
});
