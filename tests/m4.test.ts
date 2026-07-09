import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  approveArtifact,
  claimTask,
  genAgents,
  listTasks,
  openWorkbenchAt,
  planModule,
  recordQaResult,
  scanArtifacts,
  syncArtifacts,
  updateTask,
  type Ctx
} from "../core/index"

function makeProject(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "wb-m4-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("ARCHITECTURE.md", "# baseline")
  write("docs/prd/project.md", "# 项目")
  write("docs/prd/flows/land.md", "# flow")
  write("docs/prd/modules/land.md", "# land PRD")
  write("docs/prd/pages/admin/land/list.md", "# 列表页 PRD\n验收要点:能看到列表")
  write("docs/prd/pages/admin/land/edit.md", "# 编辑页 PRD")
  write("docs/architecture/database/land.md", "# land DB")
  write("docs/architecture/api/admin/land.md", "# land API")
  write("docs/design/prompts/admin/land/list.md", "# 提示词")
  write("docs/design/prompts/admin/land/edit.md", "# 提示词")
  const ctx = openWorkbenchAt(root)
  scanArtifacts(ctx)
  return ctx
}

describe("plan 派发:幂等 + 设计系统前置 + cancel 语义", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("按 page-prd 生成整组任务(含 qa 与设计系统前置),warn 模式给信任警告", () => {
    const s = planModule(ctx, "land")
    // architect×2 + dev service + 设计系统(admin) + 2页×(designer+developer+qa)=6 → 10
    assert.equal(s.created.length, 10)
    assert.ok(s.warnings.length > 0) // 契约未审批 → 信任警告
    assert.ok(s.created.some(t => t.role === "designer" && t.page === null)) // 设计系统前置
    assert.equal(s.created.filter(t => t.type === "qa").length, 2)
  })

  it("幂等:重跑全部跳过", () => {
    const s = planModule(ctx, "land")
    assert.equal(s.created.length, 0)
    assert.equal(s.skipped, 10)
  })

  it("cancel 语义:删除页面 PRD 后重派,该页 pending 任务被取消(走真实 tombstone 链路)", () => {
    // 真实链路:文件删除 → sync 打 tombstone 事件(artifacts 行保留)→ plan 不再认它
    // 此前的测试手工 DELETE FROM artifacts 抄了近道,掩盖了"行不删导致永远取消不掉"的缺陷
    rmSync(join(ctx.root, "docs/prd/pages/admin/land/edit.md"))
    syncArtifacts(ctx)
    const s = planModule(ctx, "land")
    assert.equal(s.created.length, 0) // 已删页面不再派新任务
    assert.equal(s.cancelled, 3) // designer + developer + qa
    const cancelled = listTasks(ctx, { module: "land", status: "cancelled" })
    assert.ok(cancelled.every(t => t.page === "land/edit"))
  })
})

describe("QA fail→rework→复验闭环", () => {
  const ctx = makeProject()
  planModule(ctx, "land")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  function finishDeveloper(page: string) {
    const dev = listTasks(ctx, { module: "land", role: "developer" }).find(t => t.page === page && t.status === "pending")!
    claimTask(ctx, { id: dev.id, assignee: "developer" })
    updateTask(ctx, { id: dev.id, status: "completed", operator: "developer", force: true })
    return dev.id
  }

  it("fail 必附原因;fail → rework 任务;rework 完成 → 自动派复验 qa", () => {
    finishDeveloper("land/list")
    const qa = listTasks(ctx, { module: "land", role: "qa" }).find(t => t.page === "land/list")!
    claimTask(ctx, { id: qa.id, assignee: "qa" })

    assert.throws(() => recordQaResult(ctx, { id: qa.id, result: "fail", operator: "qa" }), /必须附原因/)

    const { reworkTaskId } = recordQaResult(ctx, { id: qa.id, result: "fail", reason: "列表分页失效:skip 不生效", operator: "qa" })
    assert.ok(reworkTaskId)
    const rework = listTasks(ctx, { type: "rework" })[0]
    assert.ok(rework.content?.includes("分页失效"))

    claimTask(ctx, { id: rework.id, assignee: "developer" })
    const { warnings } = updateTask(ctx, { id: rework.id, status: "completed", operator: "developer", force: true })
    assert.ok(warnings.some(w => w.includes("复验")))
    const respawned = listTasks(ctx, { role: "qa", status: "pending" }).filter(t => t.page === "land/list")
    assert.equal(respawned.length, 1) // 新一轮复验已派

    // pass 收口
    claimTask(ctx, { id: respawned[0].id, assignee: "qa" })
    const r2 = recordQaResult(ctx, { id: respawned[0].id, result: "pass", operator: "qa" })
    assert.equal(r2.reworkTaskId, null)
  })
})

describe("gen-agents:注册表注入路径,零 token 残留", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("生成 5 个 agent 定义,路径来自注册表,含信任协议", () => {
    const { written } = genAgents(ctx)
    assert.equal(written.length, 5)
    const dev = readFileSync(join(ctx.root, ".claude/agents/developer.md"), "utf-8")
    assert.ok(dev.includes("docs/design/prototypes/")) // 注册表展开的路径
    assert.ok(dev.includes("信任协议"))
    assert.ok(dev.includes(".claude/agent-memory/developer/"))
    assert.ok(!dev.includes("{{")) // 零 token 残留
    assert.ok(existsSync(join(ctx.root, ".claude/agents/qa.md")))
  })
})
