/**
 * 多平台 PostToolUse hook:agent 写/改文件后秒级刷新对应 artifact 的 hash。
 * 宪法第六条:观测 fail-open——任何失败只静默退出,绝不阻塞 agent。
 * 平台由 --platform=<id> 指定;stdin/项目根按平台归一(见 hook-input)。
 */
import { extractFilePath, hookPlatform, hookProjectDir, readStdinJson } from "./hook-input"

/** 刷新主逻辑;由 `workbench hook post --platform=X` 或独立入口调用 */
export async function refreshHook(_platform?: string) {
  const input = await readStdinJson()
  const filePath = extractFilePath(input)
  if (!filePath) return

  const { openWorkbench } = await import("../core/db")
  const { refreshArtifact, normalizeRelPath } = await import("../core/commands/artifact.commands")
  const ctx = openWorkbench(hookProjectDir())
  const rel = normalizeRelPath(ctx, filePath)

  // 精确路径命中,或命中某个目录级 code artifact 的前缀
  const exact = ctx.db.prepare("SELECT id FROM artifacts WHERE path = ?").get(rel) as { id: number } | undefined
  if (exact) {
    refreshArtifact(ctx, { id: exact.id }, "hook")
    return
  }
  const dirs = ctx.db.prepare("SELECT id, path FROM artifacts WHERE kind = 'code'").all() as { id: number; path: string }[]
  for (const d of dirs) {
    if (rel.startsWith(d.path + "/")) {
      refreshArtifact(ctx, { id: d.id }, "hook")
      return
    }
  }
}

// 独立入口(直接调用;编译打包后由 CLI 子命令调用)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("hook-refresh.ts")) {
  refreshHook(hookPlatform())
    .catch(() => {})
    .finally(() => process.exit(0))
}
