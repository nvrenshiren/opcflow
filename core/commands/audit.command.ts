import { existsSync } from "node:fs"
import { join } from "node:path"
import { everApproved, moduleCleared, reviewStatus } from "../derive"
import { contractKinds, normalizeModule } from "../kind"
import type { ArtifactRow, Ctx, ReviewStatus } from "../types"

export interface AuditRow {
  kind: string
  path: string
  status: ReviewStatus
  everApproved: boolean
  onDisk: boolean
}

export interface AuditReport {
  module: string
  cleared: boolean
  contracts: AuditRow[]
  codeDirs: { path: string; endpoint: string | null; onDisk: boolean }[]
  /** 建议动作:一致即送审的候选(draft 契约);漂移需人判 */
  suggestedSubmits: string[]
}

/**
 * 对账报告(懒清算的入口):列出模块全部契约产物的信任状态与磁盘存在性。
 * 判断"文档 vs 代码是否一致"是 architect agent / 用户的活;本命令只提供事实。
 */
export function auditModule(ctx: Ctx, moduleRaw: string): AuditReport {
  const module = normalizeModule(moduleRaw, ctx.config)!
  const kinds = contractKinds(ctx.config)
  const artifacts = ctx.db
    .prepare(`SELECT * FROM artifacts WHERE module = ? ORDER BY kind, path`)
    .all(module) as ArtifactRow[]

  const contracts: AuditRow[] = artifacts
    .filter(a => (kinds as string[]).includes(a.kind))
    .map(a => ({
      kind: a.kind,
      path: a.path,
      status: reviewStatus(a),
      everApproved: everApproved(a),
      onDisk: existsSync(join(ctx.root, a.path))
    }))

  const codeDirs = artifacts
    .filter(a => a.kind === "code")
    .map(a => ({ path: a.path, endpoint: a.endpoint, onDisk: existsSync(join(ctx.root, a.path)) }))

  return {
    module,
    cleared: moduleCleared(ctx.db, module),
    contracts,
    codeDirs,
    suggestedSubmits: contracts.filter(c => c.status === "draft" && c.onDisk).map(c => c.path)
  }
}
