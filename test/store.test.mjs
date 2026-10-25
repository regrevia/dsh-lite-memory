import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-'));
process.env.DSH_HOME = home;

const scope = store.scopeOf('/tmp/project-a');
const other = store.scopeOf('/tmp/project-b');
const draft = { title: '插件市场条目规范', summary: '市场上传指南的位置与要点', body: '- 位置：UPLOAD-GUIDE.md' };

// 基本保存、检索、正文、命中计数。
const first = store.upsert(scope, draft);
assert.equal(first.merged, false);
assert.equal(store.loadIndex(scope).entries.length, 1);
assert.deepEqual(store.search(scope, '插件市场').map((item) => item.id), [first.record.id]);
assert.deepEqual(store.search(scope, '量子力学'), []);
assert.deepEqual(store.loadIndex(other).entries, []);
const read = store.readEntry(scope, first.record.id);
assert.match(read.body, /UPLOAD-GUIDE/);
assert.ok(store.loadIndex(scope).entries[0].hits >= 2);
console.log('store: save / search / read ok');

// 中文长句按字片召回；摘要里的词也算。
const longQuery = store.upsert(store.scopeOf('/tmp/recall'), { title: '发布流程', summary: '打 tag 后推分支再发 npm 包', body: '- 顺序：tag → push → publish' });
assert.deepEqual(store.search(store.scopeOf('/tmp/recall'), '上次发布流程是什么').map((item) => item.id), [longQuery.record.id]);
console.log('store: 中文长句召回 ok');

// 校验：名词短语、凭据（含 when / tags 里的凭据）。
assert.throws(() => store.upsert(scope, { title: 'x', summary: '你要记得用 tab 缩进' }), /名词短语/);
assert.throws(() => store.upsert(scope, { title: 'y', summary: '凭据位置', body: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }), /凭据/);
assert.throws(() => store.upsert(scope, { title: 'z', summary: '凭据位置', when: 'token: abcdef012345' }), /凭据/);
assert.throws(() => store.upsert(scope, { title: 'x'.repeat(80), summary: '标题太长' }), /标题超过/);
console.log('store: 全字段校验 ok');

// 标题就是身份：同一个标题再存一次是更新，正文只增不减。
const second = store.upsert(scope, { ...draft, summary: '市场上传指南的位置与要点（更新）', body: '- 抓取：先跑 marketplace' });
assert.equal(second.merged, true);
assert.equal(second.record.id, first.record.id);
assert.equal(store.loadIndex(scope).entries.length, 1);
assert.equal(store.loadIndex(scope).entries[0].merges, 1);
const mergedBody = store.readEntry(scope, first.record.id).body;
assert.match(mergedBody, /UPLOAD-GUIDE/);
assert.match(mergedBody, /marketplace/);
// 旧正文留在 versions 里，可回滚。
assert.match(store.loadIndex(scope).entries[0].versions.at(-1).body, /UPLOAD-GUIDE/);
console.log('store: 同标题更新 + 版本快照 ok');

// 相似不授权覆盖：前端/后端的同位置条目各留各的值。
const similarScope = store.scopeOf('/tmp/similar');
const fe = store.upsert(similarScope, { title: '前端 API 地址', summary: '页面请求用的服务接口地址', body: '- 地址：https://frontend.example.test' });
const be = store.upsert(similarScope, { title: '后端 API 地址', summary: '页面请求用的服务接口地址', body: '- 地址：https://backend.example.test' });
assert.equal(be.merged, false);
assert.equal(be.record.id !== fe.record.id, true);
assert.equal(be.similar?.id, fe.record.id);
assert.match(store.readEntry(similarScope, fe.record.id).body, /frontend\.example\.test/);
assert.equal(store.readEntry(similarScope, fe.record.id).body.includes('backend'), false);
console.log('store: 相近只提示、不覆盖 ok');

// 明确按 id 更新，标题换掉时旧标题进别名，旧标题再存回来还认得。
const renamed = store.upsert(similarScope, { id: fe.record.id, title: '前端 API 地址（v2）', summary: '页面请求用的服务接口地址', body: '- 地址：https://frontend.example.test/v2' });
assert.equal(renamed.merged, true);
assert.equal(store.loadIndex(similarScope).entries.find((item) => item.id === fe.record.id).aliases.includes('前端 API 地址'), true);
const back = store.upsert(similarScope, { title: '前端 API 地址', summary: '页面请求用的服务接口地址', body: '- 备注：旧标题仍指向同一条' });
assert.equal(back.merged, true);
assert.equal(back.record.id, fe.record.id);
assert.equal(store.loadIndex(similarScope).entries.length, 2);
console.log('store: id 更新与别名回溯 ok');

// 正文合并只在同一章节内覆盖同名键。
const sectionsScope = store.scopeOf('/tmp/sections');
store.upsert(sectionsScope, {
  title: '服务端口',
  summary: '前端与后端的本地端口',
  body: '## 前端\n- 端口：3000\n\n## 后端\n- 端口：9000',
});
store.upsert(sectionsScope, { title: '服务端口', summary: '前端与后端的本地端口', body: '## 后端\n- 端口：9100' });
const sectionBody = store.readEntry(sectionsScope, store.loadIndex(sectionsScope).entries[0].id).body;
assert.match(sectionBody, /## 前端\n- 端口：3000/);
assert.match(sectionBody, /## 后端\n- 端口：9100/);
console.log('store: 章节内合并 ok');

// 前置条件参与身份：不同 when 是两条，同一 when 才合并。
const mac = store.upsert(sectionsScope, { title: '构建耗时长', summary: '本机构建要几分钟', when: 'macOS 本地', body: '- 原因：磁盘加密' });
const ci = store.upsert(sectionsScope, { title: '构建耗时长', summary: '本机构建要几分钟', when: 'CI 容器', body: '- 原因：冷缓存' });
assert.equal(mac.merged, false);
assert.equal(ci.merged, false);
assert.notEqual(ci.record.id, mac.record.id);
const plus = store.upsert(sectionsScope, { title: '构建耗时长', summary: '本机构建要几分钟', when: 'macOS 本地', body: '- 绕过：先跑 cache\n- 原因：磁盘加密拖慢' });
assert.equal(plus.merged, true);
assert.equal(plus.record.id, mac.record.id);
assert.equal(store.readEntry(sectionsScope, mac.record.id).body.includes('磁盘加密\n'), false);
assert.ok(store.search(sectionsScope, 'CI 容器').some((item) => item.id === ci.record.id));
console.log('store: 前置条件规则 ok');

// 全局层：一处写入，别的项目查得到；两层同名各存各的，全局 id 跨作用域可读可归档。
const projA = store.scopeOf('/tmp/global-a');
const projB = store.scopeOf('/tmp/global-b');
const global = store.globalScope();
store.upsert(global, { title: '回复用中文', summary: '所有项目的中文回复约定', body: '- 回复：中文' });
const seen = store.search(projB, '中文回复');
assert.equal(seen.some((item) => item.scope === 'global'), true);
const local = store.upsert(projA, { title: '回复用中文', summary: '所有项目的中文回复约定', body: '- 回复：中文' });
assert.equal(local.merged, false);
assert.equal(store.loadIndex(global).entries.length, 1);
assert.equal(store.loadIndex(projA).entries.length, 1);
assert.match(store.readEntry(projB, seen[0].id).body, /中文/);
store.forget(projB, seen[0].id);
assert.equal(store.loadIndex(global).entries.length, 0);
console.log('store: 全局层 ok');

// 建议门限：相近就不再建议；48 小时一条；草稿与正式保存同一套校验。
assert.equal(store.suggestionGate(scope, { title: '插件市场条目规范' }).ok, false);
const noted = store.noteSuggestion(scope, { title: '提交前先跑 lint', summary: '交付前的文案检查步骤', when: '发布前', body: '- 命令：node scripts/lint.mjs' });
assert.ok(noted.id.startsWith('sug_'));
assert.equal(store.suggestionGate(scope, { title: '另一条' }).ok, false);
const kept = store.findSuggestion(scope, noted.id);
assert.equal(kept.when, '发布前');
assert.throws(() => store.noteSuggestion(scope, { title: '凭据草稿', summary: 'token 位置', body: 'sk-abcdefghijklmnopqrstuvwxyz' }), /凭据/);
store.upsert(scope, { title: '提交前先跑 lint', summary: '交付前的文案检查步骤', when: '发布前' });
const gateIndex = store.loadIndex(scope);
gateIndex.lastSuggestedAt = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
store.saveIndex(scope, gateIndex);
assert.equal(store.suggestionGate(scope, { title: '新的建议' }).ok, true);
assert.equal(store.suggestionGate(scope, { title: '提交前先跑 lint 的步骤' }).ok, false);
console.log('store: 建议门限与草稿校验 ok');

// 陈旧条目不展示摘要。
const old = store.upsert(scope, { title: '很久没用到的条目', summary: '三个月没命中', body: 'x' });
const staleIndex = store.loadIndex(scope);
staleIndex.entries = staleIndex.entries.map((item) =>
  item.id === old.record.id ? { ...item, lastUsed: new Date(Date.now() - 400 * 86400000).toISOString() } : item,
);
store.saveIndex(scope, staleIndex);
const stale = store.loadIndex(scope).entries.find((item) => item.id === old.record.id);
const rendered = store.renderIndex([stale]);
assert.equal(rendered.text.includes('｜'), false);
assert.ok(rendered.text.includes(old.record.title));
console.log('store: 陈旧展示 ok');

// 归档不是删除：正文与完整记录都留下来，索引只在这之后才改。
const forgotten = store.forget(scope, first.record.id);
assert.equal(forgotten.title, draft.title);
assert.equal(store.loadIndex(scope).entries.some((item) => item.id === first.record.id), false);
const archivedBody = path.join(scope.dir, 'archive', `${first.record.id}.md`);
const archivedMeta = path.join(scope.dir, 'archive', `${first.record.id}.json`);
assert.ok(fs.existsSync(archivedBody));
assert.equal(JSON.parse(fs.readFileSync(archivedMeta, 'utf8')).title, draft.title);
console.log('store: 归档保留正文与记录 ok');

// 索引损坏必须报错，绝不拿空库覆盖。
fs.writeFileSync(path.join(scope.dir, 'index.json'), '{ broken');
assert.throws(() => store.loadIndex(scope), /已损坏/);
assert.throws(() => store.upsert(scope, { title: '新条目', summary: '不该写进去' }), /已损坏/);
assert.equal(fs.readFileSync(path.join(scope.dir, 'index.json'), 'utf8'), '{ broken');
fs.rmSync(path.join(scope.dir, 'index.json'));
console.log('store: 损坏索引拒绝覆盖 ok');

// 上限：条目数与总大小都由归档维持。
for (let i = 0; i < 240; i += 1) {
  store.upsert(scope, { title: `条目 ${i}`, summary: `第 ${i} 条`, body: 'x' });
}
const trimmed = store.loadIndex(scope);
assert.ok(trimmed.entries.length <= store.LIMITS.entries);
assert.ok(trimmed.totalBytes <= store.LIMITS.totalBytes);
assert.ok(fs.readdirSync(path.join(scope.dir, 'archive')).length > 0);
console.log('store: 容量上限 ok');

fs.rmSync(home, { recursive: true, force: true });
console.log('store: all checks passed');
