import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  approveArtifact,
  claimTask,
  createTask,
  listTasks,
  openWorkbenchAt,
  refreshArtifact,
  registerOutput,
  reviewStatus,
  scanArtifacts,
  syncArtifacts,
  taskStaleness,
  updateTask,
  type Ctx
} from "../core/index"

function makeProject(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "wb-sync-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/flows/land.md", "# flow")
  write("docs/prd/modules/land.md", "# land PRD v1")
  write("docs/prd/pages/admin/land/list.md", "# page prd")
  write("docs/architecture/database/land.md", "# db")
  write("docs/architecture/api/admin/land.md", "# api")
  const ctx = openWorkbenchAt(root)
  scanArtifacts(ctx)
  return ctx
}

describe("sync:失效传播 → review 派发(去重) → trivial re-bless", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("approved 上游变更 → sync 派 review 给下游角色;重跑不重复派", () => {
    approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user")
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# land PRD v2")

    const s = syncArtifacts(ctx)
    assert.equal(s.invalidated, 1)
    assert.ok(s.reviewsSpawned >= 1)

    const reviews = listTasks(ctx, { type: "review" })
    assert.ok(reviews.length >= 1)
    // 下游 page-prd 归 PM,db-doc 归 architect → 两类角色至少其一
    assert.ok(reviews.some(r => r.role === "product-manager" || r.role === "architect"))

    const again = syncArtifacts(ctx)
    assert.equal(again.reviewsSpawned, 0) // 去重:open review 存在时不重复派
  })

  it("trivial 通过:re-bless 下游快照 + 自动关闭派生 review", () => {
    // 先造一个依赖该 PRD 的进行中任务(claim 快照旧 hash)
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# land PRD v3")
    refreshArtifact(ctx, { path: "docs/prd/modules/land.md" })
    const tid = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "pm" })
    claimTask(ctx, { id: tid, assignee: "architect" })

    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# land PRD v4 微调")
    syncArtifacts(ctx)
    assert.equal(taskStaleness(ctx.db, tid).stale, true)
    const openReviews = listTasks(ctx, { type: "review", status: "pending" })
    assert.ok(openReviews.length >= 1)

    approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user", { trivial: true })
    assert.equal(taskStaleness(ctx.db, tid).stale, false) // re-bless 解除 stale
    const stillOpen = listTasks(ctx, { type: "review", status: "pending" })
    assert.equal(stillOpen.length, 0) // 派生 review 全部自动关闭
  })

  it("文件删除 → tombstone 事件 + 派 review,不静默悬空", () => {
    approveArtifact(ctx, { path: "docs/architecture/api/admin/land.md" }, "user")
    rmSync(join(ctx.root, "docs/architecture/api/admin/land.md"))
    const s = syncArtifacts(ctx)
    assert.equal(s.tombstoned, 1)
    const row = ctx.db
      .prepare("SELECT COUNT(*) c FROM events WHERE event = 'tombstoned'")
      .get() as { c: number }
    assert.equal(row.c, 1)
    // 再跑不重复墓碑
    assert.equal(syncArtifacts(ctx).tombstoned, 0)
  })
})

describe("sync 去重粒度:按目标而非按源——先前 review 未关时,新增下游仍能收到通知", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sync-gran-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/flows/land.md", "# flow")
  write("docs/prd/modules/land.md", "# land PRD v1")
  write("docs/prd/pages/admin/land/list.md", "# page prd")
  const ctx = openWorkbenchAt(root)
  scanArtifacts(ctx)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("首轮 review 未关闭时第二次失效:已通知的目标去重、新出现的下游角色照常派", () => {
    // 第一次失效:下游只有 page-prd → 派 PM review
    approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user")
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# land PRD v2")
    syncArtifacts(ctx)
    assert.equal(listTasks(ctx, { type: "review", role: "product-manager" }).length, 1)

    // PM review 保持 open;期间新增 db-doc 下游(architect),再次批准→失效
    approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user")
    mkdirSync(join(ctx.root, "docs/architecture/database"), { recursive: true })
    writeFileSync(join(ctx.root, "docs/architecture/database/land.md"), "# land DB")
    scanArtifacts(ctx) // 登记 db-doc + 推导 module-prd→db-doc 边
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# land PRD v3")
    syncArtifacts(ctx)

    // 修复前:hasOpenReview 按源整体短路 → architect 永远收不到
    assert.equal(listTasks(ctx, { type: "review", role: "architect" }).length, 1)
    // 已 open 的 PM review 不重复派
    assert.equal(listTasks(ctx, { type: "review", role: "product-manager" }).length, 1)
  })
})

describe("hotfix 契约触碰检测(工作区 diff,fail-open)", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("非 git 仓库:检测静默跳过,hotfix 正常完成", () => {
    const id = createTask(ctx, { module: "land", role: "developer", endpoint: "admin", type: "hotfix", creator: "user" })
    claimTask(ctx, { id, assignee: "developer" })
    const { warnings } = updateTask(ctx, { id, status: "completed", operator: "developer" })
    assert.ok(!warnings.some(w => w.includes("契约触碰")))
  })
})

describe("审批内容存档与 diff 数据源", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("approve 后存档已批版本;修改后 approved/current 可比对", async () => {
    const { approvedContent, resolveArtifact } = await import("../core/commands/artifact.commands")
    const row = resolveArtifact(ctx, { path: "docs/prd/modules/land.md" })
    approveArtifact(ctx, { id: row.id }, "user")
    assert.equal(approvedContent(ctx, row.id), "# land PRD v1")
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# 改了")
    refreshArtifact(ctx, { id: row.id })
    assert.equal(reviewStatus(resolveArtifact(ctx, { id: row.id })), "invalidated")
    assert.equal(approvedContent(ctx, row.id), "# land PRD v1") // 存档不随当前内容漂移
  })
})
