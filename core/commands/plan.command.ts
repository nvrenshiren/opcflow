import { existsSync } from "node:fs"
import { join } from "node:path"
import { reviewStatus } from "../derive"
import { logEvent } from "../events"
import { normalizeModule } from "../kind"
import { getRoleRegistry } from "../roles"
import type { ArtifactRow, Ctx, Role, TaskType } from "../types"
import { createTask } from "./task.commands"

export interface PlanSummary {
  created: { id: number; role: Role; endpoint: string | null; page: string | null; type: TaskType }[]
  skipped: number
  cancelled: number
  warnings: string[]
}

interface DesiredTask {
  role: Role
  endpoint: string | null
  page: string | null
  type: TaskType
  assignee: string
  content: string
}

/**
 * plan 派发(纯函数,幂等):
 * - 真相源 = 已登记的 page-prd 产物(不解析 frontmatter,产物即事实)
 * - 每个已存在的等价任务(坐标+角色+类型,状态非 cancelled)跳过
 * - cancel 语义:PRD 中已删除的页面,其 pending 的 build/qa 任务自动取消
 * - 双契约与 flow/module-prd 审批按 approvalMode 出警告(warn)或阻断(enforce)
 */
export function planModule(ctx: Ctx, moduleRaw: string, creator = "product-manager"): PlanSummary {
  const module = normalizeModule(moduleRaw, ctx.config)!
  const summary: PlanSummary = { created: [], skipped: 0, cancelled: 0, warnings: [] }

  const artifacts = ctx.db.prepare("SELECT * FROM artifacts WHERE module IS ? OR module IS NULL").all(module) as ArtifactRow[]
  const byKind = (kind: string) => artifacts.filter(a => a.kind === kind && a.module === module)
  const projectLevel = (kind: string) => artifacts.filter(a => a.kind === kind && a.module === null)

  const modulePrd = byKind("module-prd")
  if (modulePrd.length === 0) {
    throw new Error(`[前置条件] 模块 ${module} 没有登记 module-prd,PM 先产出并登记后才能派发`)
  }

  // 双契约 + 逐层审批检查
  const trustChecks: { desc: string; rows: ArtifactRow[] }[] = [
    { desc: "技术基线(baseline)", rows: projectLevel("baseline") },
    { desc: "项目全景(project)", rows: projectLevel("project") },
    { desc: `flow(${module})`, rows: byKind("flow") },
    { desc: `模块 PRD(${module})`, rows: modulePrd }
  ]
  for (const check of trustChecks) {
    const ok = check.rows.some(r => reviewStatus(r) === "approved")
    if (ok) continue
    const msg = `[信任警告] ${check.desc} 未达 approved`
    if (ctx.config.gates.approvalMode === "enforce") throw new Error(`[前置条件] ${msg}`)
    summary.warnings.push(msg)
  }

  // 期望任务集(真相源 = 已登记且仍在磁盘的 page-prd:文件删除后行不删、只有 tombstone 事件,
  // 若只看行存在,已删页面会永远派发/取消不掉 —— 以磁盘存在性收敛)
  const pagePrds = byKind("page-prd").filter(a => a.endpoint && a.page && existsSync(join(ctx.root, a.path)))
  const endpoints = [...new Set(pagePrds.map(a => a.endpoint!))]

  // 派发拓扑由角色注册表 dispatch 物化(按 pipeline 顺序;不在 pipeline 的角色天然不派)——
  // 默认注册表逐字节编码旧手写数组;自定义角色纯 config 即进流水线
  const registry = getRoleRegistry(ctx.config)
  const interp = (tpl: string, v: { module: string; endpoint?: string | null; page?: string | null }) =>
    tpl.replaceAll("{module}", v.module).replaceAll("{endpoint}", v.endpoint ?? "").replaceAll("{page}", v.page ?? "")

  const desired: DesiredTask[] = []
  for (const role of ctx.config.pipeline) {
    for (const d of registry[role]?.dispatch ?? []) {
      if (d.at === "module") {
        desired.push({ role, endpoint: d.endpoint ?? null, page: null, type: d.type ?? "build", assignee: role, content: interp(d.content, { module }) })
      } else if (d.at === "endpoint") {
        for (const endpoint of endpoints) {
          if (d.ifMissingKind && artifacts.some(a => a.kind === d.ifMissingKind && a.endpoint === endpoint)) continue
          desired.push({ role, endpoint, page: null, type: d.type ?? "build", assignee: role, content: interp(d.content, { module, endpoint }) })
        }
      } else {
        for (const prd of pagePrds) {
          desired.push({ role, endpoint: prd.endpoint, page: prd.page, type: d.type ?? "build", assignee: role, content: interp(d.content, { module, endpoint: prd.endpoint, page: prd.page }) })
        }
      }
    }
  }

  // 幂等:等价任务已存在(非 cancelled)则跳过
  const exists = ctx.db.prepare(
    `SELECT COUNT(*) AS c FROM tasks
     WHERE module IS ? AND role = ? AND endpoint IS ? AND page IS ? AND type = ? AND status != 'cancelled'`
  )
  for (const d of desired) {
    const row = exists.get(module, d.role, d.endpoint, d.page, d.type) as { c: number }
    if (row.c > 0) {
      summary.skipped++
      continue
    }
    const id = createTask(ctx, { module, role: d.role, endpoint: d.endpoint, page: d.page, type: d.type, assignee: d.assignee, creator, content: d.content })
    summary.created.push({ id, role: d.role, endpoint: d.endpoint, page: d.page, type: d.type })
  }

  // cancel 语义:page 级 pending 任务,其 page-prd 已不存在 → 取消
  const validPages = new Set(pagePrds.map(p => `${p.endpoint}|${p.page}`))
  const pending = ctx.db
    .prepare(
      `SELECT id, role, endpoint, page FROM tasks
       WHERE module IS ? AND status = 'pending' AND page IS NOT NULL AND type IN ('build', 'qa')`
    )
    .all(module) as { id: number; role: Role; endpoint: string | null; page: string }[]
  for (const t of pending) {
    if (validPages.has(`${t.endpoint}|${t.page}`)) continue
    const tx = ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(t.id)
      logEvent(ctx.db, {
        entityType: "task",
        entityId: t.id,
        event: "plan_cancelled",
        actor: creator,
        payload: { reason: "页面 PRD 已删除" },
        module,
        endpoint: t.endpoint,
        page: t.page
      })
    })
    tx()
    summary.cancelled++
  }

  return summary
}
