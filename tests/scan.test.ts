import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  addTaskInput,
  approveArtifact,
  claimTask,
  createTask,
  listArtifacts,
  moveArtifact,
  openWorkbenchAt,
  refreshArtifact,
  reviewStatus,
  scanArtifacts,
  taskStaleness,
  type Ctx
} from "../core/index"

function makeProject(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "wb-scan-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      moduleMapping: { landType: "land" },
      codeRoots: {
        service: ["service/src/modules/{client}/{module}"],
        admin: ["admin/src/pages/home/{module}"]
      }
    })
  )
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("ARCHITECTURE.md", "# 架构基线")
  write("docs/prd/project.md", "# 项目")
  write("docs/prd/flows/land.md", "# land flow")
  write("docs/prd/modules/land.md", "# land PRD")
  write("docs/prd/pages/admin/land/list.md", "# land 列表页 PRD")
  write("docs/architecture/database/land.md", "# land DB")
  write("docs/architecture/api/admin/land.md", "# land API")
  write("docs/design/systems/admin.md", "# admin 设计系统")
  write("docs/design/prompts/admin/land/list.md", "# 提示词")
  write("docs/design/prototypes/admin/land/list.html", "<div>proto</div>")
  // 元产物路径(应被 scan 排除)
  write(".claude/agents/developer.md", "# agent")
  write("docs/workbench/PLAN.md", "# plan")
  // 代码目录
  write("service/src/modules/admin/land/admin.land.controller.ts", "export {}")
  write("admin/src/pages/home/landType/index.tsx", "export {}")
  return openWorkbenchAt(root)
}

describe("scan:全量登记 + 坐标解析 + 边推导", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("登记全部业务产物,排除元产物,代码目录级登记且模块归并", () => {
    const s = scanArtifacts(ctx)
    assert.equal(s.registered, 12) // 10 docs + 2 code dirs

    const all = listArtifacts(ctx, {})
    const byPath = Object.fromEntries(all.map(a => [a.path, a]))

    // 元产物不入 scan(不在扫描根 + isMetaPath 双保险)
    assert.equal(byPath["docs/workbench/PLAN.md"], undefined)

    const pagePrd = byPath["docs/prd/pages/admin/land/list.md"]
    assert.equal(pagePrd.kind, "page-prd")
    assert.deepEqual([pagePrd.module, pagePrd.endpoint, pagePrd.page], ["land", "admin", "land/list"])

    const proto = byPath["docs/design/prototypes/admin/land/list.html"]
    assert.equal(proto.kind, "prototype")
    assert.equal(proto.page, "land/list")

    const codeService = byPath["service/src/modules/admin/land"]
    assert.equal(codeService.kind, "code")
    assert.deepEqual([codeService.module, codeService.endpoint], ["land", "service"])

    // {module} 目录名 landType → 归并为 land
    const codeAdmin = byPath["admin/src/pages/home/landType"]
    assert.equal(codeAdmin.module, "land")

    assert.equal(byPath[".claude/agents/developer.md"], undefined)
  })

  it("DAG 边按 parents 推导:module-prd→page-prd→design-prompt→prototype→code 链成立", () => {
    const edge = (fromPath: string, toPath: string) => {
      const row = ctx.db
        .prepare(
          `SELECT COUNT(*) c FROM artifact_edges e
           JOIN artifacts f ON f.id = e.from_id JOIN artifacts t ON t.id = e.to_id
           WHERE f.path = ? AND t.path = ?`
        )
        .get(fromPath, toPath) as { c: number }
      return row.c
    }
    assert.equal(edge("docs/prd/modules/land.md", "docs/prd/pages/admin/land/list.md"), 1)
    assert.equal(edge("docs/prd/flows/land.md", "docs/prd/modules/land.md"), 1)
    assert.equal(edge("docs/prd/pages/admin/land/list.md", "docs/design/prompts/admin/land/list.md"), 1)
    assert.equal(edge("docs/design/prompts/admin/land/list.md", "docs/design/prototypes/admin/land/list.html"), 1)
    assert.equal(edge("docs/design/prototypes/admin/land/list.html", "admin/src/pages/home/landType"), 1)
    assert.equal(edge("ARCHITECTURE.md", "service/src/modules/admin/land"), 1)
    // 设计系统 → 该端原型
    assert.equal(edge("docs/design/systems/admin.md", "docs/design/prototypes/admin/land/list.html"), 1)
  })

  it("幂等:重跑不重复登记不重复建边;内容变更计入 refreshed", () => {
    const again = scanArtifacts(ctx)
    assert.equal(again.registered, 0)
    assert.equal(again.edges, 0)
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# land PRD v2")
    const third = scanArtifacts(ctx)
    assert.equal(third.refreshed, 1)
  })
})

describe("move / input 命令", () => {
  const ctx = makeProject()
  scanArtifacts(ctx)
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("move 保 id 改 path,审批不断裂(内容未变 → 仍 approved)", () => {
    const before = approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user")
    mkdirSync(join(ctx.root, "docs/prd/modules2"), { recursive: true })
    renameSync(join(ctx.root, "docs/prd/modules/land.md"), join(ctx.root, "docs/prd/modules2/land.md"))
    const moved = moveArtifact(ctx, { from: "docs/prd/modules/land.md", to: "docs/prd/modules2/land.md", actor: "user" })
    assert.equal(moved.id, before.id)
    assert.equal(moved.path, "docs/prd/modules2/land.md")
    assert.equal(reviewStatus(moved), "approved")
  })

  it("input 补充申报 → 进入 stale 监控", () => {
    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "pm" })
    claimTask(ctx, { id, assignee: "architect" })
    // gate 之外的产物:设计系统不在 architect 依赖集,补充申报
    addTaskInput(ctx, { id, path: "docs/design/systems/admin.md", operator: "architect" })
    assert.equal(taskStaleness(ctx.db, id).stale, false)
    writeFileSync(join(ctx.root, "docs/design/systems/admin.md"), "# 设计系统 v2")
    refreshArtifact(ctx, { path: "docs/design/systems/admin.md" })
    const st = taskStaleness(ctx.db, id)
    assert.equal(st.stale, true)
    assert.ok(st.changed.some(c => c.path.includes("systems/admin.md")))
  })
})
