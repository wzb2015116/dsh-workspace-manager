// 入口契约：cordis loader 解析方式与 inject 声明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as mod from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, '..', 'src', 'index.js');

test('入口导出具名 apply(ctx, config)，不是 default', () => {
  assert.equal(typeof mod.apply, 'function', '必须导出具名 apply');
  assert.equal(mod.default, undefined, '不得提供 default 导出（loader 会取 default 导致 inject 丢失）');
});

test('loader 解析（exports = exports.default ?? exports）后 apply 与 inject 同时可达', () => {
  const plugin = mod.default ?? mod;
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(Array.isArray(plugin.inject), 'plugin.inject 必须是数组');
  assert.ok(plugin.inject.includes('workingDirectory'), 'inject 必须包含 workingDirectory');
});

test('源码层声明 inject=[workingDirectory]', async () => {
  const src = await readFile(ENTRY, 'utf8');
  assert.match(src, /export\s+const\s+inject\s*=\s*\[[^\]]*['"]workingDirectory['"]/);
});
