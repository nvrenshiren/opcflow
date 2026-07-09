import { execFileSync } from "node:child_process"
import type { Ctx } from "../types"
import { createTask } from "./task.commands"

interface GhIssue {
  number: number
  title: string
  url: string
  labels: { name: string }[]
}

export interface IntakeSummary {
  fetched: number
  created: { issue: number; taskId: number; lane: "hotfix" | "pm" }[]
  skipped: number
}

/**
 * issue intake 三分诊(判据即帮助文本,默认保守):
 * - label 含 bug          → hotfix 任务(developer,快车道)
 * - 其余(含无 label/模糊)  → PM 分析任务(标准道入口,保守默认——分诊错成本最低的方向)
 * 去重:external_ref = "gh#<number>";任务完成时自动回写关闭 issue(fail-open)。
 */
export function intakeIssues(ctx: Ctx): IntakeSummary {
  const summary: IntakeSummary = { fetched: 0, created: [], skipped: 0 }

  let issues: GhIssue[] = []
  try {
    const out = execFileSync("gh", ["issue", "list", "--state", "open", "--json", "number,title,url,labels", "--limit", "50"], {
      cwd: ctx.root,
      stdio: ["ignore", "pipe", "ignore"]
    }).toString()
    issues = JSON.parse(out) as GhIssue[]
  } catch {
    throw new Error("gh CLI 不可用或非 GitHub 仓库(intake 依赖 gh issue list)")
  }
  summary.fetched = issues.length

  const exists = ctx.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE external_ref = ?")
  for (const issue of issues) {
    const ref = `gh#${issue.number}`
    if ((exists.get(ref) as { c: number }).c > 0) {
      summary.skipped++
      continue
    }
    const isBug = issue.labels.some(l => l.name.toLowerCase() === "bug")
    // 分诊角色可配(config.intake),缺省保持:bug→developer 快车道、其余→PM 标准道
    const bugRole = ctx.config.intake?.bugRole ?? "developer"
    const defaultRole = ctx.config.intake?.defaultRole ?? "product-manager"
    const id = createTask(ctx, {
      role: isBug ? bugRole : defaultRole,
      endpoint: null,
      type: isBug ? "hotfix" : "build",
      assignee: isBug ? bugRole : defaultRole,
      creator: "intake",
      content: `[gh#${issue.number}] ${issue.title}\n${issue.url}`,
      externalRef: ref
    })
    summary.created.push({ issue: issue.number, taskId: id, lane: isBug ? "hotfix" : "pm" })
  }
  return summary
}
