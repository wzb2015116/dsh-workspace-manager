// 入口行为：agent/created 分流（startup 建空间并切 cwd，resume 从标记恢复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.js';
import { readMarker, writeMarkerAtomic } from '../src/core.js';

const CREATED_AT = Date.UTC(2026, 10, 27, 9, 17, 0);

function harness(defaultRoot) {
  const state = { handler: null, sets: [], warns: [] };
  const ctx = {
    on: (name, fn) => {
      if (name === 'agent/created') state.handler = fn;
    },
    workingDirectory: {
      set: async (agent, path) => {
        state.sets.push({ agent, path });
      },
    },
    logger: { warn: (m) => state.warns.push(m) },
  };
  apply(ctx, { defaultRoot, workspacesDirName: 'workspaces' });
  return state;
}

const agentOf = (header, id = 'session-test') => ({ session: { header, id } });

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ws-hook-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('startup 顶层会话：建目录、切 cwd、写标记', async () => {
  await withRoot(async (root) => {
    const s = harness(root);
    await s.handler({ agent: agentOf({ cwd: root, isSeeded: false }, 'session-startup'), source: 'startup' });
    assert.equal(s.sets.length, 1, 'startup 顶层应 set 一次');
    assert.ok(s.sets[0].path.includes('workspaces'), 'cwd 应切到 workspaces 下');
    assert.equal((await stat(s.sets[0].path)).isDirectory(), true, '目录应真实存在');
    const marker = await readMarker(root, 'session-startup');
    assert.equal(marker.workspace, s.sets[0].path, '标记应记录实际 workspace');
    assert.equal(marker.sessionId, 'session-startup');
  });
});

test('startup 用户指定工作区：不建、不切、不标记', async () => {
  await withRoot(async (root) => {
    const s = harness(root);
    await s.handler({ agent: agentOf({ cwd: join(root, 'elsewhere'), isSeeded: false }, 's-user'), source: 'startup' });
    assert.equal(s.sets.length, 0, '用户指定工作区不应切 cwd');
    assert.equal(await readMarker(root, 's-user'), null, '不应写标记');
  });
});

test('startup 子会话 / fork / subagent：一律不处理', async () => {
  await withRoot(async (root) => {
    const s = harness(root);
    await s.handler({ agent: agentOf({ cwd: root, origin: 'subagent' }, 's-sub'), source: 'startup' });
    await s.handler({ agent: agentOf({ cwd: root, isSeeded: true }, 's-fork'), source: 'startup' });
    await s.handler({ agent: agentOf({ cwd: root, parentSession: 'p' }, 's-child'), source: 'startup' });
    assert.equal(s.sets.length, 0);
    assert.equal(await readMarker(root, 's-sub'), null);
    assert.equal(await readMarker(root, 's-fork'), null);
    assert.equal(await readMarker(root, 's-child'), null);
  });
});

test('startup 幂等：标记存在且目录仍在 → 复用原 workspace，不新建', async () => {
  await withRoot(async (root) => {
    const ws = join(root, 'workspaces', '2026-11-26', '10-00-00');
    await mkdir(ws, { recursive: true });
    await writeMarkerAtomic(root, 's-idem', { sessionId: 's-idem', workspace: ws, createdAt: CREATED_AT });
    const s = harness(root);
    await s.handler({ agent: agentOf({ cwd: root, isSeeded: false }, 's-idem'), source: 'startup' });
    assert.equal(s.sets.length, 1);
    assert.equal(s.sets[0].path.replace(/\\/g, '/'), ws.replace(/\\/g, '/'));
  });
});

test('resume：标记存在 → 切回记录的 workspace，不新建', async () => {
  await withRoot(async (root) => {
    const ws = join(root, 'workspaces', '2026-11-26', '10-00-00');
    await mkdir(ws, { recursive: true });
    await writeMarkerAtomic(root, 's-resume', { sessionId: 's-resume', workspace: ws, createdAt: CREATED_AT });
    const s = harness(root);
    await s.handler({ agent: agentOf({ cwd: root, isSeeded: false }, 's-resume'), source: 'resume' });
    assert.equal(s.sets.length, 1);
    assert.equal(s.sets[0].path.replace(/\\/g, '/'), ws.replace(/\\/g, '/'));
  });
});

test('resume：无标记或目录已消失 → 不动 cwd', async () => {
  await withRoot(async (root) => {
    const s = harness(root);
    await s.handler({ agent: agentOf({ cwd: root, isSeeded: false }, 's-nomarker'), source: 'resume' });
    assert.equal(s.sets.length, 0, '无标记不切');

    const gone = join(root, 'workspaces', '2026-11-26', '11-00-00');
    await writeMarkerAtomic(root, 's-gone', { sessionId: 's-gone', workspace: gone, createdAt: CREATED_AT });
    await s.handler({ agent: agentOf({ cwd: root, isSeeded: false }, 's-gone'), source: 'resume' });
    assert.equal(s.sets.length, 0, '目录不存在不切');
  });
});

test('workingDirectory.set 抛错：handler 不 reject、记 warn、不写脏标记', async () => {
  await withRoot(async (root) => {
    const s = harness(root);
    assert.equal(typeof s.handler, 'function', '基础 harness 已注册 handler');
    // 用 set 抛错的 ctx 单独 apply 一份
    const state = { handler: null, warns: [] };
    apply(
      {
        on: (n, fn) => {
          if (n === 'agent/created') state.handler = fn;
        },
        workingDirectory: {
          set: async () => {
            throw new Error('set boom');
          },
        },
        logger: { warn: (m) => state.warns.push(m) },
      },
      { defaultRoot: root, workspacesDirName: 'workspaces' },
    );
    let threw = false;
    try {
      await state.handler({ agent: agentOf({ cwd: root, isSeeded: false }, 's-fail'), source: 'startup' });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'handler 不得抛出');
    assert.ok(state.warns.length >= 1, '应记录 warn');
    assert.equal(await readMarker(root, 's-fail'), null, 'set 失败不得写标记');
  });
});

test('signal 已中止：不处理', async () => {
  await withRoot(async (root) => {
    const s = harness(root);
    await s.handler({
      agent: agentOf({ cwd: root, isSeeded: false }, 's-abort'),
      source: 'startup',
      signal: { aborted: true },
    });
    assert.equal(s.sets.length, 0);
  });
});

test('session 缺失：不抛异常、不处理', async () => {
  await withRoot(async (root) => {
    const s = harness(root);
    await s.handler({ agent: {}, source: 'startup' });
    assert.equal(s.sets.length, 0);
  });
});

test('诊断：set 失败把异常落盘到 .dsh-workspaces/_errors.log', async () => {
  await withRoot(async (root) => {
    const state = { handler: null };
    apply(
      {
        on: (n, fn) => {
          if (n === 'agent/created') state.handler = fn;
        },
        workingDirectory: {
          set: async () => {
            throw new Error('SET_BOOM_DIAG');
          },
        },
        logger: { warn: () => {} },
      },
      { defaultRoot: root, workspacesDirName: 'workspaces' },
    );
    await state.handler({ agent: agentOf({ cwd: root, isSeeded: false }, 's-diag'), source: 'startup' });
    const log = await readFile(join(root, '.dsh-workspaces', '_errors.log'), 'utf8');
    assert.match(log, /SET_BOOM_DIAG/);
  });
});
