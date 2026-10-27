/**
 * 30 条固定样本的召回基线：10 该召回、10 该拒绝、10 该等条件确认。
 * 只断言行为（召回率 / 误触发 / 边界外泄），措辞取用户原话视角。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-eval-'));
const view = await import('../view.js');

const base = (extra) => ({
  status: 'active', applicability: 'all_in_scope', conditions: [], selection: null,
  aliases: [], tags: [], triggers: [], when: '', lastUsed: '', ...extra,
});

const MEM = [
  base({ id: 'mem_100000000001', title: '插件改完先试热刷新', summary: '热刷新不行再重启宿主', triggers: ['插件改完'] }),
  base({ id: 'mem_100000000002', title: '发版前跑四条 lint', summary: '文案、中文排印、风格、检测器都要清零', triggers: ['发版'] }),
  base({ id: 'mem_100000000003', title: '外链一律用绝对路径', summary: '聊天里的文件链接必须绝对路径，否则点开报 ENOENT' }),
  base({ id: 'mem_100000000004', title: '截图只在看外观时用', summary: '判断页面对不对读文本树' }),
  base({ id: 'mem_100000000005', title: '写盘先写临时文件再改名', summary: 'rename 之后 fsync 目录，避免半截文件' }),
  base({ id: 'mem_100000000006', title: '客户端包上限四十 KiB', summary: 'gzip 之后超过就不许合入' }),
  base({ id: 'mem_100000000007', title: '测试日志写到临时目录', summary: '长跑放后台，用 EXIT= 判断结果' }),
  base({ id: 'mem_100000000008', title: '推送前先跑全量测试', summary: '绿了再 commit' }),
  base({ id: 'mem_100000000009', title: '一次性脚本用完就删', summary: '这个脚本只跑一次，别留仓库里' }),
  base({ id: 'mem_100000000010', title: '中文文案不用省略号收尾', summary: '能写完就写完' }),
  base({
    id: 'mem_100000000011', title: '部署前确认目标机器', summary: '只在目标机器上执行',
    applicability: 'conditional', conditions: [{ key: 'taskKind', value: 'deploy' }],
  }),
  base({ id: 'mem_100000000012', title: '配色只沿用现有 token', summary: '不新造颜色', applicability: 'unresolved' }),
];

/** 10 条该召回：查询是真人会说的话，答案就在标题/关键词里。 */
const RECALL = [
  ['插件改完怎么让它生效？', '插件改完先试热刷新'],
  ['发版之前要跑哪些检查？', '发版前跑四条 lint'],
  ['聊天里给的文件链接怎么写？', '外链一律用绝对路径'],
  ['判断页面报错要截图吗？', '截图只在看外观时用'],
  ['写文件怎么保证不会写出半截？', '写盘先写临时文件再改名'],
  ['客户端包大小有上限吗？', '客户端包上限四十 KiB'],
  ['测试日志放哪里？', '测试日志写到临时目录'],
  ['推送代码前要做什么？', '推送前先跑全量测试'],
  ['临时脚本要留在仓库里吗？', '一次性脚本用完就删'],
  ['中文文案末尾要加省略号吗？', '中文文案不用省略号收尾'],
];

/** 10 条该拒绝：字面上有常见词，但跟任何一条记忆都不相关。 */
const REJECT = [
  '把这段视频的字幕导出来',
  '明早路过菜市场买点香菜',
  '这个季节樱桃多少钱一斤',
  '帮我把上周的照片按日期归类',
  '厨房水槽下面有点漏水',
  '地铁六号线末班车几点',
  '明天杭州会下雨吗',
  '给猫换一个更安静的猫砂盆',
  '这本书的第二章讲什么',
  '楼下咖啡店的营业时间',
];

/** 10 条该等条件：找到了，但适用条件还没确认，不许当已适用塞进上下文。 */
const AWAIT = [
  ['这台机器部署前要确认什么？', '部署前确认目标机器'],
  ['部署脚本怎么跑？', '部署前确认目标机器'],
  ['机器对不上能直接部署吗？', '部署前确认目标机器'],
  ['新页面的配色怎么定？', '配色只沿用现有 token'],
  ['这个组件能新造颜色吗？', '配色只沿用现有 token'],
  ['界面上可以加渐变吗？', '配色只沿用现有 token'],
  ['主题色改成什么了？', '配色只沿用现有 token'],
  ['图标颜色跟着谁走？', '配色只沿用现有 token'],
  ['按钮圆角用新的吗？', '配色只沿用现有 token'],
  ['换肤要动哪些变量？', '配色只沿用现有 token'],
];

const titleOf = (row) => row.record.title;
const rank = (query, context = {}) => view.rank(MEM, query, { limit: 3, requireApplicable: true, context });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`eval: ${name}`);
};

test('该召回的 10 条都进前三', () => {
  const missed = RECALL.filter(([query, want]) => !rank(query).slice(0, 3).some((row) => titleOf(row) === want));
  const recallAt3 = (RECALL.length - missed.length) / RECALL.length;
  assert.ok(recallAt3 >= 0.9, `Recall@3 ${recallAt3}；漏了：${missed.map((row) => row[0]).join('、')}`);
});

test('该拒绝的 10 条一条都不出现', () => {
  const leaked = REJECT.filter((query) => rank(query).length > 0);
  assert.equal(leaked.length, 0, `误触发：${leaked.join('、')}`);
});

test('条件未确认的 10 条不会当作已适用出现', () => {
  const exposed = AWAIT.filter(([query, want]) => rank(query).some((row) => titleOf(row) === want));
  assert.equal(exposed.length, 0, `条件未知却进了上下文：${exposed.map((row) => row[0]).join('、')}`);
});

test('条件确认之后同一条就能用', () => {
  const rows = rank('这台机器部署前要确认什么？', { taskKind: 'deploy' });
  assert.ok(rows.some((row) => titleOf(row) === '部署前确认目标机器'));
});

test('措辞不同也能召回（同义说法不依赖逐字重合）', () => {
  assert.ok(rank('热刷新不生效是不是要重启').some((row) => titleOf(row) === '插件改完先试热刷新'));
});

console.log(`eval: ${passed} passed`);
