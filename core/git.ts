import { execFileSync } from "node:child_process"

/** git 集成全部 fail-open:仓库不可用时返回 null/空,绝不阻塞主流程 */

export function gitHead(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

/** claim_commit 之后触碰的文件(已提交区间 + 工作区未提交),相对路径正斜杠 */
export function touchedSince(cwd: string, sinceCommit: string | null): string[] {
  const files = new Set<string>()
  try {
    if (sinceCommit) {
      const out = execFileSync("git", ["diff", "--name-only", `${sinceCommit}..HEAD`], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"]
      }).toString()
      for (const line of out.split("\n")) if (line.trim()) files.add(line.trim())
    }
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString()
    for (const line of status.split("\n")) {
      const p = line.slice(3).trim().replace(/^"|"$/g, "")
      if (p) files.add(p)
    }
  } catch {
    /* fail-open */
  }
  return [...files]
}

/** HEAD 提交的元信息:hash / trailer 值 / 触碰文件(孤儿检测用) */
export function headCommitInfo(cwd: string, trailerKey: string): { hash: string; trailer: string | null; files: string[] } | null {
  try {
    const hash = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
    const trailer = execFileSync("git", ["log", "-1", `--format=%(trailers:key=${trailerKey},valueonly)`], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim()
    const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
    return { hash, trailer: trailer || null, files }
  } catch {
    return null
  }
}

/** 按 trailer 过滤归属提交的触碰文件(多 agent 同分支归因;taskTrailer=on 时启用) */
export function touchedByTaskTrailer(cwd: string, sinceCommit: string, trailerKey: string, taskId: number): string[] {
  const files = new Set<string>()
  try {
    const log = execFileSync(
      "git",
      ["log", "--format=%H%x00%(trailers:key=" + trailerKey + ",valueonly)", `${sinceCommit}..HEAD`],
      { cwd, stdio: ["ignore", "pipe", "ignore"] }
    ).toString()
    const mine: string[] = []
    for (const line of log.split("\n")) {
      const [hash, trailer] = line.split("\0")
      if (hash && trailer?.trim() === `#${taskId}`) mine.push(hash)
    }
    for (const hash of mine) {
      const out = execFileSync("git", ["show", "--name-only", "--format=", hash], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"]
      }).toString()
      for (const line of out.split("\n")) if (line.trim()) files.add(line.trim())
    }
  } catch {
    /* fail-open */
  }
  return [...files]
}
