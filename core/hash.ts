import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".workbench"])
const IGNORE_FILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", ".DS_Store", "Thumbs.db"])

function sha1(input: Buffer | string): string {
  return createHash("sha1").update(input).digest("hex")
}

/** 二进制嗅探:前 8KB 含 null 字节即视为二进制 */
function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/**
 * 文件 hash。文本文件先做换行归一(CRLF/CR → LF),
 * 避免 git autocrlf 在 Windows 上造成幻影失效;二进制原样。
 */
export function hashFile(absPath: string): string {
  const buf = readFileSync(absPath)
  if (isBinary(buf)) return sha1(buf)
  return sha1(buf.toString("utf-8").replace(/\r\n?/g, "\n"))
}

/**
 * 目录聚合 hash:按相对路径排序,逐文件 hash 组成清单,再对清单整体 sha1。
 * 任何一个文件的增删改都会改变结果。
 */
export function hashDirectory(absDir: string): string {
  const entries: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (IGNORE_DIRS.has(name) || IGNORE_FILES.has(name)) continue
      const full = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full, relPath)
      } else {
        entries.push(`${relPath}:${hashFile(full)}`)
      }
    }
  }
  walk(absDir, "")
  return sha1(entries.join("\n"))
}

/** 文件走文件 hash,目录走聚合 hash;不存在返回 null */
export function hashPath(absPath: string): string | null {
  if (!existsSync(absPath)) return null
  return statSync(absPath).isDirectory() ? hashDirectory(absPath) : hashFile(absPath)
}
