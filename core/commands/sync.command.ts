import { existsSync } from "node:fs"
import { join } from "node:path"
import { reviewStatus } from "../derive"
import { logEvent } from "../events"
import { headCommitInfo } from "../git"
import { getKindRegistry } from "../kind"
import { ownerRoleOf } from "../roles"
import type { ArtifactKind, ArtifactRow, Ctx, Role } from "../types"
import { refreshArtifact, resolveArtifact } from "./artifact.commands"

export interface SyncSummary {
  checked: number
  changed: number
  invalidated: number
  tombstoned: number
  reviewsSpawned: number
}

/** kind → 产出它的角色(角色注册表 produces 反查,review 任务派给谁);保留导出名兼容消费方 */
export function ownerRole(ctx: Ctx, kind: ArtifactKind): Role | null {
  return ownerRoleOf(ctx.config, kind) as Role | null
}

/** 去重(按目标粒度):该上游已有 open review 的 (role|endpoint|module) 键集(经 task_inputs 关联) */
function openReviewTargetKeys(ctx: Ctx, artifactId: number): Set<string> {
  const rows = ctx.db
    .prepare(
      `SELECT t.role, t.endpoint, t.module FROM tasks t
       JOIN task_inputs ti ON ti.task_id = t.id
       WHERE t.type = 'review' AND t.status IN ('pending', 'in_progress') AND ti.artifact_id = ?`
    )
    .all(artifactId) as { role: string; endpoint: string | null; module: string | null }[]
  return new Set(rows.map(r => `${r.role}|${r.endpoint ?? ""}|${r.module ?? ""}`))
}

/**
 * 上游产物变更/删除 → 沿 DAG 找直接下游 → 按下游归属角色派 review 任务。
 * 每个受影响 (role, endpoint) 一条;task_inputs 关联变更源(快照当前 hash,即"复审基线")。
 * 去重按目标粒度而非按源整体:此前只要该源有任一 open review 就整体短路,
 * 首轮 review 未关时新增的下游角色会永远收不到通知。
 */
export function spawnReviews(ctx: Ctx, source: ArtifactRow, reason: string): number {
  const openKeys = openReviewTargetKeys(ctx, source.id)

  const registry = getKindRegistry(ctx.config)
  const downstream = ctx.db
    .prepare(`SELECT a.* FROM artifacts a JOIN artifact_edges e ON e.to_id = a.id WHERE e.from_id = ?`)
    .all(source.id) as ArtifactRow[]

  const targets = new Map<string, { role: Role; endpoint: string | null; module: string | null }>()
  for (const child of downstream) {
    if (registry[child.kind]?.meta) continue
    const role = ownerRole(ctx, child.kind)
    if (!role) continue
    const key = `${role}|${child.endpoint ?? ""}|${child.module ?? source.module ?? ""}`
    if (openKeys.has(key)) continue // 该目标已有 open review,不重复打扰
    targets.set(key, { role, endpoint: child.endpoint, module: child.module ?? source.module })
  }

  let spawned = 0
  const tx = ctx.db.transaction(() => {
    for (const t of targets.values()) {
      const result = ctx.db
        .prepare(
          `INSERT INTO tasks (module, role, endpoint, type, status, assignee, creator, content)
           VALUES (?, ?, ?, 'review', 'pending', ?, 'system', ?)`
        )
        .run(t.module, t.role, t.endpoint, t.role, `[复审] 上游 ${source.path} ${reason},请复核你基于它的产出并对齐`)
      const taskId = result.lastInsertRowid as number
      ctx.db
        .prepare("INSERT OR REPLACE INTO task_inputs (task_id, artifact_id, input_hash) VALUES (?, ?, ?)")
        .run(taskId, source.id, source.content_hash)
      logEvent(ctx.db, {
        entityType: "task",
        entityId: taskId,
        event: "review_spawned",
        actor: "system",
        payload: { source: source.path, reason },
        module: t.module,
        endpoint: t.endpoint
      })
      spawned++
    }
  })
  tx()
  return spawned
}

/**
 * 全量对账(手动或 post-commit hook 触发):
 * - 逐产物 rehash;曾获批且失效 → 派 review
 * - 文件消失 → tombstone 事件 + 派 review(不静默悬空)
 * 观测通道,fail-open:单个产物出错不中断整体。
 */
export function syncArtifacts(ctx: Ctx, actor = "sync"): SyncSummary {
  const summary: SyncSummary = { checked: 0, changed: 0, invalidated: 0, tombstoned: 0, reviewsSpawned: 0 }
  const artifacts = ctx.db.prepare("SELECT * FROM artifacts").all() as ArtifactRow[]

  for (const artifact of artifacts) {
    summary.checked++
    try {
      const abs = join(ctx.root, artifact.path)
      if (!existsSync(abs)) {
        const already = ctx.db
          .prepare("SELECT COUNT(*) AS c FROM events WHERE entity_type='artifact' AND entity_id=? AND event='tombstoned'")
          .get(artifact.id) as { c: number }
        if (already.c === 0) {
          logEvent(ctx.db, {
            entityType: "artifact",
            entityId: artifact.id,
            event: "tombstoned",
            actor,
            payload: { path: artifact.path },
            module: artifact.module,
            endpoint: artifact.endpoint,
            page: artifact.page
          })
          summary.tombstoned++
          summary.reviewsSpawned += spawnReviews(ctx, artifact, "已从磁盘删除")
        }
        continue
      }

      const before = artifact.content_hash
      const wasApproved = reviewStatus(artifact) === "approved"
      const after = refreshArtifact(ctx, { id: artifact.id }, actor)
      if (after.content_hash === before) continue
      summary.changed++

      if (wasApproved && reviewStatus(after) === "invalidated") {
        summary.invalidated++
        summary.reviewsSpawned += spawnReviews(ctx, after, "已变更(审批失效)")
      }
    } catch {
      /* fail-open */
    }
  }
  return summary
}

/**
 * 孤儿提交检测(observe 模式,裁决:范围 = 本模块 codeRoots ∪ 契约路径):
 * taskTrailer=on 时,HEAD 提交无 Task trailer 且触碰了受管路径 → orphan_commit 事件留痕。
 * 只观测不阻断;观察期数据达标后再议 enforce。
 */
export function detectOrphanCommit(ctx: Ctx): { orphan: boolean; hits: string[] } {
  if (ctx.config.git.taskTrailer !== "on") return { orphan: false, hits: [] }
  const head = headCommitInfo(ctx.root, ctx.config.git.trailerKey)
  if (!head || head.trailer) return { orphan: false, hits: [] }

  const registry = getKindRegistry(ctx.config)
  const managed = (ctx.db.prepare("SELECT * FROM artifacts").all() as ArtifactRow[]).filter(a => {
    const spec = registry[a.kind]
    return spec && !spec.meta && (spec.approval === "human" || a.kind === "code")
  })
  const hits = new Set<string>()
  for (const file of head.files) {
    for (const a of managed) {
      if (file === a.path || file.startsWith(a.path + "/")) {
        hits.add(file)
        break
      }
    }
  }
  if (hits.size === 0) return { orphan: false, hits: [] }

  const already = ctx.db
    .prepare("SELECT COUNT(*) AS c FROM events WHERE event = 'orphan_commit' AND payload LIKE ?")
    .get(`%${head.hash}%`) as { c: number }
  if (already.c === 0) {
    const tx = ctx.db.transaction(() => {
      logEvent(ctx.db, {
        entityType: "artifact",
        entityId: 0,
        event: "orphan_commit",
        actor: "post-commit",
        payload: { commit: head.hash, hits: [...hits].slice(0, 20) }
      })
    })
    tx()
  }
  return { orphan: true, hits: [...hits] }
}

/** agent 对 approved 内容的异议出口:留痕并停止,等用户裁决 */
export function disputeArtifact(ctx: Ctx, ref: { path?: string; id?: number }, actor: string, reason: string): void {
  if (!reason?.trim()) throw new Error("异议必须说明理由")
  const artifact = resolveArtifact(ctx, ref)
  const tx = ctx.db.transaction(() => {
    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: artifact.id,
      event: "dispute",
      actor,
      payload: { reason },
      module: artifact.module,
      endpoint: artifact.endpoint,
      page: artifact.page
    })
  })
  tx()
}
