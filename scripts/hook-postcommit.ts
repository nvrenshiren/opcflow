/** git post-commit hook 入口:全量对账 + 孤儿提交检测(observe),fail-open */
async function main() {
  const { openWorkbench } = await import("../core/db")
  const { syncArtifacts, detectOrphanCommit } = await import("../core/commands/sync.command")
  const ctx = openWorkbench(process.cwd())
  syncArtifacts(ctx, "post-commit")
  detectOrphanCommit(ctx)
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))

export {}
