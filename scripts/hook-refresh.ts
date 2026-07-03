/**
 * Claude Code PostToolUse hook:agent 写/改文件后秒级刷新对应 artifact 的 hash。
 * 宪法第六条:观测 fail-open——任何失败只静默退出,绝不阻塞 agent。
 */
async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
    tool_input?: { file_path?: string }
  }
  const filePath = input.tool_input?.file_path
  if (!filePath) return

  const { openWorkbench } = await import("../core/db")
  const { refreshArtifact, normalizeRelPath } = await import("../core/commands/artifact.commands")
  const ctx = openWorkbench(process.env.CLAUDE_PROJECT_DIR)
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

main()
  .catch(() => {})
  .finally(() => process.exit(0))

export {}
