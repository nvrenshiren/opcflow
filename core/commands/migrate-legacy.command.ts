import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { logEvent } from "../events"
import { hashPath } from "../hash"
import { inferKind, normalizeModule } from "../kind"
import type { Ctx } from "../types"

interface LegacyTask {
  id: number
  module: string
  role: string
  endpoint: string
  page: string | null
  status: string
  assignee: string
  creator: string
  content: string | null
  created_at: string
  updated_at: string
}

interface LegacyOutput {
  id: number
  module: string
  role: string
  endpoint: string
  page: string | null
  file_path: string
  created_at: string
}

interface LegacyRecord {
  id: number
  task_id: number
  content: string
  operator: string | null
  created_at: string
}

export interface MigrateSummary {
  tasks: number
  artifacts: number
  linkedOutputs: number
  missingFiles: string[]
  notes: number
}

/**
 * 旧 tasks/task.db → 新库。旧任务整体标 type=legacy,旧产出转 artifacts,
 * 旧记录转 note 事件。幂等保护:已存在 legacy 任务则拒绝重跑。旧库只读不动。
 */
export function migrateLegacy(ctx: Ctx, legacyDbPath?: string): MigrateSummary {
  const relPath = legacyDbPath ?? ctx.config.legacyDb
  const absPath = join(ctx.root, relPath)
  if (!existsSync(absPath)) throw new Error(`旧库不存在: ${relPath}`)

  const existing = ctx.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE type = 'legacy'").get() as { c: number }
  if (existing.c > 0) throw new Error(`已迁移过(存在 ${existing.c} 条 legacy 任务),不可重复迁移`)

  const legacy = new Database(absPath, { readonly: true, fileMustExist: true })
  const oldTasks = legacy.prepare("SELECT * FROM tasks ORDER BY id").all() as LegacyTask[]
  const oldOutputs = legacy.prepare("SELECT * FROM task_outputs ORDER BY id").all() as LegacyOutput[]
  const oldRecords = legacy.prepare("SELECT * FROM task_records ORDER BY id").all() as LegacyRecord[]
  legacy.close()

  const summary: MigrateSummary = { tasks: 0, artifacts: 0, linkedOutputs: 0, missingFiles: [], notes: 0 }

  const tx = ctx.db.transaction(() => {
    const insertTask = ctx.db.prepare(
      `INSERT INTO tasks (id, module, role, endpoint, page, type, status, assignee, creator, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'legacy', ?, ?, ?, ?, ?, ?)`
    )
    for (const t of oldTasks) {
      insertTask.run(
        t.id,
        normalizeModule(t.module, ctx.config),
        t.role,
        t.endpoint,
        t.page,
        t.status,
        t.assignee,
        t.creator,
        t.content,
        t.created_at,
        t.updated_at
      )
      summary.tasks++
    }

    const insertArtifact = ctx.db.prepare(
      `INSERT INTO artifacts (kind, module, endpoint, page, path, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const findTask = ctx.db.prepare(
      `SELECT id FROM tasks
       WHERE type = 'legacy' AND role = ? AND endpoint = ? AND module IS ?
         AND (? IS NULL OR page IS ?)
       ORDER BY id DESC LIMIT 1`
    )
    const linkOutput = ctx.db.prepare("INSERT OR IGNORE INTO task_outputs (task_id, artifact_id) VALUES (?, ?)")

    for (const o of oldOutputs) {
      const relFile = o.file_path.replace(/\\/g, "/")
      const module = normalizeModule(o.module, ctx.config)
      const hash = hashPath(join(ctx.root, relFile))
      if (hash === null) summary.missingFiles.push(relFile)

      const dup = ctx.db.prepare("SELECT id FROM artifacts WHERE path = ?").get(relFile) as { id: number } | undefined
      if (dup) continue

      const result = insertArtifact.run(
        inferKind(relFile, ctx.config),
        module,
        o.endpoint,
        o.page,
        relFile,
        hash ?? "",
        o.created_at
      )
      const artifactId = result.lastInsertRowid as number
      summary.artifacts++

      const match = findTask.get(o.role, o.endpoint, module, o.page, o.page) as { id: number } | undefined
      if (match) {
        linkOutput.run(match.id, artifactId)
        summary.linkedOutputs++
      }
    }

    const taskIds = new Set(oldTasks.map(t => t.id))
    for (const r of oldRecords) {
      if (!taskIds.has(r.task_id)) continue
      logEvent(ctx.db, {
        entityType: "task",
        entityId: r.task_id,
        event: "note",
        actor: r.operator ?? "unknown",
        payload: { content: r.content, migrated: true },
        createdAt: r.created_at
      })
      summary.notes++
    }

    logEvent(ctx.db, {
      entityType: "task",
      entityId: 0,
      event: "migrated",
      actor: "system",
      payload: { ...summary, source: relPath }
    })
  })
  tx()

  return summary
}
