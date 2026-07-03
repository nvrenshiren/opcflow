import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_FILENAME } from "../config"
import { openWorkbenchAt } from "../db"
import type { Ctx, Role } from "../types"
import { genAgents } from "./gen-agents.command"
import { installGitHooks } from "./install-hooks.command"
import { registerMetaArtifacts } from "./meta.command"

export interface InitOptions {
  /** 项目有哪些端(前端端决定 designer/qa 是否进流水线) */
  endpoints: string[]
  /** 覆盖角色流水线;缺省按 endpoints 推断(纯后端 → 无 designer) */
  pipeline?: Role[]
  /** 每个端的代码目录约定(scan 目录级登记 code 产物用);{module} 是模块名占位 */
  codeRoots?: Record<string, string[]>
  /** 是否安装 git hooks(非 git 仓库自动跳过) */
  gitHooks?: boolean
  /** 是否脚手架 docs 目录骨架(默认 true) */
  scaffold?: boolean
  /** 是否写 .mcp.json 让 Claude Code 自动挂载 MCP(默认 true) */
  mcp?: boolean
}

export interface InitResult {
  ctx: Ctx
  configPath: string
  agents: string[]
  metaRegistered: number
  hooks: string[]
  scaffolded: string[]
  mcpPath: string | null
}

const DOC_DIRS = [
  "docs/prd/flows",
  "docs/prd/modules",
  "docs/prd/pages",
  "docs/architecture/database",
  "docs/architecture/api",
  "docs/design/systems",
  "docs/design/prompts",
  "docs/design/prototypes",
  "docs/acceptance"
]

/**
 * 新项目一键引导:生成项目层 config → 建库 → 脚手架 docs 骨架 →
 * 从模板生成 agent 定义 → 元产物 draft 注册 → 写 .mcp.json → git hooks。
 * 幂等防覆盖:已有 config 的目录拒绝执行。
 */
export function initProject(root: string, opts: InitOptions): InitResult {
  const configPath = join(root, CONFIG_FILENAME)
  if (existsSync(configPath)) {
    throw new Error(`${CONFIG_FILENAME} 已存在,init 只用于空项目引导(改配置请直接编辑该文件)`)
  }
  if (opts.endpoints.length === 0) throw new Error("至少声明一个端(--endpoints=service,...)")

  const hasFrontend = opts.endpoints.some(e => e !== "service")
  const pipeline: Role[] =
    opts.pipeline ??
    (hasFrontend
      ? ["product-manager", "architect", "designer", "developer", "qa"]
      : ["product-manager", "architect", "developer", "qa"])

  const config = {
    endpoints: opts.endpoints,
    pipeline,
    docs: { prd: "docs/prd", architecture: "docs/architecture", design: "docs/design", acceptance: "docs/acceptance" },
    codeRoots: opts.codeRoots ?? {},
    cli: "npx tsx workbench/cli.ts",
    machineChecks: { enabled: false },
    protocolLints: [],
    moduleMapping: {},
    feedbackHalfLifeDays: 90,
    gates: { approvalMode: "warn", writeGate: "observe" },
    git: { taskTrailer: "off", trailerKey: "Task" }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")

  const scaffolded: string[] = []
  if (opts.scaffold !== false) {
    for (const dir of DOC_DIRS) {
      const abs = join(root, dir)
      if (!existsSync(abs)) {
        mkdirSync(abs, { recursive: true })
        writeFileSync(join(abs, ".gitkeep"), "")
        scaffolded.push(dir)
      }
    }
  }

  const ctx = openWorkbenchAt(root)
  const { written } = genAgents(ctx)
  const meta = registerMetaArtifacts(ctx)

  let mcpPath: string | null = null
  if (opts.mcp !== false) {
    const p = join(root, ".mcp.json")
    if (!existsSync(p)) {
      writeFileSync(
        p,
        JSON.stringify({ mcpServers: { workbench: { command: "npx", args: ["tsx", "workbench/server/mcp.ts"] } } }, null, 2) + "\n"
      )
      mcpPath = ".mcp.json"
    }
  }

  let hooks: string[] = []
  if (opts.gitHooks !== false && existsSync(join(root, ".git"))) {
    try {
      hooks = installGitHooks(ctx)
    } catch {
      /* 非 git 仓库/hook 目录异常:引导不因此失败 */
    }
  }

  return { ctx, configPath, agents: written, metaRegistered: meta.registered.length, hooks, scaffolded, mcpPath }
}
