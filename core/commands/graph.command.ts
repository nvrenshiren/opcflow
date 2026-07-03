import { reviewStatus } from "../derive"
import { KIND_TIERS } from "../kind"
import type { ArtifactRow, Ctx } from "../types"

const TIER_LABELS = ["契约基线", "业务流程", "模块 PRD", "页面 PRD", "架构/设计系统", "设计提示词", "原型/验收", "代码"]

/**
 * 输出某模块的 文档→任务→产出 关系链(Mermaid flowchart)。
 * 节点按 kind 层级分组;审批状态以样式类标注;边取 artifact_edges。
 */
export function graphModule(ctx: Ctx, module: string): string {
  const artifacts = ctx.db
    .prepare("SELECT * FROM artifacts WHERE module = ? OR (module IS NULL AND kind IN ('baseline','project','roles','glossary')) ORDER BY id")
    .all(module) as ArtifactRow[]

  if (artifacts.length === 0) return `%% 模块 ${module} 没有登记任何产物`

  const ids = artifacts.map(a => a.id)
  const edges = ctx.db
    .prepare(
      `SELECT from_id, to_id FROM artifact_edges
       WHERE from_id IN (${ids.map(() => "?").join(",")}) AND to_id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids, ...ids) as { from_id: number; to_id: number }[]

  const lines: string[] = ["flowchart TD"]

  const label = (a: ArtifactRow) => {
    const name = a.path.split("/").pop() ?? a.path
    const suffix = a.endpoint ? ` (${a.endpoint}${a.page ? `/${a.page}` : ""})` : ""
    return `${name}${suffix}`.replace(/["[\]]/g, "")
  }

  KIND_TIERS.forEach((kinds, i) => {
    const tierArtifacts = artifacts.filter(a => (kinds as string[]).includes(a.kind))
    if (tierArtifacts.length === 0) return
    lines.push(`  subgraph T${i}["${TIER_LABELS[i]}"]`)
    for (const a of tierArtifacts) {
      lines.push(`    a${a.id}["${label(a)}"]:::${reviewStatus(a)}`)
    }
    lines.push("  end")
  })

  const inTiers = new Set(artifacts.filter(a => KIND_TIERS.flat().includes(a.kind)).map(a => a.id))
  const others = artifacts.filter(a => !inTiers.has(a.id))
  for (const a of others) {
    lines.push(`  a${a.id}["${label(a)}"]:::${reviewStatus(a)}`)
  }

  for (const e of edges) {
    lines.push(`  a${e.from_id} --> a${e.to_id}`)
  }

  lines.push("  classDef approved fill:#e1f5ee,stroke:#0f6e56")
  lines.push("  classDef draft fill:#f1efe8,stroke:#888780")
  lines.push("  classDef pending fill:#faeeda,stroke:#ba7517")
  lines.push("  classDef invalidated fill:#fcebeb,stroke:#a32d2d")
  return lines.join("\n")
}
