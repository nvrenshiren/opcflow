/** git post-commit hook 入口:全量对账 + 孤儿提交检测(observe)+ 事件导出,fail-open */
async function main() {
  const { openWorkbench } = await import("../core/db")
  const { syncArtifacts, detectOrphanCommit } = await import("../core/commands/sync.command")
  const { exportEventLog } = await import("../core/commands/retro.command")
  const ctx = openWorkbench(process.cwd())
  syncArtifacts(ctx, "post-commit")
  detectOrphanCommit(ctx)
  // M8 数据单点缓解:events/feedback 随每次提交导出 jsonl,下次提交自然入 git
  exportEventLog(ctx)
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))

export {}
