import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

test('发布包带齐入口依赖，解压后能 import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-pack-'));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }))[0];
  execFileSync('tar', ['-xzf', path.join(dir, packed.filename), '-C', dir]);
  const pkgRoot = path.join(dir, 'package');
  assert.ok(fs.existsSync(path.join(pkgRoot, 'scheduler.js')), '调度器要进发布包');
  const fails = [];
  for (const file of fs.readdirSync(pkgRoot).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(pkgRoot, file), 'utf8');
    for (const hit of source.matchAll(/from\s+'(\.\/[^']+)'/g)) {
      if (!fs.existsSync(path.join(pkgRoot, hit[1]))) fails.push(`${file} → ${hit[1]}`);
    }
  }
  assert.deepEqual(fails, [], '包内相对依赖必须齐全');
  const entry = pathToFileURL(path.join(pkgRoot, 'index.js')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import('${entry}');`], {
    cwd: pkgRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  });
});
