import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { claimTask, createTask, getRoleRegistry, openWorkbenchAt, registerOutput, updateTask, type Ctx } from "../core/index"

describe("角色注册表:合并语义与 requires 规则化", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-roles-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, "docs/prd/modules/land.md"), "# land PRD")
  const ctx: Ctx = openWorkbenchAt(root)
  registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("默认注册表编码现行为:developer 非 service 要求 api-doc+设计稿,service 只要 db-doc", () => {
    const reg = getRoleRegistry(ctx.config)
    const dev = reg.developer
    assert.deepEqual(dev.produces, ["code"])
    assert.equal(dev.requires!.filter(r => !r.when).length, 1) // db-doc 无条件
    assert.ok(dev.requires!.some(r => r.when?.endpointNot === "service" && r.kinds.includes("api-doc")))
  })

  it("config.roleProduces 旧字段兼容:只覆盖 produces 维度", () => {
    ctx.config.roleProduces = { ...ctx.config.roleProduces, architect: ["code"] }
    const reg = getRoleRegistry(ctx.config)
    assert.deepEqual(reg.architect.produces, ["code"])
    assert.ok(reg.architect.requires!.length >= 1) // requires 等其他维度保留默认
    ctx.config.roleProduces = { ...ctx.config.roleProduces, architect: ["db-doc", "api-doc"] } // 还原
  })

  it("config.roles 可为自定义角色声明 requires:security-reviewer 要求 api-doc 存在", () => {
    ctx.config.roles = {
      "security-reviewer": {
        produces: ["doc"],
        requires: [{ desc: "API 契约", kinds: ["api-doc"] }]
      }
    }
    const id = createTask(ctx, { module: "land", role: "security-reviewer" as never, endpoint: "service", creator: "pm" })
    // api-doc 不存在 → exist 级阻断
    assert.throws(() => claimTask(ctx, { id, assignee: "security-reviewer" }), /API 契约.*不存在/)
  })

  it("未注册的角色 createTask 被拒(校验来自注册表键,而非静态清单)", () => {
    assert.throws(
      () => createTask(ctx, { module: "land", role: "nonexistent-role" as never, endpoint: "common", creator: "pm" }),
      /无效的角色/
    )
  })
})

describe("producedKinds 形态匹配:产出分裂由注册表 dispatch.produces 承载(不再锁死 designer)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-roles-shape-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      roles: {
        author: {
          produces: ["module-prd"],
          dispatch: [{ at: "page", produces: ["acceptance"], content: "写 {endpoint}/{page} 验收" }]
        }
      }
    })
  )
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("page 任务产出义务=acceptance;无 page 任务=module-prd——同一角色两形态分裂", () => {
    // 预先登记 acceptance(page 坐标),不登记 module-prd
    write("docs/acceptance/admin/land/list.md", "# 验收用例")
    registerOutput(ctx, { module: "land", role: "author" as never, endpoint: "admin", page: "land/list", filePath: "docs/acceptance/admin/land/list.md" })

    const pageTask = createTask(ctx, { module: "land", role: "author" as never, endpoint: "admin", page: "land/list", creator: "pm" })
    claimTask(ctx, { id: pageTask, assignee: "author" })
    const { warnings } = updateTask(ctx, { id: pageTask, status: "completed", operator: "author", force: true })
    assert.ok(Array.isArray(warnings)) // acceptance 已在 → page 形态放行

    const moduleTask = createTask(ctx, { module: "land", role: "author" as never, endpoint: "admin", creator: "pm" })
    claimTask(ctx, { id: moduleTask, assignee: "author" })
    // module-prd 不存在 → 无 page 形态的产出义务阻断(修复前 producedKinds 读不到自定义角色,义务为空不拦)
    assert.throws(() => updateTask(ctx, { id: moduleTask, status: "completed", operator: "author", force: true }), /必须添加产出文件/)

    write("docs/prd/modules/land.md", "# land PRD")
    registerOutput(ctx, { module: "land", role: "author" as never, endpoint: "common", filePath: "docs/prd/modules/land.md" })
    const r2 = updateTask(ctx, { id: moduleTask, status: "completed", operator: "author", force: true })
    assert.ok(Array.isArray(r2.warnings))
  })
})
