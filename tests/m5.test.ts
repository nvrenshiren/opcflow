import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  claimTask,
  createTask,
  openWorkbenchAt,
  registerOutput,
  runProtocolLints,
  updateTask,
  type Ctx
} from "../core/index"

function makeProject(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "wb-m5-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      protocolLints: [
        {
          name: "no-sql-enum-literal",
          grep: "z\\.enum\\(\\[\\s*\"[A-Z]",
          paths: ["service/src"],
          endpoint: "service",
          message: "SQL enum 禁止硬编码"
        },
        {
          name: "api-doc-no-page-size",
          grep: "pageSize",
          paths: ["docs/architecture/api"],
          role: "architect",
          message: "分页统一 take/skip",
          allow: ["docs/architecture/api/legacy.md"]
        }
      ]
    })
  )
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/modules/land.md", "# PRD")
  write("docs/architecture/database/land.md", "# DB")
  write("docs/architecture/api/land.md", "# API 文档:take/skip 分页")
  write("docs/architecture/api/legacy.md", "历史文档:pageSize(allowlist 承接)")
  write("service/src/modules/admin/land/params.ts", 'export const p = z.enum(["day", "week"])') // 小写:合法
  const ctx = openWorkbenchAt(root)
  registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
  registerOutput(ctx, { module: "land", role: "architect", endpoint: "common", filePath: "docs/architecture/database/land.md" })
  registerOutput(ctx, { module: "land", role: "architect", endpoint: "service", filePath: "docs/architecture/api/land.md" })
  return ctx
}

describe("M5 协议 lint 卡点", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("小写查询参数字面量不误伤;大写 SQL enum 字面量被拦", () => {
    assert.equal(runProtocolLints(ctx, { role: "developer", endpoint: "service" }).length, 0)

    writeFileSync(
      join(ctx.root, "service/src/modules/admin/land/params.ts"),
      'export const p = z.enum(["SELL", "RENT"])' // 硬编码 SQL enum = 违例
    )
    const violations = runProtocolLints(ctx, { role: "developer", endpoint: "service" })
    assert.equal(violations.length, 1)
    assert.equal(violations[0].lint, "no-sql-enum-literal")
  })

  it("验收场景:硬编码 enum 存在时 developer complete 被拦;修复后放行", () => {
    const id = createTask(ctx, { module: "land", role: "developer", endpoint: "service", creator: "pm" })
    claimTask(ctx, { id, assignee: "developer" })
    assert.throws(() => updateTask(ctx, { id, status: "completed", operator: "developer" }), /协议 lint 失败.*no-sql-enum-literal/s)

    writeFileSync(join(ctx.root, "service/src/modules/admin/land/params.ts"), 'export const p = landEnum // 从 interface 引用')
    const { warnings } = updateTask(ctx, { id, status: "completed", operator: "developer" })
    assert.ok(Array.isArray(warnings))
  })

  it("architect 契约文档 lint:pageSize 被拦,allowlist 承接既有债", () => {
    // allowlist 文件有 pageSize 但不违例
    assert.equal(runProtocolLints(ctx, { role: "architect" }).length, 0)

    writeFileSync(join(ctx.root, "docs/architecture/api/land.md"), "# API\n分页:page/pageSize")
    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "service", creator: "pm" })
    claimTask(ctx, { id, assignee: "architect" })
    assert.throws(() => updateTask(ctx, { id, status: "completed", operator: "architect" }), /api-doc-no-page-size/)

    writeFileSync(join(ctx.root, "docs/architecture/api/land.md"), "# API\n分页:take/skip")
    updateTask(ctx, { id, status: "completed", operator: "architect" })
  })

  it("端过滤:service 的 lint 不影响 admin 端任务", () => {
    writeFileSync(join(ctx.root, "service/src/modules/admin/land/params.ts"), 'z.enum(["SELL"])')
    assert.equal(runProtocolLints(ctx, { role: "developer", endpoint: "admin" }).length, 0)
  })
})

describe("M5 协议 lint 门禁:去外层角色白名单,role:qa 规则不再被静默吞掉", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-m5-role-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      protocolLints: [
        { name: "qa-no-todo", grep: "TODO", paths: ["docs/acceptance"], role: "qa", message: "验收文档不留 TODO" }
      ]
    })
  )
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/modules/land.md", "# PRD")
  write("docs/acceptance/land.md", "验收要点:TODO 补充用例")
  const ctx = openWorkbenchAt(root)
  registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
  registerOutput(ctx, { module: "land", role: "qa", endpoint: "common", filePath: "docs/acceptance/land.md" })

  it("role:qa 的 lint 违例阻断 qa 任务 complete(此前被外层白名单静默忽略)", () => {
    const id = createTask(ctx, { module: "land", role: "qa", endpoint: "common", type: "qa", creator: "pm" })
    // qa 的 claim 前置要求 developer 已完成:先补一个已完成的 developer 任务
    ctx.db
      .prepare("INSERT INTO tasks (module, role, endpoint, status, assignee, creator) VALUES ('land','developer','common','completed','developer','pm')")
      .run()
    claimTask(ctx, { id, assignee: "qa" })
    assert.throws(
      () => updateTask(ctx, { id, status: "completed", operator: "qa", force: true }),
      /协议 lint 失败.*qa-no-todo/s
    )
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })
})
