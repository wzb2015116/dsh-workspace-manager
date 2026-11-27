# dsh-workspace-manager

为 DeepSeek Harness（DSH）的每个新会话，按日期时间自动创建独立工作空间，并把会话工作目录切进去；恢复会话时切回原目录。**插件不删除任何文件** —— 删会话只删会话记录，工作空间和里面的文件永久保留。

> A DSH bundle that gives every new session its own date-stamped workspace directory and restores it on resume. It never deletes anything.

## 它解决什么

默认情况下，同一台机器上的所有会话共享一个工作目录，不同任务的产物混在一起，越用越乱，删会话时还容易连产物一起丢。

装上本插件后，新建会话的工作目录自动变成：

```
<defaultRoot>/workspaces/<YYYY-MM-DD>/<HH-MM-SS>/
```

同一秒并发创建多个会话时，后到的目录追加 ` (2)`、` (3)`，靠非递归 `mkdir` 的 `EEXIST` 做独占声明，不会互相覆盖。

## 行为

| 场景 | 处理 |
|---|---|
| 新建顶层会话（`agent/created` + `source === 'startup'`） | 建目录 → `workingDirectory.set` → 写标记 |
| 恢复会话（`source === 'resume'`） | 读标记 → 目录仍在则 `set` 回原目录 |
| 标记已存在且目录仍在（重复 startup） | 只 `set`，不重建（幂等） |
| 用户自己指定了工作区（`header.cwd` ≠ 默认根） | 不建、不切、不标记 |
| 子会话 / fork / subagent | 不建、不切、不标记 |
| `signal.aborted` | 不处理 |
| `workingDirectory.set` 抛错 | 记 warn + 落盘 `_errors.log`，不写脏标记，handler 不抛出 |

`agent/created` 是 serial awaited 事件，所以 handler 内部吞掉所有异常，绝不让插件故障拖垮会话创建。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: workspace-manager
      name: '@local/dsh-workspace-manager'
      config:
        defaultRoot: 'D:\harness work'
        workspacesDirName: workspaces
```

| 键 | 默认 | 说明 |
|---|---|---|
| `defaultRoot` | `process.cwd()` | 默认工作区根。**必须与宿主 `working-directory.defaultDirectory` 一致**，否则 eligibility 判定为「用户指定目录」，插件静默不生效 |
| `workspacesDirName` | `workspaces` | 工作空间父目录名 |

## 安装

从本仓库安装（任选其一）：

```bash
# 1) 本地目录 link（开发用）
dsh plugin add link:/path/to/dsh-workspace-manager

# 2) 直接从 GitHub 装
dsh plugin add github:wzb2015116/dsh-workspace-manager
```

或在 GUI 里 Plugins → Add plugin 选择本目录。装完**重启宿主**（Node 半边不走热重载）。

安装后确认 profile 的 `package.json` 里 `dsh.profile.bundles` 已包含本插件。

## 标记文件

`<defaultRoot>/.dsh-workspaces/<sessionId>.json`，是恢复 cwd 的唯一真源：

```json
{
  "sessionId": "session-3e484212-...",
  "workspace": "D:\\harness work\\workspaces\\2026-11-27\\18-14-07",
  "createdAt": 1795000000000
}
```

写入是原子的（写 `.tmp.<pid>` → `rename`），不会留下半写状态；读到损坏 JSON 一律当 `null` 处理，不抛异常。

诊断日志（仅出错/追踪时产生，可随时删除）：

- `.dsh-workspaces/_errors.log` —— handler 内被吞掉的异常全文
- `.dsh-workspaces/_trace.log` —— startup 关键步骤（进入 / eligibility / set 前后 / 标记写入）

## 目录结构

```
src/core.js      纯逻辑：eligibility、路径命名、标记读写、目录创建（无 DSH 依赖，可单测）
src/index.js     入口：导出 apply(ctx, config) + inject=['workingDirectory']，挂 agent/created
tests/*.test.mjs node:test 用例
cordis.patch.yml bundle patch
```

## 开发

```bash
node --check src/index.js
node --test "tests/*.test.mjs"
# 或
npm test
```

要求 Node ≥ 20（使用内置 `node:test`，无外部依赖）。

### 两个必须遵守的坑

1. **入口必须导出具名 `apply`，不要 `export default`。**
   `cordis-plugin-loader` 会做 `exports = exports.default ?? exports`；一旦给了 default，loader 拿到的是裸函数，模块级的 `export const inject` 就读不到，`ctx.workingDirectory` 变成 `undefined`，`set` 抛错并被 no-throw 守卫吞掉 —— 表现是「目录建了但 cwd 没切」。`tests/entry.test.mjs` 锁死了这条。

2. **`inject` 必须显式声明 `workingDirectory`。**
   Cordis 的服务注入是声明式的，没声明就拿不到 `ctx.workingDirectory`。

## License

MIT
