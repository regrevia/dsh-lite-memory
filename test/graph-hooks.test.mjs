/**
 * 图谱组件的 hook 顺序守卫。
 *
 * 1) 静态扫描：MemoryGraph 函数体里，任何 React.use* 都不能出现在
 *    顶层 if (...) return 之后——空图早退曾把 useMemo 甩到 return 后面，
 *    真实 React 会报 "Rendered more hooks than during the previous render"。
 * 2) 运行时序列：用假 React 记录两次渲染（空图 / 有图）调用的 hook 名，
 *    两次必须一模一样。
 * 3) 真实 React 用例：没装 react 就明确跳过并说明原因（仓库不允许新增依赖）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const clientPath = new URL('../client.js', import.meta.url);
const source = fs.readFileSync(clientPath, 'utf8');

/** 抹掉字符串、模板与注释，只留结构字符；MemoryGraph 内没有正则字面量。 */
function makeStripper() {
  let inBlock = false;
  let inTemplate = false;
  let quote = '';
  return (line) => {
    let out = '';
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];
      if (inBlock) {
        if (ch === '*' && next === '/') { inBlock = false; i += 1; }
        out += ' ';
        continue;
      }
      if (inTemplate) {
        if (ch === '\\') { i += 1; out += ' '; continue; }
        if (ch === '`') inTemplate = false;
        out += ' ';
        continue;
      }
      if (quote) {
        if (ch === '\\') { i += 1; out += ' '; continue; }
        if (ch === quote) quote = '';
        out += ' ';
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') { inBlock = true; i += 1; out += '  '; continue; }
      if (ch === '"' || ch === "'") { quote = ch; out += ' '; continue; }
      if (ch === '`') { inTemplate = true; out += ' '; continue; }
      out += ch;
    }
    return out;
  };
}

/**
 * 找到 MemoryGraph 的函数体，返回顶层 if-return 的绝对偏移和所有 hook 调用。
 * 顶层 = 直接在组件函数体里（深度 1），不管嵌在 startPan 这类内部函数里的早退。
 */
function scanHookOrder(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*const MemoryGraph\s*=\s*\(/.test(line));
  if (start < 0) throw new Error('client.js 里找不到 const MemoryGraph = (props) =>');
  const strip = makeStripper();
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  let depth = 0;
  let bodyOpen = false;
  let bodyEnd = lines.length - 1;
  const lineDepths = [];
  const codeLines = [];
  for (let i = start; i < lines.length; i += 1) {
    const code = strip(lines[i]);
    codeLines.push(code);
    lineDepths.push(depth);
    for (let c = 0; c < code.length; c += 1) {
      const ch = code[c];
      if (!bodyOpen) {
        if (ch !== '{') continue;
        bodyOpen = true;
        depth = 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    if (bodyOpen && depth === 0) break;
  }
  if (!bodyOpen) throw new Error('MemoryGraph 函数体没有找到起始花括号');

  const hooks = [];
  let firstTopIfReturn = null;
  for (let i = start; i <= bodyEnd; i += 1) {
    const code = codeLines[i - start];
    const atDepthOne = lineDepths[i - start] === 1;
    if (atDepthOne && /^\s*if\b/.test(code)) {
      // 从 if 开始找同一语句里的 return：块内 return 深度 >= 1，语句结束后不再算。
      let local = 1;
      for (let j = i; j <= bodyEnd; j += 1) {
        const part = codeLines[j - start];
        for (let c = 0; c < part.length; c += 1) {
          const ch = part[c];
          if (ch === '{') local += 1;
          else if (ch === '}') local -= 1;
          const rest = part.slice(c);
          const match = /^return\b/.exec(rest);
          if (match && local >= 1 && firstTopIfReturn === null) {
            firstTopIfReturn = lineOffsets[j] + c;
          }
        }
        if (j > i && local <= 1 && /^\s*\}/.test(part)) break;
        if (j > i && local <= 1 && part.includes(';')) break;
      }
    }
    const hookRe = /React\.use[A-Za-z]+/g;
    let hook = hookRe.exec(code);
    while (hook) {
      hooks.push({ name: hook[0], at: lineOffsets[i] + hook.index, line: i + 1 });
      hook = hookRe.exec(code);
    }
  }
  return { hooks, firstTopIfReturn, bodyEnd: bodyEnd + 1 };
}

// --- 静态断言 ---
const scanned = scanHookOrder(source);
assert.ok(scanned.hooks.length >= 8, `MemoryGraph 应该有不少 hook，实际只扫到 ${scanned.hooks.length} 个`);
if (scanned.firstTopIfReturn !== null) {
  const late = scanned.hooks.filter((hook) => hook.at > scanned.firstTopIfReturn);
  assert.deepEqual(
    late.map((hook) => `${hook.name}@${hook.line}`),
    [],
    'hook 出现在顶层 if-return 之后：空图渲染会少调 hook，有图渲染会多调',
  );
}

// 扫描器自检：坏样本必须报，好样本必须不报。
const badFixture = [
  'const MemoryGraph = (props) => {',
  '  const [a] = React.useState(1);',
  '  if (!props.records || props.records.length === 0) {',
  "    return h('div', null, '空');",
  '  }',
  '  const memo = React.useMemo(() => props.records.length, [props.records]);',
  '  return h(\'div\', null, memo, a);',
  '};',
].join('\n');
const badScan = scanHookOrder(badFixture);
assert.ok(badScan.firstTopIfReturn !== null, '自检失败：坏样本没识别出顶层 if-return');
assert.ok(badScan.hooks.some((hook) => hook.at > badScan.firstTopIfReturn), '自检失败：坏样本里的晚到 hook 没被识别');

const goodFixture = [
  'const MemoryGraph = (props) => {',
  '  const [a] = React.useState(1);',
  '  const memo = React.useMemo(() => props.records.length, [props.records]);',
  '  if (!props.records || props.records.length === 0) {',
  "    return h('div', null, '空');",
  '  }',
  '  return h(\'div\', null, memo, a);',
  '};',
].join('\n');
const goodScan = scanHookOrder(goodFixture);
assert.ok(goodScan.firstTopIfReturn !== null, '自检失败：好样本的顶层 if-return 应该被记录');
assert.deepEqual(goodScan.hooks.filter((hook) => hook.at > goodScan.firstTopIfReturn), [], '自检失败：好样本被误报');

// --- 运行时 hook 序列 ---
let plugin = null;
let helpers = null;
let reactImpl = null;
const makeNode = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const hookCalls = [];
const fakeReact = {
  createElement: makeNode,
  useRef: (value) => { hookCalls.push('useRef'); return { current: value }; },
  useState: (value) => { hookCalls.push('useState'); return [value, () => {}]; },
  useEffect: () => { hookCalls.push('useEffect'); },
  useMemo: (fn) => { hookCalls.push('useMemo'); return fn(); },
};
reactImpl = fakeReact;
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      plugin = definition.factory((name) => (name === 'react' ? reactImpl : null));
    },
  },
};
globalThis.__LITE_MEMORY_TEST__ = (value) => { helpers = value; };
await import(clientPath.href);
assert.ok(plugin && helpers, 'client 测试缝没挂上');
assert.equal(typeof helpers.MemoryGraph, 'function', 'MemoryGraph 没有导出');

const renderSequence = (props) => {
  hookCalls.length = 0;
  const tree = helpers.MemoryGraph(props);
  return { calls: [...hookCalls], tree };
};
const emptyRender = renderSequence({ records: [], primaryKind: 'memory', emptyText: '还没有记忆' });
assert.ok(emptyRender.calls.length > 0, '空图渲染没有调用任何 hook');
const fullRender = renderSequence({
  records: [{ id: 'mem_aaaaaaaa', title: 'A', tags: ['发布'], experimental: false, links: [] }],
  primaryKind: 'memory',
  total: 1,
});
assert.ok(fullRender.calls.length > 0, '有图渲染没有调用任何 hook');
assert.deepEqual(fullRender.calls, emptyRender.calls, '空图与有图的 hook 序列不一致，真实 React 会报 hook 数量变化');

// --- 真实 React：没安装就跳过，不能静默假装跑过 ---
const require = createRequire(import.meta.url);
let hasReact = true;
try {
  require.resolve('react');
  require.resolve('react-dom/server');
} catch {
  hasReact = false;
}
if (!hasReact) {
  console.log('graph-hooks.test.mjs: 未安装 react/react-dom，跳过真实挂载用例（仓库不允许新增依赖）；静态与假 React 用例已通过');
} else {
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  reactImpl = React;
  let realHelpers = null;
  globalThis.__LITE_MEMORY_TEST__ = (value) => { realHelpers = value; };
  await import(`${clientPath.href}?real-react`);
  assert.ok(realHelpers && realHelpers.MemoryGraph, '真实 React 重载 client 失败');
  const emptyHtml = renderToString(React.createElement(realHelpers.MemoryGraph, { records: [] }));
  assert.match(emptyHtml, /还没有记忆/);
  const fullHtml = renderToString(React.createElement(realHelpers.MemoryGraph, {
    records: [{ id: 'mem_aaaaaaaa', title: 'A', tags: ['发布'], experimental: false, links: [] }],
    total: 1,
  }));
  assert.ok(fullHtml.length > 0);
}

console.log('graph-hooks.test.mjs: hook 顺序检查通过');
