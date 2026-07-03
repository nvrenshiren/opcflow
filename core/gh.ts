import { execFileSync } from "node:child_process"
import type { Ctx } from "./types"

/** 任务完成回写:external_ref=gh#N → 关闭 issue(fail-open) */
export function closeLinkedIssue(ctx: Ctx, externalRef: string, taskId: number): boolean {
  const match = externalRef.match(/^gh#(\d+)$/)
  if (!match) return false
  try {
    execFileSync("gh", ["issue", "close", match[1], "--comment", `已处理,关联任务 #${taskId}`], {
      cwd: ctx.root,
      stdio: ["ignore", "pipe", "ignore"]
    })
    return true
  } catch {
    return false
  }
}
