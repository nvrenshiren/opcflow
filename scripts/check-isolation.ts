/**
 * 可移植性纪律检查:workbench 包禁止 import 任何业务代码。
 * 违规即 exit 1。在 CI / 提交前运行。
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const PKG_ROOT = join(import.meta.dirname, "..")

const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /from\s+["'](?:\.\.\/)+(?:service|admin|weapp|app|packages)\//, reason: "禁止相对路径引用业务代码" },
  { pattern: /from\s+["']@whzhuke\/(?!workbench)/, reason: "禁止引用 @whzhuke 业务包" },
  { pattern: /require\(\s*["'](?:\.\.\/)+(?:service|admin|weapp|app|packages)\//, reason: "禁止 require 业务代码" },
  { pattern: /["'][A-Za-z]:\\\\/, reason: "禁止硬编码绝对路径" }
]

const violations: string[] = []

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full)
    } else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
      const content = readFileSync(full, "utf-8")
      const lines = content.split("\n")
      lines.forEach((line, i) => {
        for (const { pattern, reason } of FORBIDDEN) {
          if (pattern.test(line)) {
            violations.push(`${relative(PKG_ROOT, full)}:${i + 1} ${reason}\n    ${line.trim()}`)
          }
        }
      })
    }
  }
}

walk(PKG_ROOT)

if (violations.length > 0) {
  console.error(`✗ 隔离检查失败,发现 ${violations.length} 处业务耦合:\n`)
  for (const v of violations) console.error("  " + v)
  process.exit(1)
}
console.log("✓ 隔离检查通过:workbench 无业务耦合")
