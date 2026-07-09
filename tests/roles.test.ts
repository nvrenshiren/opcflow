import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { claimTask, createTask, getRoleRegistry, openWorkbenchAt, registerOutput, type Ctx } from "../core/index"

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
