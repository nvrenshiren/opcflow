import { everApproved, prototypeEndorsed, reviewStatus, taskStaleness } from "./derive"
import { validateClaim } from "./gates"
import { getKindRegistry } from "./kind"
import type { ArtifactRow, Ctx, ReviewStatus, TaskRow } from "./types"

export type NodeHealth = "ok" | "stale" | "blocked" | "failed"

const HEALTH_RANK: Record<NodeHealth, number> = { ok: 0, stale: 1, blocked: 2, failed: 3 }

export interface TreeArtifact extends ArtifactRow {
  review_status: ReviewStatus
  ever_approved: boolean
  endorsed: boolean
}

export interface TreeTask extends TaskRow {
  stale: boolean
}

export interface TreeNode {
  key: string
  title: string
  level: "project" | "module" | "endpoint" | "page"
  module: string | null
  endpoint: string | null
  page: string | null
  health: NodeHealth
  phase: string
  counts: { artifacts: number; tasksDone: number; tasksTotal: number }
  children: TreeNode[]
}

const STATUS_LABEL: Record<string, Record<string, string>> = {
  zh: { pending: "待领取", in_progress: "进行中", completed: "已完成", cancelled: "已取消" },
  en: { pending: "unclaimed", in_progress: "in progress", completed: "done", cancelled: "cancelled" }
}

function worse(a: NodeHealth, b: NodeHealth): NodeHealth {
  return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b
}

/** 该坐标最近一次质检类事件为失败 → failed */
function coordFailed(ctx: Ctx, module: string | null, endpoint: string | null, page: string | null): boolean {
  const row = ctx.db
    .prepare(
      `SELECT event FROM events
       WHERE event IN ('qa_passed', 'qa_failed', 'machine_check_failed')
         AND module IS ? AND (? IS NULL OR endpoint IS ?) AND (? IS NULL OR page IS ?)
       ORDER BY id DESC LIMIT 1`
    )
    .get(module, endpoint, endpoint, page, page) as { event: string } | undefined
  return row !== undefined && row.event !== "qa_passed"
}

/** pending 任务的 exist 级 gate 当前不可满足 → blocked(懒计算,legacy 不算) */
function taskBlocked(ctx: Ctx, task: TaskRow): boolean {
  if (task.status !== "pending" || task.type === "legacy") return false
  try {
    validateClaim(ctx, task)
    return false
  } catch (err) {
    return err instanceof Error && err.message.includes("不存在")
  }
}

function coordHealth(ctx: Ctx, artifacts: TreeArtifact[], tasks: TreeTask[]): NodeHealth {
  let health: NodeHealth = "ok"
  if (artifacts.some(a => a.review_status === "invalidated")) health = worse(health, "stale")
  if (tasks.some(t => t.status !== "completed" && t.status !== "cancelled" && t.stale)) health = worse(health, "stale")
  if (tasks.some(t => taskBlocked(ctx, t))) health = worse(health, "blocked")
  return health
}

/** phase:按 pipeline 顺序找到第一个未完成的角色 */
function coordPhase(ctx: Ctx, tasks: TreeTask[]): string {
  const en = ctx.config.language === "en"
  if (tasks.length === 0) return en ? "not dispatched" : "未派发"
  const labels = STATUS_LABEL[en ? "en" : "zh"]
  for (const role of ctx.config.pipeline) {
    const roleTasks = tasks.filter(t => t.role === role && t.status !== "cancelled")
    if (roleTasks.length === 0) continue
    const unfinished = roleTasks.find(t => t.status !== "completed")
    if (unfinished) return `${role} ${labels[unfinished.status] ?? unfinished.status}`
  }
  return en ? "all done" : "全部完成"
}

function decorate(ctx: Ctx, a: ArtifactRow): TreeArtifact {
  return {
    ...a,
    review_status: reviewStatus(a),
    ever_approved: everApproved(a),
    endorsed: a.kind === "prototype" ? prototypeEndorsed(ctx.db, a) : false
  }
}

/**
 * 全树派生(禁止落库):项目 → 模块 → 端 → 页面。
 * health = failed > blocked > stale > ok,向上聚合取最差;
 * 元产物默认过滤(includeMeta 开)。
 */
export function buildTree(ctx: Ctx, opts: { includeMeta?: boolean } = {}): TreeNode {
  const registry = getKindRegistry(ctx.config)
  const artifacts = (ctx.db.prepare("SELECT * FROM artifacts ORDER BY path").all() as ArtifactRow[])
    .filter(a => opts.includeMeta || !registry[a.kind]?.meta)
    .map(a => decorate(ctx, a))
  const tasks = (ctx.db.prepare("SELECT * FROM tasks ORDER BY id").all() as TaskRow[]).map(t => ({
    ...t,
    stale: t.status === "completed" || t.status === "cancelled" ? false : taskStaleness(ctx.db, t.id).stale
  })) as TreeTask[]

  const moduleNames = [
    ...new Set([...artifacts.map(a => a.module), ...tasks.map(t => t.module)].filter((m): m is string => !!m))
  ].sort()

  const makeCounts = (as: TreeArtifact[], ts: TreeTask[]) => ({
    artifacts: as.length,
    tasksDone: ts.filter(t => t.status === "completed").length,
    tasksTotal: ts.filter(t => t.status !== "cancelled").length
  })

  const moduleNodes: TreeNode[] = moduleNames.map(module => {
    const mArtifacts = artifacts.filter(a => a.module === module)
    const mTasks = tasks.filter(t => t.module === module)
    const endpoints = [
      ...new Set([...mArtifacts.map(a => a.endpoint), ...mTasks.map(t => t.endpoint)].filter((e): e is string => !!e))
    ].sort()

    const endpointNodes: TreeNode[] = endpoints.map(endpoint => {
      const eArtifacts = mArtifacts.filter(a => a.endpoint === endpoint)
      const eTasks = mTasks.filter(t => t.endpoint === endpoint)
      const pages = [
        ...new Set([...eArtifacts.map(a => a.page), ...eTasks.map(t => t.page)].filter((p): p is string => !!p))
      ].sort()

      const pageNodes: TreeNode[] = pages.map(page => {
        const pArtifacts = eArtifacts.filter(a => a.page === page)
        const pTasks = eTasks.filter(t => t.page === page)
        let health = coordHealth(ctx, pArtifacts, pTasks)
        if (coordFailed(ctx, module, endpoint, page)) health = "failed"
        return {
          key: `${module}/${endpoint}/${page}`,
          title: page.includes("/") ? page.split("/").pop()! : page,
          level: "page" as const,
          module,
          endpoint,
          page,
          health,
          phase: coordPhase(ctx, pTasks),
          counts: makeCounts(pArtifacts, pTasks),
          children: []
        }
      })

      let health = coordHealth(
        ctx,
        eArtifacts.filter(a => !a.page),
        eTasks.filter(t => !t.page)
      )
      for (const child of pageNodes) health = worse(health, child.health)
      return {
        key: `${module}/${endpoint}`,
        title: endpoint,
        level: "endpoint" as const,
        module,
        endpoint,
        page: null,
        health,
        phase: coordPhase(ctx, eTasks),
        counts: makeCounts(eArtifacts, eTasks),
        children: pageNodes
      }
    })

    let health = coordHealth(
      ctx,
      mArtifacts.filter(a => !a.endpoint),
      mTasks.filter(t => !t.endpoint)
    )
    for (const child of endpointNodes) health = worse(health, child.health)
    if (coordFailed(ctx, module, null, null)) health = "failed"
    return {
      key: module,
      title: module,
      level: "module" as const,
      module,
      endpoint: null,
      page: null,
      health,
      phase: coordPhase(ctx, mTasks),
      counts: makeCounts(mArtifacts, mTasks),
      children: endpointNodes
    }
  })

  // 项目级契约与元产物分桶:业务契约(baseline/project/roles/glossary)与
  // 驱动系统的文件(agent-def/skill/hook/plan)是两类东西,不混装
  const bucket = (key: string, title: string, rows: TreeArtifact[]): TreeNode | null =>
    rows.length > 0
      ? {
          key,
          title,
          level: "endpoint",
          module: null,
          endpoint: null,
          page: null,
          health: rows.some(a => a.review_status === "invalidated") ? "stale" : "ok",
          phase: "-",
          counts: { artifacts: rows.length, tasksDone: 0, tasksTotal: 0 },
          children: []
        }
      : null

  const en = ctx.config.language === "en"
  const projectLevel = artifacts.filter(a => !a.module)
  const projectBucket = bucket("__project__", en ? "Project contracts" : "项目级契约", projectLevel.filter(a => !registry[a.kind]?.meta))
  const metaBucket = bucket("__meta__", en ? "Meta (agent/skill/plan)" : "元产物(agent/skill/plan)", projectLevel.filter(a => registry[a.kind]?.meta))

  let rootHealth: NodeHealth = "ok"
  for (const b of [projectBucket, metaBucket]) if (b) rootHealth = worse(rootHealth, b.health)
  for (const m of moduleNodes) rootHealth = worse(rootHealth, m.health)

  return {
    key: "__root__",
    title: en ? "Project" : "项目",
    level: "project",
    module: null,
    endpoint: null,
    page: null,
    health: rootHealth,
    phase: "-",
    counts: makeCounts(artifacts, tasks),
    children: [...(projectBucket ? [projectBucket] : []), ...(metaBucket ? [metaBucket] : []), ...moduleNodes]
  }
}

export interface NodeDetail {
  artifacts: TreeArtifact[]
  tasks: TreeTask[]
}

/** 节点详情:该坐标(含向下聚合)下的产物与任务;metaOnly 服务元产物桶 */
export function nodeDetail(
  ctx: Ctx,
  f: { module?: string | null; endpoint?: string | null; page?: string | null; includeMeta?: boolean; metaOnly?: boolean }
): NodeDetail {
  const registry = getKindRegistry(ctx.config)
  let aq = "SELECT * FROM artifacts WHERE 1=1"
  let tq = "SELECT * FROM tasks WHERE 1=1"
  const ap: (string | null)[] = []
  const tp: (string | null)[] = []
  if (f.module !== undefined) {
    aq += " AND module IS ?"
    tq += " AND module IS ?"
    ap.push(f.module)
    tp.push(f.module)
  }
  if (f.endpoint != null) {
    aq += " AND endpoint IS ?"
    tq += " AND endpoint IS ?"
    ap.push(f.endpoint)
    tp.push(f.endpoint)
  }
  if (f.page != null) {
    aq += " AND page IS ?"
    tq += " AND page IS ?"
    ap.push(f.page)
    tp.push(f.page)
  }
  const artifacts = (ctx.db.prepare(aq + " ORDER BY kind, path").all(...ap) as ArtifactRow[])
    .filter(a => {
      const isMeta = !!registry[a.kind]?.meta
      if (f.metaOnly) return isMeta
      return f.includeMeta || !isMeta
    })
    .map(a => decorate(ctx, a))
  const tasks = (ctx.db.prepare(tq + " ORDER BY id DESC").all(...tp) as TaskRow[]).map(t => ({
    ...t,
    stale: t.status === "completed" || t.status === "cancelled" ? false : taskStaleness(ctx.db, t.id).stale
  })) as TreeTask[]
  return { artifacts, tasks }
}
