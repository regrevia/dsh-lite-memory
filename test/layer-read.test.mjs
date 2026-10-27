import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-layer-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');

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
apply(ctx, { mode: 'adaptive' });
const exec = (name, args, cwd) => defs.get(name).execute(args, { agent: { cwd } });
const render = (name, args, value) => defs.get(name).output.render(args, value)[0].text;

const dirOf = (label) => {
  const dir = path.join(os.tmpdir(), `lite-memory-layer-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const projectA = dirOf('a');
const projectB = dirOf('b');

// A 项目存一条普通记忆；B 的运行时不得通过标题或 id 拿到 A 的正文。
const saved = store.saveEntry(store.scopeOf(projectA), {
  title: '甲项目发布约定',
  summary: '甲项目部署前先维护独立业务队列',
  body: '甲项目专用：部署前先维护独立业务队列。',
  memoryClass: 'project_fact',
});
assert.equal(saved.chosenScope, 'project');
const idOfA = saved.record.id;

const layers = store.runtimeLayers(store.scopeOf(projectB)).map((item) => item.key);
assert.equal(layers.length, 2, '运行时只有当前项目和全局两层');
assert.ok(!layers.includes(store.scopeOf(projectA).key), '运行时层不枚举其他项目');

await assert.rejects(
  () => exec('memory_read', { title: '甲项目发布约定' }, projectB),
  /没有「甲项目发布约定」这条记忆/,
  '跨项目标题不得解析到别的项目',
);
await assert.rejects(
  () => exec('memory_read', { id: idOfA }, projectB),
  /没有「.*」这条记忆/,
  '跨项目 id 也不得读到正文',
);
assert.equal(store.locate(store.scopeOf(projectB), idOfA), null, '默认 locate 不跨层');

// B 读自己的条目：运行时只锁当前项目和全局，A 的条目不在枚举里。
const own = store.saveEntry(store.scopeOf(projectB), {
  title: '乙项目发布约定',
  summary: '乙项目部署前先跑迁移',
  body: '乙项目专用：部署前先跑迁移。',
  memoryClass: 'project_fact',
});
assert.ok(own.record);
const readOwn = await exec('memory_read', { title: '乙项目发布约定' }, projectB);
assert.equal(readOwn.status, 'ok');
assert.match(readOwn.body, /先跑迁移/);
assert.equal(readOwn.scope, 'project');

// 同名项目／全局条目：指定 global 只解析全局，不串到项目层。
store.saveEntry(store.globalScope(), {
  title: '同名发布约定',
  summary: '全局：发布前先确认远端已推送',
  body: '全局：发布前先确认远端已推送。',
  memoryClass: 'personal_preference',
});
store.saveEntry(store.scopeOf(projectB), {
  title: '同名发布约定',
  summary: '项目：发布前先更新 CHANGELOG',
  body: '项目：发布前先更新 CHANGELOG。',
  memoryClass: 'project_fact',
  resolution: 'distinct',
});
const readGlobal = await exec('memory_read', { title: '同名发布约定', scope: 'global' }, projectB);
assert.equal(readGlobal.status, 'ok');
assert.match(readGlobal.body, /远端已推送/, 'scope:global 必须读全局那条');
assert.match(render('memory_read', { title: '同名发布约定', scope: 'global' }, readGlobal), /^memory · \[global\] 「同名发布约定」/, '读到的全局条目要带 [global]，不能冒充当前项目');
const readProject = await exec('memory_read', { title: '同名发布约定' }, projectB);
assert.match(readProject.body, /CHANGELOG/, '不指定范围时先读当前项目');
assert.doesNotMatch(render('memory_read', { title: '同名发布约定' }, readProject), /\[global\]/, '项目条目不能被标成全局');

// 同名条目跨层更新：不指定范围先报候选，指定 global 只改全局，项目条目原样。
const ambiguous = await exec('memory_save', {
  updateTitle: '同名发布约定',
  summary: '改了但没说是哪一层',
  body: '改了但没说是哪一层。',
  memoryClass: 'project_fact',
}, projectB);
assert.match(ambiguous.error, /各有一条/, '同名跨层不给默认匹配');
const globalUpdate = await exec('memory_save', {
  scope: 'global',
  updateTitle: '同名发布约定',
  summary: '全局：发布前先确认远端已推送并打 tag',
  body: '全局：发布前先确认远端已推送并打 tag。',
  memoryClass: 'personal_preference',
}, projectB);
assert.equal(globalUpdate.error, undefined);
assert.equal(globalUpdate.scope, 'global');
assert.match((await exec('memory_read', { title: '同名发布约定', scope: 'global' }, projectB)).body, /打 tag/);
assert.match((await exec('memory_read', { title: '同名发布约定' }, projectB)).body, /CHANGELOG/, '项目条目没有被全局更新带跑');

// 条件未确认：标题只能定位，不能证明适用；不返回正文。
store.saveEntry(store.scopeOf(projectB), {
  title: '发版当天步骤',
  summary: '发版当天冻结、打标签、公告',
  body: '冻结代码，然后打标签。',
  when: '发版当天',
  memoryClass: 'project_fact',
});
const conditional = await exec('memory_read', { title: '发版当天步骤' }, projectB);
assert.equal(conditional.status, 'needs_context');
assert.equal(conditional.body, '', '条件未知时标题读取不得先给正文');
assert.equal(conditional.when, undefined);
const text = defs.get('memory_read').output.render({}, conditional)[0].text;
assert.doesNotMatch(text, /冻结代码/, '渲染文本也不得带正文');
assert.doesNotMatch(text, /mem_[a-z0-9]{6,}/);

// 只给 id 的程序化取用不放正文，门槛不变。
await assert.rejects(
  () => exec('memory_read', { id: 'mem_000000000000' }, projectB),
  /没有「mem_000000000000」这条记忆/,
);

// 归档后仍能按标题彻底删除；归档不重新参与召回。
const ownRecord = store.locateByTitle(store.scopeOf(projectB), '乙项目发布约定');
assert.ok(ownRecord);
store.forget(store.scopeOf(projectB), ownRecord.record.id, { mode: 'archive' });
await exec('memory_forget', { title: '乙项目发布约定', mode: 'purge' }, projectB);
assert.equal(store.locateByTitle(store.scopeOf(projectB), '乙项目发布约定'), null, '归档后可按标题 purge');
assert.equal(store.locateByTitle(store.scopeOf(projectB), '乙项目发布约定', { crossLayer: true }), null, '彻底删除后哪一层都查不到');
assert.equal(store.readEntry(store.scopeOf(projectB), ownRecord.record.id), null, '正文也不在了');

// 显式 scope="project" 只解析项目层：全局唯一条目不能被读，更不能被 purge 掉。
const globalOnly = store.saveEntry(store.globalScope(), {
  title: '全局唯一凭据入口',
  summary: '全局：凭据只从密码管理器取',
  body: '全局：凭据只从密码管理器取，不写进仓库。',
  memoryClass: 'personal_preference',
});
assert.ok(globalOnly.record, '全局条目已写入');
await assert.rejects(
  () => exec('memory_read', { title: '全局唯一凭据入口', scope: 'project' }, projectB),
  /没有「全局唯一凭据入口」这条记忆/,
  '显式项目层不得读到全局条目',
);
await assert.rejects(
  () => exec('memory_forget', { title: '全局唯一凭据入口', scope: 'project', mode: 'purge' }, projectB),
  /没有「全局唯一凭据入口」这条记忆/,
  '显式项目层不得彻底删除全局条目',
);
const globalOnlyAfter = store.locate(store.scopeOf(projectB), globalOnly.record.id, { layers: [store.globalScope()] });
assert.ok(globalOnlyAfter, '全局条目仍在原层');
assert.match(globalOnlyAfter.record.body || '', /密码管理器/, '正文没有被错层删除');

// 相近条目在另一层时，确认提示要给出能落地的动作：更新就落到那一层，否则会另建一条。
const globalDraft = store.saveEntry(store.scopeOf(projectB), {
  title: 'npm 发布凭据取用与发布后验版',
  summary: 'npm 发布用 account regrevia，发布后轮询 dist-tags 验版',
  body: '发布用 regrevia 身份；发完轮询 dist-tags.latest 判上线。',
  memoryClass: 'personal_preference',
});
assert.equal(globalDraft.chosenScope, 'global');
const near = await exec('memory_save', {
  title: 'npm 发布凭据怎么取用、发完怎么验版',
  summary: 'npm 发布用 regrevia，发完轮询 dist-tags 验证版本',
  body: 'npm publish 之后轮询 dist-tags 确认版本。',
  memoryClass: 'project_fact',
}, projectB);
assert.equal(near.needsResolution, true);
assert.equal(near.crossLayer, true);
assert.equal(near.crossScope, 'global');
const nearText = defs.get('memory_save').output.render({}, near)[0].text;
assert.match(nearText, /scope="global"/);
assert.doesNotMatch(nearText, /mem_[a-z0-9]{6,}/);

// 生命周期：被取代或过期的条目不再自动召回，也不通过标题读交正文。
const view = await import('../view.js');
const first = store.saveEntry(store.scopeOf(projectB), {
  title: '旧版发布流程',
  summary: '旧版：手工上传',
  body: '旧版：手工上传到服务器。',
  memoryClass: 'project_fact',
});
const next = store.saveEntry(store.scopeOf(projectB), {
  title: '新版发布流程',
  summary: '新版：CI 自动发布',
  body: '新版：CI 自动发布。',
  memoryClass: 'project_fact',
  supersedes: first.record.id,
  resolution: 'distinct',
});
assert.equal(next.chosenScope, 'project');
const stale = view.eligibility({ ...first.record, validUntil: '', supersededBy: next.record.id }, {}, 'auto');
assert.equal(stale.ok, false, '被取代的条目不得自动召回');
assert.equal(stale.reason, 'superseded');
const staleRead = await exec('memory_read', { title: '旧版发布流程' }, projectB);
assert.equal(staleRead.status, 'gone', '被取代条目按标题读只报已不在');
assert.equal(staleRead.body, '');
const staleHits = store.search(store.scopeOf(projectB), '旧版发布流程');
assert.ok(!staleHits.some((item) => (item.record || item).id === first.record.id || (item.record || item).title === '旧版发布流程'), '默认检索不返回被取代条目');
assert.equal(view.eligibility({ status: 'active', validUntil: '2000-01-01T00:00:00Z' }, {}, 'auto').ok, false, '过期条目不得召回');
assert.equal(view.eligibility({ status: 'active', validUntil: '2000-01-01T00:00:00Z' }, {}, 'read').reason, 'expired');

// 忘掉同名条目：不带层就报候选，带 global 只归档全局，项目条目还在。
await assert.rejects(() => exec('memory_forget', { title: '同名发布约定', mode: 'archive' }, projectB), /各有一条/, '同名跨层删除不给默认匹配');
const globalForget = await exec('memory_forget', { title: '同名发布约定', scope: 'global', mode: 'archive' }, projectB);
assert.equal(globalForget.mode, 'archive');
assert.equal(globalForget.scope, 'global');
assert.equal((await exec('memory_read', { title: '同名发布约定' }, projectB)).status, 'ok', '项目条目没被一起归档');
const archivedGlobal = await exec('memory_read', { title: '同名发布约定', scope: 'global' }, projectB);
assert.equal(archivedGlobal.status, 'archived', '归档条目按标题只报已归档');
assert.equal(archivedGlobal.body, '');

// 别的项目正在写，不影响本项目的读和写：运行时锁只覆盖当前项目和全局。
store.saveEntry(store.scopeOf(projectB), {
  title: '锁隔离验证',
  summary: '锁隔离验证条目',
  body: '锁隔离验证条目正文。',
  memoryClass: 'project_fact',
});
const marker = path.join(os.tmpdir(), `lite-memory-hold-${Math.random().toString(16).slice(2, 8)}`);
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const holder = spawn(process.execPath, ['--input-type=module', '-e', `
  import fs from 'node:fs';
  const { scopeOf } = await import('./store.js');
  const state = await import('./state.js');
  const scope = scopeOf(process.argv[1]);
  state.withScopeLock(scope, () => {
    fs.writeFileSync(process.argv[2], '1');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
  });
`, projectA, marker], { cwd: repo, stdio: 'ignore', env: process.env });
for (let i = 0; i < 200 && !fs.existsSync(marker); i += 1) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
assert.ok(fs.existsSync(marker), '子进程已拿到 A 项目锁');
const started = Date.now();
const lockedRead = await exec('memory_read', { title: '锁隔离验证' }, projectB);
const elapsed = Date.now() - started;
assert.equal(lockedRead.status, 'ok');
assert.match(lockedRead.body, /锁隔离验证条目正文/);
assert.ok(elapsed < 200, `A 项目持锁时 B 的读取不得等锁（实际 ${elapsed}ms）`);
const lockedSave = await exec('memory_save', { title: '锁隔离验证二', summary: '第二条', body: '第二条正文。', memoryClass: 'project_fact' }, projectB);
assert.equal(lockedSave.error, undefined);
assert.equal(lockedSave.scope, 'project');
holder.kill();

// 关联清单也要标层：项目邻居与全局邻居一眼分得清，不靠标题猜。
const globalLinkTarget = store.saveEntry(store.globalScope(), {
  title: '全局关联目标',
  summary: '全局层的邻居',
  body: '全局层的邻居正文。',
  memoryClass: 'personal_preference',
});
assert.ok(globalLinkTarget.record);
const projectLinkTarget = store.saveEntry(store.scopeOf(projectB), {
  title: '项目关联目标',
  summary: '项目层的邻居',
  body: '项目层的邻居正文。',
  memoryClass: 'project_fact',
  resolution: 'distinct',
});
assert.ok(projectLinkTarget.record);
const linked = await exec('memory_save', {
  title: '带两个邻居的条目',
  summary: '同时关联项目与全局',
  body: '同时关联项目与全局。',
  memoryClass: 'project_fact',
  links: [{ title: '项目关联目标' }, { title: '全局关联目标' }],
}, projectB);
assert.equal(linked.error, undefined);
const linkView = await exec('memory_read', { title: '带两个邻居的条目', view: 'links' }, projectB);
const linkText = render('memory_read', { title: '带两个邻居的条目', view: 'links' }, linkView);
assert.match(linkText, /「项目关联目标」/);
assert.match(linkText, /\[global\] 「全局关联目标」/, '全局邻居要带 [global]');
assert.doesNotMatch(linkText, /\[global\] 「项目关联目标」/, '项目邻居不能被标成全局');

console.log('layer-read ok');
