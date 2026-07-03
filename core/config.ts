import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { WorkbenchConfig } from "./types"

export const CONFIG_FILENAME = "workbench.config.json"

const DEFAULTS: WorkbenchConfig = {
  endpoints: ["service", "admin", "weapp", "app"],
  docs: {
    prd: "docs/prd",
    architecture: "docs/architecture",
    design: "docs/design",
    acceptance: "docs/acceptance"
  },
  codeRoots: {},
  machineChecks: { enabled: false },
  protocolLints: [],
  moduleMapping: {},
  feedbackHalfLifeDays: 90,
  gates: { approvalMode: "warn", writeGate: "observe" },
  git: { taskTrailer: "off", trailerKey: "Task" },
  legacyDb: "tasks/task.db",
  dataDir: ".workbench",
  cli: "npx tsx workbench/cli.ts",
  pipeline: ["product-manager", "architect", "designer", "developer", "qa"],
  roleProduces: {
    "product-manager": ["project", "roles", "glossary", "flow", "module-prd", "page-prd"],
    architect: ["db-doc", "api-doc"],
    designer: ["design-system", "design-prompt", "prototype"],
    developer: ["code"],
    qa: ["acceptance"]
  }
}

/** 自 from 向上寻找 workbench.config.json 所在目录;找不到则返回 from 本身 */
export function findProjectRoot(from: string = process.cwd()): string {
  let dir = resolve(from)
  while (true) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(from)
    dir = parent
  }
}

export function loadConfig(root: string): WorkbenchConfig {
  const file = join(root, CONFIG_FILENAME)
  if (!existsSync(file)) return { ...DEFAULTS }
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<WorkbenchConfig>
  return {
    ...DEFAULTS,
    ...raw,
    docs: { ...DEFAULTS.docs, ...raw.docs },
    gates: { ...DEFAULTS.gates, ...raw.gates },
    machineChecks: { ...DEFAULTS.machineChecks, ...raw.machineChecks },
    roleProduces: { ...DEFAULTS.roleProduces, ...raw.roleProduces },
    pipeline: raw.pipeline ?? DEFAULTS.pipeline,
    git: { ...DEFAULTS.git, ...raw.git }
  }
}
