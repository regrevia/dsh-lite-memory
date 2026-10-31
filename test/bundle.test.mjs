/**
 * 包体基线（棘轮）：client.js 只能变小，不能悄悄变大。
 * 宿主用 window.__ModuleLoader__.load() 直接加载这一个文件，没有打包器，
 * 所以「代码分割」不是可选项；体积只能靠就地替换旧实现、删掉常驻分支来压。
 * 40 KiB 是目标门；当前实测高于它，差额作为明确的债记在 baseline 里，不允许模糊。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(root, 'client.js');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'bench', 'bundle-baseline.json'), 'utf8'));
const raw = fs.readFileSync(file);
const rawBytes = raw.length;
const gzipBytes = zlib.gzipSync(raw, { level: 9 }).length;
const TARGET = 40 * 1024;

console.log(`client.js raw ${rawBytes} B, gzip -9 ${gzipBytes} B, 目标 ${TARGET} B`);

/** 只许变小：超基线就是回归，要么改回去，要么显式改基线并在 PR 里说明为什么。 */
assert.ok(rawBytes <= baseline.rawBytes, `client.js 原始体积 ${rawBytes} B 超过基线 ${baseline.rawBytes} B`);
assert.ok(gzipBytes <= baseline.gzipBytes, `client.js gzip 体积 ${gzipBytes} B 超过基线 ${baseline.gzipBytes} B`);
/** 基线本身不能高于目标：目标门不是装饰，改基线时要正视差距。 */
assert.ok(baseline.rawBytes >= rawBytes, '基线必须覆盖当前实现');
/** 记录差额，不隐藏。 */
const gap = Math.max(0, gzipBytes - TARGET);
assert.equal(baseline.targetGap, gap, `40 KiB 目标差额变了：基线记 ${baseline.targetGap} B，实测 ${gap} B，改基线要同步改这个数`);
if (gap > 0) console.log(`40 KiB 目标还差 ${gap} B：已记为待还的债，不是达标`);

/** 只有一个渲染实现：改宫殿要就地替换，不许并列留第二套。 */
const source = raw.toString('utf8');
const palaceImpls = source.match(/(?:function\s+MemoryPalace\b|const\s+MemoryPalace\s*=)/g) || [];
assert.equal(palaceImpls.length, 1, '宫殿只保留一套渲染实现');
console.log('bundle.test.mjs: passed');
