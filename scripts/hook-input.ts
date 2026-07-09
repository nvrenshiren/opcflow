/**
 * 多平台 hook 入参归一。各平台传给 hook 的 stdin JSON / 项目根环境变量各不相同,
 * 优先走 core/platforms.ts 的 adapter(已知平台的精确字段名);adapter 未传入或未命中时,
 * 兜底按全部已知形状扫一遍(防御式提取,各平台版本可能微调字段名,宁可多试探不可漏判)。
 */
import type { PlatformAdapter } from "../core/platforms"

export function hookPlatform(): string {
  const arg = process.argv.find(a => a.startsWith("--platform="))
  return arg ? arg.slice("--platform=".length) : "claude"
}

/** 从 hook stdin JSON 里提取被操作文件路径(adapter 优先,跨平台字段兜底) */
export function extractFilePath(input: any, adapter?: PlatformAdapter): string | undefined {
  const fromAdapter = adapter?.parseHookInput(input).filePath
  if (fromAdapter) return fromAdapter
  return (
    input?.tool_input?.file_path ?? // claude PreToolUse/PostToolUse
    input?.tool_input?.filePath ??
    input?.file_path ?? // cursor afterFileEdit / 通用
    input?.filePath ??
    input?.args?.file_path ?? // opencode tool 参数
    input?.args?.filePath ??
    input?.arguments?.file_path ?? // codex 兜底
    input?.arguments?.filePath ??
    input?.input?.file_path ??
    undefined
  )
}

/**
 * 项目根:优先用 adapter 声明的环境变量名;保留全平台已知 env 链兜底——
 * 不带 adapter 的调用方(如 hook-refresh 的旧路径)与错传 platform 的场景不得回归,
 * 否则 hook 落到 cwd,openWorkbench 会在错误目录静默新建 .workbench。
 */
export function hookProjectDir(adapter?: PlatformAdapter): string | undefined {
  return (
    (adapter && process.env[adapter.projectDirEnvVar]) ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.env.CODEX_PROJECT_DIR ??
    process.env.CURSOR_PROJECT_DIR ??
    process.env.OPENCODE_PROJECT_DIR ??
    process.env.WORKBENCH_PROJECT ??
    undefined
  )
}

/** 读取 stdin 全部内容并 JSON 解析(失败返回 {}) */
export async function readStdinJson(): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"))
  } catch {
    return {}
  }
}
