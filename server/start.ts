import { openWorkbench } from "../core/db"
import { createServer } from "./app"

const port = parseInt(process.env.WORKBENCH_PORT ?? "5620")
const ctx = openWorkbench(process.env.WORKBENCH_PROJECT)

createServer(ctx).then(async app => {
  await app.listen({ port, host: "127.0.0.1" })
  console.log(`Workbench server: http://127.0.0.1:${port}  (project: ${ctx.root})`)
})
