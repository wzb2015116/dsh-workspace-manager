// core 纯逻辑：顶层判定、eligibility、路径命名。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTopLevelSession,
  isEligibleSession,
  workspacePathOf,
  markerPathOf,
} from '../src/core.js';

test('isTopLevelSession：普通会话为真，fork / 子会话 / subagent 为假', () => {
  assert.equal(isTopLevelSession({ isSeeded: false }), true);
  assert.equal(isTopLevelSession({}), true);
  assert.equal(isTopLevelSession({ isSeeded: true }), false);
  assert.equal(isTopLevelSession({ parentSession: 'session-x' }), false);
  assert.equal(isTopLevelSession({ origin: 'subagent' }), false);
});

test('isEligibleSession：默认根参与，用户指定目录不参与', async () => {
  const identity = (p) => p;
  const ROOT = '/root';
  assert.equal(await isEligibleSession({ cwd: ROOT, isSeeded: false }, ROOT, identity), true);
  assert.equal(await isEligibleSession({ isSeeded: false }, ROOT, identity), true, 'cwd 缺失按默认根处理');
  assert.equal(await isEligibleSession({ cwd: '/other/project', isSeeded: false }, ROOT, identity), false);
  assert.equal(await isEligibleSession({ cwd: ROOT, isSeeded: true }, ROOT, identity), false, 'fork 不参与');
  assert.equal(await isEligibleSession({ cwd: ROOT, parentSession: 'p' }, ROOT, identity), false, '子会话不参与');
});

test('isEligibleSession：await 异步 realpathFn，不把 Promise 当路径比较', async () => {
  const asyncIdentity = async (p) => p;
  assert.equal(await isEligibleSession({ cwd: '/root', isSeeded: false }, '/root', asyncIdentity), true);
  assert.equal(await isEligibleSession({ cwd: '/other', isSeeded: false }, '/root', asyncIdentity), false);
});

test('isEligibleSession：realpath 归一化后比较（符号链接/大小写差异不误判）', async () => {
  const fake = async (p) => (p === '/root/' ? '/root' : p);
  assert.equal(await isEligibleSession({ cwd: '/root/', isSeeded: false }, '/root', fake), true);
});

test('workspacePathOf：<root>/<dir>/<YYYY-MM-DD>/<HH-MM-SS>（本地时间）', () => {
  const ts = Date.UTC(2026, 10, 27, 9, 17, 0);
  const got = workspacePathOf('/root', 'workspaces', ts);
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  const expected = [
    '/root',
    'workspaces',
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`,
  ].join('/');
  assert.equal(got.replace(/\\/g, '/'), expected);
  assert.match(got, /\d{4}-\d{2}-\d{2}[\\/]\d{2}-\d{2}-\d{2}$/, '叶子目录形如 17-17-00');
});

test('markerPathOf：<root>/.dsh-workspaces/<sessionId>.json', () => {
  const got = markerPathOf('/root', 'session-abc');
  assert.equal(got.replace(/\\/g, '/'), '/root/.dsh-workspaces/session-abc.json');
});
