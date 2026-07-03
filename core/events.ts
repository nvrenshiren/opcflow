import type Database from "better-sqlite3"
import type { EventRow } from "./types"

export interface LogEventInput {
  entityType: "task" | "artifact"
  entityId: number
  event: string
  actor: string
  payload?: unknown
  module?: string | null
  endpoint?: string | null
  page?: string | null
  /** 迁移场景保留原始时间 */
  createdAt?: string
}

/** 写事件。必须在调用方的事务内执行(写必留痕原则)。 */
export function logEvent(db: Database.Database, e: LogEventInput): number {
  const result = db
    .prepare(
      `INSERT INTO events (entity_type, entity_id, event, actor, payload, module, endpoint, page, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    )
    .run(
      e.entityType,
      e.entityId,
      e.event,
      e.actor,
      e.payload === undefined ? null : JSON.stringify(e.payload),
      e.module ?? null,
      e.endpoint ?? null,
      e.page ?? null,
      e.createdAt ?? null
    )
  return result.lastInsertRowid as number
}

export interface EventsFilter {
  entityType?: "task" | "artifact"
  entityId?: number
  module?: string
  event?: string
  afterId?: number
  limit?: number
}

export function listEvents(db: Database.Database, f: EventsFilter = {}): EventRow[] {
  let query = "SELECT * FROM events WHERE 1=1"
  const params: (string | number)[] = []
  if (f.entityType) {
    query += " AND entity_type = ?"
    params.push(f.entityType)
  }
  if (f.entityId !== undefined) {
    query += " AND entity_id = ?"
    params.push(f.entityId)
  }
  if (f.module) {
    query += " AND module = ?"
    params.push(f.module)
  }
  if (f.event) {
    query += " AND event = ?"
    params.push(f.event)
  }
  if (f.afterId !== undefined) {
    query += " AND id > ?"
    params.push(f.afterId)
  }
  query += " ORDER BY id " + (f.afterId !== undefined ? "ASC" : "DESC")
  if (f.limit) {
    query += " LIMIT ?"
    params.push(f.limit)
  }
  return db.prepare(query).all(...params) as EventRow[]
}
