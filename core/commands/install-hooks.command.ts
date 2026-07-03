import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Ctx } from "../types"

/**
 * 安装 git hooks:
 * - post-commit:提交后异步跑 sync(观测 fail-open)
 * - prepare-commit-msg:注入 Task trailer(仅 git.taskTrailer=on 时安装——裁决账本:用户过目后生效)
 */
export function installGitHooks(ctx: Ctx): string[] {
  const hooksDir = join(ctx.root, ".git", "hooks")
  if (!existsSync(join(ctx.root, ".git"))) throw new Error("不是 git 仓库")
  mkdirSync(hooksDir, { recursive: true })
  const installed: string[] = []

  const postCommit = `#!/bin/sh
# workbench:提交后对账(fail-open,后台执行不阻塞 git)
npx tsx workbench/scripts/hook-postcommit.ts >/dev/null 2>&1 &
exit 0
`
  writeFileSync(join(hooksDir, "post-commit"), postCommit)
  try {
    chmodSync(join(hooksDir, "post-commit"), 0o755)
  } catch {
    /* Windows 无需 */
  }
  installed.push("post-commit(sync 对账)")

  if (ctx.config.git.taskTrailer === "on") {
    const prepare = `#!/bin/sh
# workbench:注入任务归因 trailer(环境变量 WORKBENCH_TASK_ID 存在时)
if [ -n "$WORKBENCH_TASK_ID" ] && [ "$2" != "merge" ]; then
  if ! grep -q "^${ctx.config.git.trailerKey}: #" "$1"; then
    printf '\\n${ctx.config.git.trailerKey}: #%s\\n' "$WORKBENCH_TASK_ID" >> "$1"
  fi
fi
exit 0
`
    writeFileSync(join(hooksDir, "prepare-commit-msg"), prepare)
    try {
      chmodSync(join(hooksDir, "prepare-commit-msg"), 0o755)
    } catch {
      /* Windows 无需 */
    }
    installed.push(`prepare-commit-msg(${ctx.config.git.trailerKey} trailer 注入)`)
  }
  return installed
}
