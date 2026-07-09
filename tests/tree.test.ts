import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { buildTree, createTask, logEvent, openWorkbenchAt, type Ctx } from "../core/index"

describe("tree health:端级失败定位与 gate 阻塞识别", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-tree-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const node = (tree: ReturnType<typeof buildTree>, ...keys: string[]) => {
    let cur: any = tree
    for (const k of keys) cur = cur?.children.find((c: any) => c.key === k)
    return cur
  }

  it("端级质检失败(page=null 事件)→ endpoint 节点自身标 failed,不只 module 变红", () => {
    ctx.db
      .prepare("INSERT INTO artifacts (kind, module, endpoint, path, content_hash) VALUES ('code','land','service','service/src/modules/land','h')")
      .run()
    logEvent(ctx.db, { entityType: "task", entityId: 1, event: "machine_check_failed", actor: "gate", module: "land", endpoint: "service" })
    const tree = buildTree(ctx)
    assert.equal(node(tree, "land").health, "failed") // module 级通配已能变红(现状)
    assert.equal(node(tree, "land", "land/service").health, "failed") // 修复点:端节点此前只靠子页面冒泡,端级事件无处冒
  })

  it("pending 任务被 gate 前置卡住(非 exist 级)→ blocked,而非显示健康", () => {
    createTask(ctx, { module: "shop", role: "qa", endpoint: "admin", type: "qa", creator: "pm" })
    const tree = buildTree(ctx)
    assert.equal(node(tree, "shop", "shop/admin").health, "blocked") // 修复点:此前只认"不存在"字样,qa 等 developer 的前置被当健康
  })
})
