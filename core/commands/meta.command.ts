import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { logEvent } from "../events"
import { hashPath } from "../hash"
import { inferKind } from "../kind"
import type { ArtifactKind, Ctx } from "../types"
import { normalizeRelPath } from "./artifact.commands"

/**
 * 元产物 draft 注册(宪法第七条:驱动系统的文件不能游离于系统之外)。
 * draft 是零摩擦状态:无 approved_hash 即无失效级联,施工期白嫖变更留痕;
 * 审批时点分层——agent-def/skill/hook 于 M4 出口锚定,plan 于校准点过后锚定。
 * migrate scan 排除这些路径,元产物只走本命令显式注册。
 */
export interface RegisterMetaResult {
  registered: { path: string; kind: ArtifactKind }[]
  skipped: string[]
}

const META_SOURCES: { dir: string; filter?: (name: string) => boolean; recursive?: boolean }[] = [
  { dir: ".claude/agents", filter: n => n.endsWith(".md") },
  { dir: ".claude/skills", filter: n => n === "SKILL.md", recursive: true },
  { dir: ".claude/hooks", recursive: true },
  { dir: "docs/workbench", filter: n => n === "PLAN.md" }
]

function collectFiles(root: string, dir: string, filter?: (n: string) => boolean, recursive?: boolean): string[] {
  const abs = join(root, dir)
  if (!existsSync(abs)) return []
  const results: string[] = []
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const relPath = `${rel}/${name}`
      if (statSync(full).isDirectory()) {
        if (recursive) walk(full, relPath)
      } else if (!filter || filter(name)) {
        results.push(relPath)
      }
    }
  }
  walk(abs, dir)
  return results
}

export function registerMetaArtifacts(ctx: Ctx, actor = "system"): RegisterMetaResult {
  const result: RegisterMetaResult = { registered: [], skipped: [] }

  const files: string[] = []
  for (const src of META_SOURCES) {
    files.push(...collectFiles(ctx.root, src.dir, src.filter, src.recursive))
  }

  const insert = ctx.db.prepare(
    `INSERT INTO artifacts (kind, module, endpoint, page, path, content_hash) VALUES (?, NULL, NULL, NULL, ?, ?)`
  )
  const exists = ctx.db.prepare("SELECT id FROM artifacts WHERE path = ?")

  const tx = ctx.db.transaction(() => {
    for (const file of files) {
      const relPath = normalizeRelPath(ctx, file)
      if (exists.get(relPath)) {
        result.skipped.push(relPath)
        continue
      }
      const kind = inferKind(relPath, ctx.config)
      const hash = hashPath(join(ctx.root, relPath))
      if (hash === null) continue
      const inserted = insert.run(kind, relPath, hash)
      logEvent(ctx.db, {
        entityType: "artifact",
        entityId: inserted.lastInsertRowid as number,
        event: "meta_registered",
        actor,
        payload: { path: relPath, kind }
      })
      result.registered.push({ path: relPath, kind })
    }
  })
  tx()
  return result
}
