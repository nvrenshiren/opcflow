/**
 * Workbench CLI —— 单一 bin 承载全部子命令(发布后经 `npx -y @whzhuke/workbench <cmd>` 调用)。
 * 项目侧不落 workbench 源码:init 生成的 config.cli / .mcp.json / hooks 全指向本 bin。
 *   init                      新项目引导
 *   mcp                       起 MCP server(stdio),读 --project / cwd 的 .workbench
 *   serve [--project --port]  起 web 工作台,连接项目的 .workbench
 *   hook pre|post --platform= agent 工具调用前后 hook(写门禁 / 刷新)
 *   postcommit                git 提交后:scan + sync + 孤儿检测 + 导出
 *   其余(list/plan/qa/...)   见 `help`
 */
import { openWorkbench } from "./core/db"
import { parseArgs, printTasks, runInit, runCommand } from "./cli-runner"
import { listTasks } from "./core/index"

async function main() {
  const { command, a } = parseArgs(process.argv.slice(2))

  if (command === "init") {
    await runInit(a.project || process.cwd(), a)
    return
  }

  if (command === "mcp") {
    const { buildMcpServer } = await import("./server/mcp")
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")
    const ctx = openWorkbench(a.project ?? process.env.WORKBENCH_PROJECT)
    await buildMcpServer(ctx).connect(new StdioServerTransport())
    return
  }

  if (command === "serve") {
    const { createServer } = await import("./server/app")
    const { createServer: netServer } = await import("node:net")
    const ctx = openWorkbench(a.project ?? process.env.WORKBENCH_PROJECT)
    const start = parseInt(a.port ?? process.env.WORKBENCH_PORT ?? "5620")
    const host = a.host ?? process.env.WORKBENCH_HOST ?? "0.0.0.0" // 默认对局域网开放;--host=127.0.0.1 只本机
    // 从 start 起找一个空闲端口(5620 被占用时自动 5621、5622…),避免直接崩
    const port = await new Promise<number>((resolve, reject) => {
      let p = start
      let tries = 0
      const probe = () => {
        const s = netServer()
        s.once("error", (e: any) => {
          s.close()
          if (e?.code === "EADDRINUSE" && tries++ < 30) {
            p++
            probe()
          } else reject(e)
        })
        s.once("listening", () => s.close(() => resolve(p)))
        s.listen(p, host)
      }
      probe()
    })
    if (port !== start) console.error(`端口 ${start} 被占用,改用 ${port}`)
    const app = await createServer(ctx)
    await app.listen({ port, host })
    console.log(`Workbench: http://127.0.0.1:${port}  (host: ${host}, project: ${ctx.root})`)
    return
  }

  if (command === "hook") {
    const platform = a.platform ?? "claude"
    if (a._ === "pre") {
      const { writeGateHook } = await import("./scripts/hook-pretooluse")
      await writeGateHook(platform).catch(() => {})
    } else if (a._ === "post") {
      const { refreshHook } = await import("./scripts/hook-refresh")
      await refreshHook(platform).catch(() => {})
    }
    process.exit(0)
  }

  if (command === "postcommit") {
    try {
      const { scanArtifacts, syncArtifacts, detectOrphanCommit } = await import("./core/index")
      const { exportEventLog } = await import("./core/commands/retro.command")
      const ctx = openWorkbench(process.cwd())
      scanArtifacts(ctx, "post-commit")
      syncArtifacts(ctx, "post-commit")
      detectOrphanCommit(ctx)
      exportEventLog(ctx)
    } catch {
      /* observe fail-open:提交后对账绝不阻塞 */
    }
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
