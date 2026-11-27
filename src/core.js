// 纯逻辑：会话 eligibility 判定、工作空间路径与标记路径命名。
// 只依赖 node:path 与注入的函数，无 DSH 依赖，便于单测。
import { join, dirname } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';

/** 顶层普通会话：非 seeded fork、无父会话、非 subagent。 */
export function isTopLevelSession(header) {
  return header.isSeeded !== true
    && header.parentSession === undefined
    && header.origin !== 'subagent';
}

/**
 * 是否应由本插件自动建工作空间。
 * header.cwd 缺失按默认根处理；存在则 realpath 后与默认根比较，不同视为用户指定。
 */
export async function isEligibleSession(header, defaultRoot, realpathFn) {
  if (!isTopLevelSession(header)) return false;
  if (header.cwd === undefined) return true;
  const cwd = await realpathFn(header.cwd);
  const root = await realpathFn(defaultRoot);
  return cwd === root;
}

/** 从 createdAt 派生本地时间目录：<root>/<dir>/<YYYY-MM-DD>/<HH-MM-SS>。 */
export function workspacePathOf(root, workspacesDirName, createdAtMs) {
  const d = new Date(createdAtMs);
  const p2 = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  return join(root, workspacesDirName, date, time);
}

/** 标记文件路径：<root>/.dsh-workspaces/<sessionId>.json。 */
export function markerPathOf(root, sessionId) {
  return join(root, '.dsh-workspaces', `${sessionId}.json`);
}

/** 读标记；不存在 / 损坏 JSON / 任意异常均返回 null（不抛）。 */
export async function readMarker(root, sessionId) {
  try {
    const raw = await readFile(markerPathOf(root, sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 原子写标记：写临时文件 → 覆盖目标 → 清临时文件，不留半写状态。 */
export async function writeMarkerAtomic(root, sessionId, data) {
  const dir = join(root, '.dsh-workspaces');
  await mkdir(dir, { recursive: true });
  const target = markerPathOf(root, sessionId);
  const tmp = `${target}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  try {
    await rm(target, { force: true });
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * 在给定路径建工作空间目录；若已被占用则追加 ' (2)'、' (3)' …
 * mkdirFn/statFn 注入便于单测；stat 确认后返回最终路径。
 */
export async function createWorkspaceDir(workspacePath, mkdirFn = mkdir, statFn = stat) {
  // 父目录递归建（可安全重复）；叶子必须非递归建，才能靠 EEXIST 做独占声明。
  await mkdirFn(dirname(workspacePath), { recursive: true });
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? workspacePath : `${workspacePath} (${n + 1})`;
    try {
      // 非递归 mkdir：已存在必抛 EEXIST，不再静默成功。
      await mkdirFn(candidate);
      await statFn(candidate);
      return candidate;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
}
