import type Database from "better-sqlite3"
import type { ArtifactRow, ReviewStatus } from "./types"

/**
 * 审批状态派生(五态模型,禁止落库),按优先级:
 *   approved_hash = content_hash                    → approved
 *   submitted_hash = content_hash (≠ approved_hash) → pending(含"失效后重新送审")
 *   approved_hash 非空                               → invalidated(曾批准,已修改,未重新送审)
 *   其余                                             → draft(含"送审后又编辑"的静默撤审)
 */
export function reviewStatus(
  a: Pick<ArtifactRow, "approved_hash" | "content_hash" | "submitted_hash">
): ReviewStatus {
  if (a.approved_hash !== null && a.approved_hash === a.content_hash) return "approved"
  if (a.submitted_hash !== null && a.submitted_hash === a.content_hash) return "pending"
  if (a.approved_hash !== null) return "invalidated"
  return "draft"
}

/**
 * 曾获批标记:re-pending(曾批准+已修改+重新送审)在信任协议中沿用禁用待遇,
 * 直到复审通过——作者的 submit 动作无权单方面恢复下游使用权。
 */
export function everApproved(a: Pick<ArtifactRow, "approved_hash">): boolean {
  return a.approved_hash !== null
}

export interface StaleInfo {
  stale: boolean
  changed: { artifactId: number; path: string; inputHash: string; currentHash: string }[]
}

/**
 * 任务 stale 派生:claim 时快照的 input_hash 与 artifact 当前 content_hash 不一致即 stale。
 */
export function taskStaleness(db: Database.Database, taskId: number): StaleInfo {
  const rows = db
    .prepare(
      `SELECT ti.artifact_id, ti.input_hash, a.path, a.content_hash
       FROM task_inputs ti JOIN artifacts a ON a.id = ti.artifact_id
       WHERE ti.task_id = ?`
    )
    .all(taskId) as { artifact_id: number; input_hash: string; path: string; content_hash: string }[]

  const changed = rows
    .filter(r => r.input_hash !== r.content_hash)
    .map(r => ({ artifactId: r.artifact_id, path: r.path, inputHash: r.input_hash, currentHash: r.content_hash }))
  return { stale: changed.length > 0, changed }
}

/**
 * 模块清算状态派生(懒清算 gate 用):
 * cleared = 该模块的 module-prd 存在且 approved——每模块的最小真相锚点。
 * 未清算的模块被新任务触碰时给出对账提示,不硬阻断(清算成本按需支付)。
 */
export function moduleCleared(db: Database.Database, module: string): boolean {
  const rows = db
    .prepare("SELECT approved_hash, content_hash, submitted_hash FROM artifacts WHERE kind = 'module-prd' AND module = ?")
    .all(module) as Pick<ArtifactRow, "approved_hash" | "content_hash" | "submitted_hash">[]
  return rows.some(r => reviewStatus(r) === "approved")
}

/** prototype 放行判定:存在指向当前 hash 的 +1 反馈(👍 与审批合一,approve 时同步写 approved_hash) */
export function prototypeEndorsed(db: Database.Database, artifact: ArtifactRow): boolean {
  if (artifact.kind !== "prototype") return false
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM artifact_feedback
       WHERE artifact_id = ? AND verdict = 1 AND content_hash = ?`
    )
    .get(artifact.id, artifact.content_hash) as { c: number }
  return row.c > 0
}
