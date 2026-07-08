import { build } from "esbuild"

// 把整个 CLI(core/server/scripts/cli-runner)打成单文件 ESM;node_modules 依赖保持 external
// (随 package.json 安装),better-sqlite3 等原生模块不进 bundle。web/dist 由 vite 单独构建。
await build({
  entryPoints: ["cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/cli.mjs",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info"
})
