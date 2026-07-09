import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { openWorkbenchAt, scanArtifacts, submitArtifact, type Ctx } from "../core/index"
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

  it("/proto 静态服务:原型 HTML 与同目录相对资源都能直接打开", async () => {
    const ctx = makeProject()
    ctxs.push(ctx)
    const dir = join(ctx.root, "docs/design/prototypes/admin/user")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "list.html"), '<link rel="stylesheet" href="./app.css"><div>proto</div>')
    writeFileSync(join(dir, "app.css"), "body{color:red}")

    const app = await createServer(ctx)
    try {
      // iframe src = /proto/<相对原型根的路径>
      const html = await app.inject({ method: "GET", url: "/proto/admin/user/list.html" })
      assert.equal(html.statusCode, 200)
      assert.match(String(html.headers["content-type"]), /text\/html/)
      assert.ok(html.body.includes("./app.css"))

      // 相对资源:HTML 里的 ./app.css 会解析为 /proto/admin/user/app.css —— 正是过去经 /raw 会 404 的场景
      const css = await app.inject({ method: "GET", url: "/proto/admin/user/app.css" })
      assert.equal(css.statusCode, 200)
      assert.match(String(css.headers["content-type"]), /text\/css/)

      const missing = await app.inject({ method: "GET", url: "/proto/admin/user/nope.html" })
      assert.equal(missing.statusCode, 404)
    } finally {
      await app.close()
    }
  })
})

describe("关系图 API:graph / search / register", () => {
  it("graph 返回非元产物节点(带 review_status/missing)与带 source 的边", async () => {
    const ctx = makeProject()
    ctxs.push(ctx)
    mkdirSync(join(ctx.root, "docs/prd/flows"), { recursive: true })
    mkdirSync(join(ctx.root, "docs/prd/modules"), { recursive: true })
    writeFileSync(join(ctx.root, "docs/prd/flows/land.md"), "# flow")
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# prd")
    scanArtifacts(ctx)

    const app = await createServer(ctx)
    try {
      const res = await app.inject({ method: "GET", url: "/api/graph" })
      assert.equal(res.statusCode, 200)
      const g = JSON.parse(res.body) as { nodes: any[]; edges: any[] }
      assert.equal(g.nodes.length, 2)
      assert.ok(g.nodes.every(n => typeof n.review_status === "string" && typeof n.missing === "boolean"))
      assert.equal(g.edges.length, 1)
      assert.equal(g.edges[0].source, "derived")
    } finally {
      await app.close()
    }
  })

  it("search 同时命中已登记产物与未登记文件;register 幂等登记任意文件", async () => {
    const ctx = makeProject()
    ctxs.push(ctx)
    mkdirSync(join(ctx.root, "docs/prd/modules"), { recursive: true })
    writeFileSync(join(ctx.root, "docs/prd/modules/billing.md"), "# billing")
    mkdirSync(join(ctx.root, "notes"), { recursive: true })
    writeFileSync(join(ctx.root, "notes/billing-memo.txt"), "memo")
    scanArtifacts(ctx)

    const app = await createServer(ctx)
    try {
      const res = await app.inject({ method: "GET", url: "/api/search?q=billing" })
      const r = JSON.parse(res.body) as { artifacts: { path: string }[]; files: string[] }
      assert.ok(r.artifacts.some(a => a.path === "docs/prd/modules/billing.md"))
      assert.ok(r.files.includes("notes/billing-memo.txt"))

      const reg1 = await app.inject({ method: "POST", url: "/api/artifact/register", payload: { path: "notes/billing-memo.txt", actor: "user" } })
      assert.equal(reg1.statusCode, 200)
      const a1 = JSON.parse(reg1.body)
      const reg2 = await app.inject({ method: "POST", url: "/api/artifact/register", payload: { path: "notes/billing-memo.txt", actor: "user" } })
      assert.equal(JSON.parse(reg2.body).id, a1.id) // 幂等

      // 登记后从 files 移入 artifacts
      const res2 = await app.inject({ method: "GET", url: "/api/search?q=billing" })
      const r2 = JSON.parse(res2.body) as { artifacts: { path: string }[]; files: string[] }
      assert.ok(!r2.files.includes("notes/billing-memo.txt"))
      assert.ok(r2.artifacts.some(a => a.path === "notes/billing-memo.txt"))
    } finally {
      await app.close()
    }
  })
})

describe("关系图 API:手动边增删(derived 不可解绑,manual 可;环检测)", () => {
  it("建 manual 边→事件留痕;重复 409;成环 400;删 derived 403;删 manual 放行", async () => {
    const ctx = makeProject()
    ctxs.push(ctx)
    mkdirSync(join(ctx.root, "docs/prd/flows"), { recursive: true })
    mkdirSync(join(ctx.root, "docs/prd/modules"), { recursive: true })
    writeFileSync(join(ctx.root, "docs/prd/flows/land.md"), "# flow")
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# prd")
    mkdirSync(join(ctx.root, "notes"), { recursive: true })
    writeFileSync(join(ctx.root, "notes/memo.txt"), "memo")
    scanArtifacts(ctx)
    const id = (p: string) => (ctx.db.prepare("SELECT id FROM artifacts WHERE path = ?").get(p) as { id: number }).id
    const flow = id("docs/prd/flows/land.md")
    const prd = id("docs/prd/modules/land.md")

    const app = await createServer(ctx)
    try {
      // 登记一个孤立文件,和 prd 建 manual 边:prd → memo
      const reg = await app.inject({ method: "POST", url: "/api/artifact/register", payload: { path: "notes/memo.txt", actor: "user" } })
      const memo = JSON.parse(reg.body).id as number

      const ok = await app.inject({ method: "POST", url: "/api/edge", payload: { fromId: prd, toId: memo, actor: "user" } })
      assert.equal(ok.statusCode, 200)
      const edge = JSON.parse(ok.body)
      assert.equal(edge.source, "manual")

      const dup = await app.inject({ method: "POST", url: "/api/edge", payload: { fromId: prd, toId: memo, actor: "user" } })
      assert.equal(dup.statusCode, 409)

      // 自指 400
      const self = await app.inject({ method: "POST", url: "/api/edge", payload: { fromId: prd, toId: prd, actor: "user" } })
      assert.equal(self.statusCode, 400)

      // 成环:已有 prd→memo,再试 memo→prd → 400
      const cyc = await app.inject({ method: "POST", url: "/api/edge", payload: { fromId: memo, toId: prd, actor: "user" } })
      assert.equal(cyc.statusCode, 400)

      // derived 边不可删
      const derived = ctx.db.prepare("SELECT id FROM artifact_edges WHERE source = 'derived' LIMIT 1").get() as { id: number }
      assert.ok(derived, "应存在 flow→prd 的 derived 边")
      const delDerived = await app.inject({ method: "DELETE", url: `/api/edge/${derived.id}`, payload: { actor: "user" } })
      assert.equal(delDerived.statusCode, 403)

      // manual 可删 + 留痕;不存在 404
      const delManual = await app.inject({ method: "DELETE", url: `/api/edge/${edge.id}`, payload: { actor: "user" } })
      assert.equal(delManual.statusCode, 200)
      const delAgain = await app.inject({ method: "DELETE", url: `/api/edge/${edge.id}`, payload: { actor: "user" } })
      assert.equal(delAgain.statusCode, 404)

      const evAdd = ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE event = 'edge_added'").get() as { c: number }
      const evDel = ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE event = 'edge_removed'").get() as { c: number }
      assert.ok(evAdd.c >= 1)
      assert.equal(evDel.c, 1)
      void flow
    } finally {
      await app.close()
    }
  })
})
