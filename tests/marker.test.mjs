// core 落盘逻辑：标记读写与工作空间目录创建。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, readFile, stat, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMarker, writeMarkerAtomic, createWorkspaceDir } from '../src/core.js';

const tempRoot = () => mkdtemp(join(tmpdir(), 'dsh-ws-'));

test('writeMarkerAtomic → readMarker 往返一致，且不留 .tmp 残留', async () => {
  const root = await tempRoot();
  try {
    const data = { sessionId: 'session-x', workspace: join(root, 'ws'), createdAt: 123 };
    await writeMarkerAtomic(root, 'session-x', data);
    assert.deepEqual(await readMarker(root, 'session-x'), data);
    const files = await readdir(join(root, '.dsh-workspaces'));
    assert.equal(files.some((f) => f.includes('.tmp')), false, '不应残留临时文件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readMarker：缺失或损坏的 JSON 都返回 null，不抛异常', async () => {
  const root = await tempRoot();
  try {
    assert.equal(await readMarker(root, 'missing'), null);
    await mkdir(join(root, '.dsh-workspaces'), { recursive: true });
    await writeFile(join(root, '.dsh-workspaces', 'broken.json'), '{bad');
    assert.equal(await readMarker(root, 'broken'), null);
    await writeFile(join(root, '.dsh-workspaces', 'null.json'), 'null');
    assert.equal(await readMarker(root, 'null'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeMarkerAtomic 覆盖旧标记，且内容为新值', async () => {
  const root = await tempRoot();
  try {
    await writeMarkerAtomic(root, 's', { workspace: 'old' });
    await writeMarkerAtomic(root, 's', { workspace: 'new' });
    assert.equal((await readMarker(root, 's')).workspace, 'new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createWorkspaceDir：目标空闲时建目录并返回原路径', async () => {
  const root = await tempRoot();
  try {
    const target = join(root, 'spaces', '2026-11-27', '17-17-00');
    const got = await createWorkspaceDir(target);
    assert.equal(got.replace(/\\/g, '/'), target.replace(/\\/g, '/'));
    assert.equal((await stat(got)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createWorkspaceDir：目标已占用时追加 (2) 且不覆盖原目录内容', async () => {
  const root = await tempRoot();
  try {
    const target = join(root, 'spaces', '2026-11-27', '17-17-00');
    const first = await createWorkspaceDir(target);
    await writeFile(join(first, 'keep.txt'), 'keep');
    const second = await createWorkspaceDir(target);
    assert.equal(second.replace(/\\/g, '/'), `${target} (2)`.replace(/\\/g, '/'));
    assert.equal(await readFile(join(first, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createWorkspaceDir：同路径并发调用得到互不相同的目录（EEXIST 独占生效）', async () => {
  const root = await tempRoot();
  try {
    const target = join(root, 'spaces', '2026-11-27', '17-17-00');
    const results = await Promise.all(Array.from({ length: 8 }, () => createWorkspaceDir(target)));
    assert.equal(new Set(results).size, 8, `并发 8 次应得到 8 个唯一路径，实际 ${new Set(results).size}`);
    for (const p of results) assert.equal((await stat(p)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
