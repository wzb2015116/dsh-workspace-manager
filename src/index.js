// 工作空间管理插件：agent/created 分流——startup 建空间并切 cwd，resume 从标记恢复。
// 任何异常都在 handler 内吞掉并 warn，绝不冒泡（agent/created 是 serial awaited）。
export const inject = ['workingDirectory'];
import { realpath, stat, mkdir, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  isTopLevelSession,
  isEligibleSession,
  workspacePathOf,
  markerPathOf,
  readMarker,
  writeMarkerAtomic,
  createWorkspaceDir,
} from './core.js';

/** realpath 包装：路径不存在/读失败时返回原字符串（保守判定，不误建）。 */
function safeRealpath(p) {
  return realpath(p).catch(() => p);
}

/** 目录是否仍存在且为目录。 */
async function dirExists(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export function apply(ctx, config = {}) {
  const defaultRoot = config.defaultRoot ?? process.cwd();
  const workspacesDirName = config.workspacesDirName ?? 'workspaces';
  const warn = (message) => ctx.logger?.warn?.(`[workspace-manager] ${message}`);
  const trace = async (message) => {
    try {
      const dir = join(defaultRoot, '.dsh-workspaces');
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, '_trace.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    } catch {}
  };

  ctx.on('agent/created', async ({ agent, source, signal }) => {
    try {
      if (signal?.aborted) return;
      const session = agent?.session;
      if (session === undefined) return;
      const header = session.header ?? {};
      if (!isTopLevelSession(header)) return;

      if (source === 'startup') {
        await trace(`startup enter session=${session.id} headerCwd=${String(header.cwd)} defaultRoot=${defaultRoot}`);
        const eligible = await isEligibleSession(header, defaultRoot, safeRealpath);
        await trace(`eligibility=${eligible} session=${session.id}`);
        if (!eligible) return;
        // 幂等：标记存在且目录仍在 → 只 set 到记录的 workspace，不重建。
        const marker = await readMarker(defaultRoot, session.id);
        if (marker?.workspace !== undefined && await dirExists(marker.workspace)) {
          await trace(`before set(marker) session=${session.id} path=${marker.workspace}`);
          await ctx.workingDirectory.set(agent, marker.workspace);
          await trace(`after set(marker) session=${session.id}`);
          return;
        }
        const createdAt = typeof header.createdAt === 'number' ? header.createdAt : Date.now();
        const target = await createWorkspaceDir(workspacePathOf(defaultRoot, workspacesDirName, createdAt));
        await trace(`before set(target) session=${session.id} path=${target} hasWD=${ctx.workingDirectory !== undefined}`);
        await ctx.workingDirectory.set(agent, target);
        await trace(`after set(target) session=${session.id}`);
        await writeMarkerAtomic(defaultRoot, session.id, {
          sessionId: session.id,
          workspace: target,
          createdAt,
        });
        await trace(`marker written session=${session.id}`);
        return;
      }

      if (source === 'resume') {
        const marker = await readMarker(defaultRoot, session.id);
        if (marker?.workspace !== undefined && await dirExists(marker.workspace)) {
          await ctx.workingDirectory.set(agent, marker.workspace);
        }
        // clear / compact / 其它 source：不处理。
      }
    } catch (error) {
      const message = `agent/created(${source}) 处理失败：${String(error)}` + (error?.stack ? `\n${error.stack}` : '');
      warn(message);
      // no-throw 守卫会吞掉错误，额外落盘便于诊断（best-effort）。
      try {
        const dir = join(defaultRoot, '.dsh-workspaces');
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, '_errors.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
      } catch {}
    }
  });
}
