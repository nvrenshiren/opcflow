import { logEvent } from "../events"
import type { ArtifactRow, Ctx } from "../types"
import { feedbackArtifact } from "./artifact.commands"
import { getTaskRow, updateTask } from "./task.commands"

export interface QaResultParams {
  id: number
  result: "pass" | "fail"
  reason?: string
  operator: string
}

export interface QaResultOutcome {
  reworkTaskId: number | null
}

/**
 * QA 验收结果(rework 闭环的入口):
 * - pass:qa_passed 事件 + 完成任务 + 自动给该坐标 code 产物写 +1 verdict
 *   (M8 进化管道的主粮——单用户手动 👍 频率不足,QA 结果自动喂)
 * - fail:必附原因;qa_failed 事件 + 完成本 qa 任务 + 自动派 rework 任务给 developer;
 *   rework 完成时由 updateTask 自动再派新一轮 qa(循环直到 pass)
 */
export function recordQaResult(ctx: Ctx, p: QaResultParams): QaResultOutcome {
  const task = getTaskRow(ctx, p.id)
  if (task.role !== "qa") throw new Error(`任务 #${p.id} 不是 qa 任务`)
  if (task.assignee !== p.operator) throw new Error(`只有执行人才能记录验收结果`)
  if (p.result === "fail" && !p.reason?.trim()) throw new Error(`验收不通过必须附原因,它将成为 rework 任务的内容`)

  const eventName = p.result === "pass" ? "qa_passed" : "qa_failed"
  const tx = ctx.db.transaction(() => {
    logEvent(ctx.db, {
      entityType: "task",
      entityId: task.id,
      event: eventName,
      actor: p.operator,
      payload: { reason: p.reason ?? null },
      module: task.module,
      endpoint: task.endpoint,
      page: task.page
    })
  })
  tx()

  updateTask(ctx, { id: task.id, status: "completed", operator: p.operator, force: true })

  if (p.result === "pass") {
    // 自动 verdict:该坐标的 code 产物记 +1(actor=qa,进反馈加权管道)
    const codes = ctx.db
      .prepare("SELECT * FROM artifacts WHERE kind = 'code' AND module IS ? AND (endpoint IS ? OR ? IS NULL)")
      .all(task.module, task.endpoint, task.endpoint) as ArtifactRow[]
    for (const code of codes) {
      try {
        feedbackArtifact(ctx, { id: code.id }, { verdict: 1, comment: "QA 验收通过(自动)", actor: "qa-auto", taskId: task.id })
      } catch {
        /* 反馈失败不阻塞验收 */
      }
    }
    return { reworkTaskId: null }
  }

  // fail → rework 任务
  const tx2 = ctx.db.transaction(() => {
    const result = ctx.db
      .prepare(
        `INSERT INTO tasks (module, role, endpoint, page, type, status, assignee, creator, content)
         VALUES (?, 'developer', ?, ?, 'rework', 'pending', 'developer', 'system', ?)`
      )
      .run(task.module, task.endpoint, task.page, `[返工] QA #${task.id} 验收不通过:${p.reason}`)
    const reworkId = result.lastInsertRowid as number
    logEvent(ctx.db, {
      entityType: "task",
      entityId: reworkId,
      event: "rework_spawned",
      actor: "system",
      payload: { qaTask: task.id, reason: p.reason },
      module: task.module,
      endpoint: task.endpoint,
      page: task.page
    })
    return reworkId
  })
  return { reworkTaskId: tx2() }
}
