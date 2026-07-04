import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { openWorkbenchAt, submitArtifact, type Ctx } from "../core/index"
import { createServer } from "../server/app"

function makeProject(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "wb-server-"))
  writeFileSync(join(root, "workbench.config.json"), JSON.stringify({ gates: { approvalMode: "warn" } }))
  return openWorkbenchAt(root)
}

const ctxs: Ctx[] = []

after(() => {
  for (const ctx of ctxs) {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  }
})

describe("server 路径守卫与待审队列", () => {
  it("目录产物文件读取:目录内 200;../ 兄弟前缀目录与越界一律 403", async () => {
    const ctx = makeProject()
    ctxs.push(ctx)

    // 目录级 code 产物 + 同前缀兄弟目录(startsWith 守卫会放过的形状)
    mkdirSync(join(ctx.root, "mod/code"), { recursive: true })
    mkdirSync(join(ctx.root, "mod/code-secrets"), { recursive: true })
    writeFileSync(join(ctx.root, "mod/code/inside.txt"), "inside")
    writeFileSync(join(ctx.root, "mod/code-secrets/secret.txt"), "leak")
    writeFileSync(join(ctx.root, "outside.txt"), "leak")
    const id = ctx.db
      .prepare("INSERT INTO artifacts (kind, module, endpoint, path, content_hash) VALUES ('code','mod','service','mod/code','h')")
      .run().lastInsertRowid

    const app = await createServer(ctx)
    try {
      const ok = await app.inject({ method: "GET", url: `/api/artifact/${id}/file?rel=inside.txt` })
      assert.equal(ok.statusCode, 200)
      assert.equal(JSON.parse(ok.body).content, "inside")

      const sibling = await app.inject({ method: "GET", url: `/api/artifact/${id}/file?rel=${encodeURIComponent("../code-secrets/secret.txt")}` })
      assert.equal(sibling.statusCode, 403)

      const escape = await app.inject({ method: "GET", url: `/api/artifact/${id}/file?rel=${encodeURIComponent("../../outside.txt")}` })
      assert.equal(escape.statusCode, 403)

      const self = await app.inject({ method: "GET", url: `/api/artifact/${id}/file?rel=.` })
      assert.equal(self.statusCode, 403)
    } finally {
      await app.close()
    }
  })

  it("review-queue 返回 ever_approved / endorsed(前端复审标识的数据源)", async () => {
    const ctx = makeProject()
    ctxs.push(ctx)

    mkdirSync(join(ctx.root, "docs/prd/modules"), { recursive: true })
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# land")
    ctx.db
      .prepare("INSERT INTO artifacts (kind, module, endpoint, path, content_hash) VALUES ('module-prd','land','common','docs/prd/modules/land.md','x')")
      .run()
    submitArtifact(ctx, { path: "docs/prd/modules/land.md" }, "pm")

    const app = await createServer(ctx)
    try {
      const res = await app.inject({ method: "GET", url: "/api/review-queue" })
      assert.equal(res.statusCode, 200)
      const rows = JSON.parse(res.body) as { path: string; ever_approved: boolean; endorsed: boolean }[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0].ever_approved, false)
      assert.equal(rows[0].endorsed, false)
    } finally {
      await app.close()
    }
  })
})
