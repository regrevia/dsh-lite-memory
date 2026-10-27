import assert from 'node:assert/strict';
import fs from 'node:fs';
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

const dirOf = (label) => {
  const dir = path.join(os.tmpdir(), `lite-memory-layer-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const projectA = dirOf('a');
const projectB = dirOf('b');

// A 项目里存了一条带条件的路径记忆；B 项目按标题读要能拿到。
const saved = store.saveEntry(store.scopeOf(projectA), {
  title: '本机凭据位置：npm 发布与 GitHub 推送',
  summary: 'npm token 在 Keychain，GitHub 默认 regrevia',
  body: 'npm publish --userconfig /tmp/npmrc_dsh；GitHub 默认 regrevia。',
  memoryClass: 'project_fact',
});
assert.equal(saved.chosenScope, 'project');
const idOfA = saved.record.id;

// 面板/HTTP 用 id 探正文必须仍然只看本层，跨层就是越权。
const scoped = store.locate(store.scopeOf(projectB), idOfA);
assert.equal(scoped, null, '默认 locate 不跨层');
const crossed = store.locate(store.scopeOf(projectB), idOfA, { crossLayer: true });
assert.equal(crossed?.record?.title, '本机凭据位置：npm 发布与 GitHub 推送');

// B 项目的会话按标题读：跨层可读，正文给全。
const read = await exec('memory_read', { title: '本机凭据位置：npm 发布与 GitHub 推送' }, projectB);
assert.equal(read.status, 'ok');
assert.match(read.body, /npm publish/);
assert.equal(read.title, '本机凭据位置：npm 发布与 GitHub 推送');

// 同名不存在时仍然老实报没有，并且提示对标题。
await assert.rejects(
  () => exec('memory_read', { title: '这条记忆从来没有存过' }, projectB),
  /没有「这条记忆从来没有存过」这条记忆/,
);

// 带有无法确认的条件的记忆：点名标题读要拿到正文，同时标明适用范围待确认。
store.saveEntry(store.scopeOf(projectA), {
  title: '发版当天要做的三件事',
  summary: '发版当天先冻结、再打标签、最后公告',
  body: '一冻结代码；二打标签；三发公告。',
  when: '发版当天',
  memoryClass: 'project_fact',
});
const conditional = await exec('memory_read', { title: '发版当天要做的三件事' }, projectB);
assert.equal(conditional.status, 'needs_context');
assert.match(conditional.body, /打标签/);
assert.equal(conditional.when, '发版当天');
const text = defs.get('memory_read').output.render({}, conditional)[0].text;
assert.match(text, /适用范围待确认/);
assert.doesNotMatch(text, /mem_[a-z0-9]{6,}/);

// 只给 id 的程序化取用不放正文，门槛不变。
await assert.rejects(
  () => exec('memory_read', { id: 'mem_000000000000' }, projectB),
  /没有「mem_000000000000」这条记忆/,
);


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

console.log('layer-read ok');
