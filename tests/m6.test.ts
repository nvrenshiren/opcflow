import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  approveArtifact,
  auditModule,
  claimTask,
  closeLinkedIssue,
  createTask,
  moduleCleared,
  openWorkbenchAt,
  registerOutput,
  type Ctx
} from "../core/index"

function makeProject(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "wb-m6-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/modules/land.md", "# land PRD")
  write("docs/architecture/database/land.md", "# land DB")
  const ctx = openWorkbenchAt(root)
  registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
  registerOutput(ctx, { module: "land", role: "architect", endpoint: "common", filePath: "docs/architecture/database/land.md" })
  return ctx
}

describe("M6 懒清算", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("清算状态派生:module-prd 审批前 uncleared,审批后 cleared", () => {
    assert.equal(moduleCleared(ctx.db, "land"), false)

    const report = auditModule(ctx, "land")
    assert.equal(report.cleared, false)
    assert.equal(report.contracts.length, 2)
    assert.deepEqual(report.suggestedSubmits.sort(), [
      "docs/architecture/database/land.md",
      "docs/prd/modules/land.md"
    ])

    approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user")
    assert.equal(moduleCleared(ctx.db, "land"), true)
    assert.equal(auditModule(ctx, "land").cleared, true)
  })

  it("未清算模块 claim 出对账提示;清算后消失", () => {
    // goods 未清算
    writeFileSync(join(ctx.root, "docs/prd/modules/goods.md"), "# goods PRD")
    registerOutput(ctx, { module: "goods", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/goods.md" })
    const id = createTask(ctx, { module: "goods", role: "architect", endpoint: "common", creator: "pm" })
    const { warnings } = claimTask(ctx, { id, assignee: "architect" })
    assert.ok(warnings.some(w => w.includes("[清算]") && w.includes("audit")))

    // land 已清算(上一测试审批过) → 无清算提示
    const id2 = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "pm" })
    const { warnings: w2 } = claimTask(ctx, { id: id2, assignee: "architect" })
    assert.ok(!w2.some(w => w.includes("[清算]")))
  })
})

describe("M6.5 issue 回写", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("非 gh# 格式的 external_ref 不触发回写", () => {
    assert.equal(closeLinkedIssue(ctx, "jira-123", 1), false)
    assert.equal(closeLinkedIssue(ctx, "gh#abc", 1), false)
  })
})
