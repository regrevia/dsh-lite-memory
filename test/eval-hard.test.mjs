/**
 * 30 条硬样本：六类各 6 条（近义改写 / 同词不同任务 / 未知或冲突条件 /
 * 预算挤占 / 短续句 / 任务切换·动作触发）。
 * 与 eval-seed 的分工：seed 量「该不该想起」，这里量「换个说法还行不行」「混了别的任务会不会串」。
 * 只断言行为；样本暴露缺口就改 view.js 的排序/门控，不放宽断言、不删样本。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-eval-hard-'));
const view = await import('../view.js');

const base = (extra) => ({
  status: 'active', applicability: 'all_in_scope', conditions: [], selection: null,
  aliases: [], tags: [], triggers: [], when: '', lastUsed: '', ...extra,
});

/** 一块跨领域记忆池：前端、数据库、口播、部署、写作、生活混在一起，同词不同任务才有得考。 */
const MEM = [
  base({
    id: 'mem_200000000001', title: '列表和卡片一律细边框', summary: '边框 1px，不用投影，不新造阴影',
    tags: ['边框', '样式', '阴影'], triggers: ['加个卡片'],
  }),
  base({
    id: 'mem_200000000002', title: '移动端正文最小 14px', summary: '正文 14 起步，注释 12，行高 1.6',
    tags: ['字号', '移动端'], aliases: ['手机字号'],
  }),
  base({
    id: 'mem_200000000003', title: '深色模式只换现有 token', summary: '不新造颜色变量，深色下复用同一套 token',
    tags: ['深色模式', '配色'],
  }),
  base({
    id: 'mem_200000000004', title: '连接池上限按核数乘二', summary: '连接池满了先看慢查询，不是继续加连接',
    tags: ['连接池', '数据库'], triggers: ['加连接'],
  }),
  base({
    id: 'mem_200000000005', title: '慢查询先看执行计划', summary: '执行计划里走了全表扫描才谈加索引',
    tags: ['慢查询', '索引'],
  }),
  base({
    id: 'mem_200000000006', title: '口播开头三句内给结论', summary: '开头别铺垫，三句之内把结论说完',
    applicability: 'conditional', conditions: [{ key: 'seriesId', value: '口播' }],
    tags: ['口播', '开头'],
  }),
  base({
    id: 'mem_200000000007', title: '字幕每行不超过 14 字', summary: '字幕一行最多 14 个字，超出就折行',
    tags: ['字幕', '折行'],
  }),
  base({
    id: 'mem_200000000008', title: '录屏用 60 帧', summary: '录屏 60 帧，掉帧先看编码参数',
    tags: ['录屏', '帧率'],
  }),
  base({
    id: 'mem_200000000009', title: '部署前确认目标机器', summary: '只在确认过的目标机器上执行部署',
    applicability: 'conditional', conditions: [{ key: 'taskKind', value: 'deploy' }],
    tags: ['部署', '目标机器'],
  }),
  base({
    id: 'mem_200000000010', title: '发布后先看错误率再走', summary: '发布完成盯十分钟错误率，异常就直接回滚',
    tags: ['发布', '错误率'], triggers: ['发版完'],
  }),
  base({
    id: 'mem_200000000011', title: '回滚只回上一个稳定版本', summary: '不跨版本回滚，一次退一步',
    tags: ['回滚', '版本'],
  }),
  base({
    id: 'mem_200000000012', title: '总结先给结论再列细节', summary: '总结第一段就是结论，细节往后放',
    tags: ['总结', '结论'],
  }),
  base({
    id: 'mem_200000000013', title: '文档示例写真实路径', summary: '示例里的路径要能直接跑，不留占位符',
    tags: ['示例', '路径'],
  }),
  base({
    id: 'mem_200000000014', title: '中文文案不用省略号收尾', summary: '能写完就写完，不拿省略号兜底',
    tags: ['文案', '省略号'],
  }),
  base({
    id: 'mem_200000000015', title: '基准测试切到 GPU 机器再跑', summary: 'GPU 机器上跑基准，别在本机比较',
    applicability: 'unresolved', tags: ['基准', 'GPU'],
  }),
  base({ id: 'mem_200000000016', title: '咖啡下午两点后不喝', summary: '两点以后喝咖啡晚上就睡不着', tags: ['咖啡'] }),
  base({ id: 'mem_200000000017', title: '周末买菜先列清单', summary: '清单按货架顺序写', tags: ['买菜', '清单'] }),
  base({ id: 'mem_200000000018', title: '照片按月归档', summary: '每月的照片放一个目录', tags: ['照片', '归档'] }),
  base({ id: 'mem_200000000019', title: '地铁末班车 23:10', summary: '差一分钟就没了', tags: ['地铁'] }),
  base({ id: 'mem_200000000020', title: '猫砂两周换一次', summary: '两周整盆换掉', tags: ['猫砂'] }),
  // 发布这一簇：同一个词被部署、写作、生活三类任务各用一次；预算挤占也靠这一簇凑候选。
  base({
    id: 'mem_200000000021', title: '发布前跑四条 lint', summary: '发布前的检查以四条 lint 全绿为准',
    tags: ['发布', '检查'], triggers: ['发布前'],
  }),
  base({
    id: 'mem_200000000022', title: '发布清单按服务分组', summary: '发布清单按服务分组勾选，不按人分',
    tags: ['发布', '清单'],
  }),
  base({
    id: 'mem_200000000023', title: '发布当天不发新功能', summary: '发布当天只修阻塞问题，新功能等下一次',
    tags: ['发布', '新功能'],
  }),
  base({
    id: 'mem_200000000024', title: '发布流程细则', summary: '发布流程分三段时间窗：准备段只做检查与清单核对，窗口段只做发布与观察，收尾段只做记录与回滚确认。准备段里每一条检查都要有人签字，没签字的清单项不许进窗口段。窗口段只看错误率与延迟两条曲线，曲线异常超过十分钟就按回滚处理。收尾段把发布记录、回滚步骤、观察结论写进同一份记录，第二天早会上对着这份记录过一遍。',
    tags: ['发布窗口', '检查单', '流程'],
  }),
  base({
    id: 'mem_200000000025', title: '文案检查先看标点', summary: '文案的检查从标点开始，再看省略号与空格',
    tags: ['文案', '检查'],
  }),
  base({
    id: 'mem_200000000026', title: '字幕检查错别字', summary: '字幕的检查先过错别字，再看每行字数',
    tags: ['字幕', '检查', '错别字'],
  }),
  base({
    id: 'mem_200000000027', title: '回滚要写进发布记录', summary: '每次回滚都要记在发布记录里，写明退了哪个版本',
    tags: ['回滚', '发布', '记录'],
  }),
  base({
    id: 'mem_200000000028', title: '发布预案提前一天过', summary: '发布预案提前一天集体过一遍，预案里的检查项逐条确认。预案只写这一步要做什么检查、由谁确认、不通过时退回哪一步，不写背景和动机。发布预案过完才算进入准备段，没过的预案不许排发布窗口。',
    tags: ['发布窗口', '检查单', '预案'],
  }),
  base({
    id: 'mem_200000000029', title: '发布窗口只看两条曲线', summary: '发布窗口里只盯错误率和延迟两条曲线，其它指标先不看。曲线抬头先确认是不是流量峰值，不是峰值就按异常处理。窗口里每五分钟记一次曲线数，记完才允许看别的。窗口结束前把两条曲线并成一张图，和发布记录放在一起，第二天对上这张图再决定要不要继续观察。',
    tags: ['发布窗口', '检查单', '观察'],
  }),
  base({
    id: 'mem_200000000030', title: '发布窗口收尾写记录', summary: '发布窗口收尾时把记录补齐：窗口段发生了什么、回滚停在哪个版本、观察结论是什么，都写在同一份记录里。收尾记录不写评价只写事实，第二天早会直接对着记录过。收尾记录没写完不算发布结束，也不许开下一次发布窗口。',
    tags: ['发布窗口', '检查单', '收尾'],
  }),
];

const titleOf = (row) => row.record.title;
const titles = (rows) => rows.map(titleOf);
const rank = (query, options = {}) => view.rank(MEM, query, { limit: 3, requireApplicable: true, ...options });

let passed = 0;
let failed = 0;
const fails = [];
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`eval-hard: ${name}`);
  } catch (error) {
    failed += 1;
    fails.push(`${name}：${error.message}`);
    console.log(`eval-hard: 失败 ${name}：${error.message}`);
  }
};

/** 1) 近义改写：说法换掉、实词还在（系统没有同义词表，改写真得靠实词），答案得进前三。 */
const PARAPHRASE = [
  ['卡片想加投影要不要加', '列表和卡片一律细边框'],
  ['移动端注释 12px 会不会太小', '移动端正文最小 14px'],
  ['深色模式要不要另做颜色变量', '深色模式只换现有 token'],
  ['连接池满了还能继续加连接吗', '连接池上限按核数乘二'],
  ['全表扫描要不要先加索引', '慢查询先看执行计划'],
  ['字幕一行装满要折行吗', '字幕每行不超过 14 字'],
];

test('近义改写 6 条都进前三', () => {
  const missed = [];
  for (const [query, want] of PARAPHRASE) {
    const rows = titles(rank(query, { context: { seriesId: '口播' } }));
    if (!rows.includes(want)) missed.push(`${query}→${rows[0] || '空'}`);
  }
  assert.equal(missed.length, 0, `漏了：${missed.join('、')}`);
});

/** 2) 同词不同任务：字面撞上了，正确答案得在，诱饵不许压到它前面。 */
const SAME_WORD = [
  ['发布清单怎么按服务勾选', '发布清单按服务分组', '周末买菜先列清单', {}],
  ['字幕里的错别字怎么检查', '字幕检查错别字', '发布前跑四条 lint', {}],
  ['发布当天还能加新功能吗', '发布当天不发新功能', '发布后先看错误率再走', {}],
  ['回滚记录写到哪份发布记录里', '回滚要写进发布记录', '回滚只回上一个稳定版本', {}],
  ['买菜清单按什么顺序写', '周末买菜先列清单', '发布清单按服务分组', {}],
  ['发布预案要提前多久过一遍', '发布预案提前一天过', '发布流程细则', {}],
];

test('同词不同任务的 6 条，正确答案在且没被诱饵压住', () => {
  const wrong = [];
  for (const [query, want, decoy, context] of SAME_WORD) {
    const rows = titles(rank(query, { context }));
    const at = rows.indexOf(want);
    const decoyAt = rows.indexOf(decoy);
    if (at < 0) wrong.push(`${query}（没想起答案，实得 ${rows[0] || '空'}）`);
    else if (decoyAt >= 0 && decoyAt < at) wrong.push(`${query}（诱饵在前）`);
  }
  assert.equal(wrong.length, 0, wrong.join('、'));
});

/** 3) 未知或冲突条件：条件没确认、或明确相反，都不许当已适用出现。 */
test('条件未知的 3 条不会当作已适用出现', () => {
  const cases = [
    ['部署前要确认哪台机器', '部署前确认目标机器', {}],
    ['部署前要确认哪台机器', '部署前确认目标机器', { taskKind: 'code' }],
    ['基准测试在哪台机器上跑', '基准测试切到 GPU 机器再跑', {}],
  ];
  const exposed = cases.filter(([query, want, context]) => titles(rank(query, { context })).includes(want));
  assert.equal(exposed.length, 0, `条件未知却出现：${exposed.map(([query]) => query).join('、')}`);
});

test('条件冲突的 3 条按条件判：对得上才进来', () => {
  const deploy = titles(rank('部署前要确认哪台机器', { context: { taskKind: 'deploy' } }));
  assert.ok(deploy.includes('部署前确认目标机器'), '任务对上了就该进');
  const series = titles(rank('口播开头三句内给结论', { context: { seriesId: '口播' } }));
  assert.ok(series.includes('口播开头三句内给结论'), '同一系列该进');
  const other = titles(rank('口播开头三句内给结论', { context: { seriesId: '口播-b' } }));
  assert.ok(!other.includes('口播开头三句内给结论'), '换了系列就当没确认');
});

/** 4) 预算挤占：多条争位置时，排第一的答案必须装进来，总量不超 3 条 / 1200 B。 */
const CROWDED = [
  ['发布窗口的检查单怎么排', {}],
  ['发布窗口检查单的流程', {}],
  ['发布窗口检查单的预案', {}],
  ['发布窗口检查单只看哪两条曲线', {}],
  ['发布窗口检查单的收尾记录', {}],
  ['发布窗口检查单的流程、预案、观察、收尾', {}],
];

test('预算挤占的 6 条：第一条答案装得下，且不超 3 条 / 1200 B', () => {
  const bad = [];
  let crowded = 0;
  let trimmed = 0;
  for (const [query, context] of CROWDED) {
    const rows = rank(query, { limit: 8, context });
    if (rows.length >= 4) crowded += 1;
    const cards = view.recallCards(rows, { max: 3, bytes: view.CARD.bytes, header: '已有记忆可能相关：\n' });
    if (!rows.length) { bad.push(`${query}（一条都没排出来）`); continue; }
    if (!cards.cards.some((card) => card.title === titles(rows)[0])) bad.push(`${query}（第一条被挤掉）`);
    if (cards.cards.length > 3) bad.push(`${query}（${cards.cards.length} 条）`);
    if (cards.bytes > view.CARD.bytes) bad.push(`${query}（${cards.bytes} B）`);
    if (cards.omitted.length) trimmed += 1;
  }
  assert.equal(bad.length, 0, bad.join('、'));
  assert.ok(crowded >= 4, `真正有多条争位置的才 ${crowded} 条，挤占没考到`);
  assert.ok(trimmed >= 2, `超预算却没被挤掉过（${trimmed} 条），字节上限没考到`);
});

/** 5) 短续句：本身没线索，要沿用上一轮原话；续说标记不能把换任务吞掉。 */
test('短续句 6 条：认出续说、沿用上一句、不越过换任务', () => {
  const bad = [];
  for (const text of ['继续', '然后呢？', '接着往下', '再试试']) {
    if (!view.isContinuationQuery(text)) bad.push(`没认出续说：${text}`);
  }
  if (!view.isEllipticalContinuation('继续优化收敛')) bad.push('没认出「继续优化收敛」');
  if (view.isEllipticalContinuation('继续优化数据库连接池')) bad.push('「继续优化数据库连接池」点名了新对象，不算纯续说');
  const previous = { kind: 'code', episodeId: 'ep-a' };
  if (!view.sameRecallTask(previous, { kind: 'code', episodeId: 'ep-b' }, { continuation: true })) bad.push('同任务跨轮次续说没接上');
  if (view.sameRecallTask({ kind: 'code' }, { kind: 'video' }, { continuation: true })) bad.push('任务类型变了还沿用旧任务');
  const reuse = titles(rank('连接池满了怎么处理', { limit: 3 }));
  if (!reuse.includes('连接池上限按核数乘二')) bad.push('沿用上一轮原话查不到');
  assert.equal(bad.length, 0, bad.join('；'));
});

/** 6) 任务切换 / 动作触发：换任务要隔开旧任务的动作历史，有状态变更的动作才允许补查。 */
test('任务切换与动作触发 6 条', () => {
  const bad = [];
  if (!view.isExplicitSwitch('先别管这个，去看发布日志', '改插件热刷新')) bad.push('没认出「先别管这个」');
  if (!view.isExplicitSwitch('换成数据库那边', '改插件热刷新')) bad.push('没认出「换成」');
  if (view.isExplicitSwitch('继续优化连接池', '优化连接池')) bad.push('同一件事被当成换任务');
  if (!view.isExplicitSwitch('切到 postgres 那边的连接池', 'node 服务改完了')) bad.push('新对象没算换任务');
  const call = (name, input) => [{ role: 'assistant', content: [{ type: 'tool-call', name, input }] }];
  if (!view.hasEffectiveAction(call('bash', { command: 'npm test' }))) bad.push('跑测试不算有效动作');
  if (view.hasEffectiveAction(call('memory_save', { title: 'x' }))) bad.push('记忆工具自己触发自己');
  if (view.hasEffectiveAction(call('read', { path: 'README.md' }))) bad.push('纯读取不该消耗补查');
  if (!view.hasConcreteAction('重启一下宿主再试')) bad.push('口头的具体动作没认出来');
  // 换到内容任务之后，部署条件规则不许跟过来
  const switched = titles(rank('发布后的错误率怎么看', { context: { taskKind: 'content' } }));
  if (switched.includes('部署前确认目标机器')) bad.push('换任务后部署规则乱入');
  assert.equal(bad.length, 0, bad.join('；'));
});

/** 7) 固定负例：跟这块记忆池没有任何关系的问题，一条都不许冒出来（0 误触发）。 */
const NEGATIVE = ['今天会下雨吗', '帮我译成英文', '股票今天涨了吗', '明天几点开会', '算法时间复杂度怎么算', 'git 分支怎么删'];

test('固定负例 6 条 0 误触发', () => {
  const leaked = [];
  for (const query of NEGATIVE) {
    const rows = titles(rank(query, { limit: 8 }));
    if (rows.length) leaked.push(`${query}→${rows[0]}`);
  }
  assert.equal(leaked.length, 0, `误触发：${leaked.join('、')}`);
});

console.log(`eval-hard: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('eval-hard 失败清单：');
  for (const line of fails) console.log(`- ${line}`);
  process.exitCode = 1;
}
