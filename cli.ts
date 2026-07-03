#!/usr/bin/env npx tsx
/**
 * Workbench CLI(独立项目入口)。
 * 用法:npx tsx workbench/cli.ts <command> [--flags]
 * init 在 config 存在前运行;其余命令走 core。
 */
import { openWorkbench } from "./core/db"
import { parseArgs, printTasks, runCommand, runInit } from "./cli-runner"
import { listTasks } from "./core/index"

async function main() {
  const { command, a } = parseArgs(process.argv.slice(2))

  if (command === "init") {
    runInit(a.project || process.cwd(), a)
    return
  }

  const ctx = openWorkbench(a.project)

  if (!command) {
    printTasks(listTasks(ctx, {}))
    return
  }

  try {
    await runCommand(ctx, command, a)
  } catch (err: any) {
    console.error(`\n✗ ${err.message}\n`)
    process.exit(1)
  }
}

main()
