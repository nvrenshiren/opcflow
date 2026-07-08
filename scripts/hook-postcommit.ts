/** git post-commit hook 入口:全量对账 + 孤儿提交检测(observe)+ 事件导出,fail-open */
async function main() {
  const { openWorkbench } = await import("../core/db")
  const { scanArtifacts } = await import("../core/commands/scan.command")
  const { syncArtifacts, detectOrphanCommit } = await import("../core/commands/sync.command")
  const { exportEventLog } = await import("../core/commands/retro.command")
  const ctx = openWorkbench(process.cwd())
  // 先全量 scan 登记新产物(docs + codeRoots 目录级 + prisma 文件级),再对账——
  // 否则新模块的代码/prisma 只有 init 或手动 `cli scan` 才进库,提交后不会自动登记。
  scanArtifacts(ctx, "post-commit")
  syncArtifacts(ctx, "post-commit")
  detectOrphanCommit(ctx)
  // M8 数据单点缓解:events/feedback 随每次提交导出 jsonl,下次提交自然入 git
  exportEventLog(ctx)
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))

export {}
