import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Ctx, Role } from "./types"

export interface LintRule {
  name: string
  grep: string
  paths: string[]
  /** 只在该端的 developer complete 时执行;缺省=任何 developer 端 */
  endpoint?: string
  /** 只在该角色 complete 时执行;缺省 developer */
  role?: Role
  message?: string
  /** 既有债 allowlist:命中这些文件不阻断(清算后移除) */
  allow?: string[]
}

export interface LintViolation {
  lint: string
  file: string
  line: number
  text: string
  message: string
}

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".workbench"])

function walkFiles(abs: string, rel: string, out: string[]) {
  const st = statSync(abs)
  if (st.isFile()) {
    out.push(rel)
    return
  }
  for (const name of readdirSync(abs).sort()) {
    if (IGNORE.has(name) || name.startsWith(".")) continue
    walkFiles(join(abs, name), `${rel}/${name}`, out)
  }
}

/**
 * 协议 lint 引擎:能机器化的约定坚决降级为机器检查(M5)。
 * 规则来自 config.protocolLints;按角色/端过滤;allowlist 承接既有债。
 */
export function runProtocolLints(
  ctx: Ctx,
  scope: { role: Role; endpoint?: string | null }
): LintViolation[] {
  const violations: LintViolation[] = []
  const rules = (ctx.config.protocolLints as LintRule[]).filter(rule => {
    const ruleRole = rule.role ?? "developer"
    if (ruleRole !== scope.role) return false
    if (rule.endpoint && scope.endpoint && rule.endpoint !== scope.endpoint) return false
    if (rule.endpoint && !scope.endpoint) return false
    return true
  })

  for (const rule of rules) {
    const regex = new RegExp(rule.grep)
    const allow = new Set((rule.allow ?? []).map(p => p.replace(/\\/g, "/")))
    for (const base of rule.paths) {
      const abs = join(ctx.root, base)
      if (!existsSync(abs)) continue
      const files: string[] = []
      walkFiles(abs, base.replace(/\\/g, "/"), files)
      for (const file of files) {
        if (allow.has(file)) continue
        if (/\.(png|jpg|jpeg|gif|webp|woff2?|ttf|ico|db)$/i.test(file)) continue
        const lines = readFileSync(join(ctx.root, file), "utf-8").split("\n")
        lines.forEach((text, i) => {
          if (regex.test(text)) {
            violations.push({
              lint: rule.name,
              file,
              line: i + 1,
              text: text.trim().slice(0, 120),
              message: rule.message ?? rule.name
            })
          }
        })
      }
    }
  }
  return violations
}
