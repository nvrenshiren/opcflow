/**
 * 设计基元(单一真相源):表面层次 / 强调色 / kind·event 语义色 / 等宽字体。
 * 原则:一个强调色(teal),状态色只用于状态;表面分层靠背景明度不靠阴影。
 */
export const SURFACE = {
  canvas: "#0f1012", // 画布(最底)
  panel: "#17181b", // 面板(侧栏/卡片)
  raised: "#1d1e23", // 悬浮(表头/引用块)
  line: "#26272d", // 分隔线
  lineStrong: "#2e2f36"
} as const

export const ACCENT = "#2fbdaf"

export const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace'

/** kind → 语义色分组:契约=蓝系 / 架构=紫 / 设计=品红 / 验收=绿 / 代码=青 / 基线=金 / 元产物=灰 */
const KIND_COLOR_MAP: Record<string, string> = {
  baseline: "gold",
  project: "blue",
  roles: "blue",
  glossary: "blue",
  flow: "geekblue",
  "module-prd": "geekblue",
  "page-prd": "geekblue",
  "db-doc": "purple",
  "api-doc": "purple",
  "design-system": "magenta",
  "design-prompt": "magenta",
  prototype: "magenta",
  acceptance: "green",
  code: "cyan"
}

export function kindColor(kind: string): string {
  return KIND_COLOR_MAP[kind] ?? "default"
}

/** 事件类型 → 语义色:通过=绿 / 打回·失败=红 / 失效·撤审=橙 / 送审=金 / 流转=蓝 */
const EVENT_COLOR_MAP: Record<string, string> = {
  approved: "green",
  qa_passed: "green",
  completed: "green",
  rejected: "red",
  qa_failed: "red",
  approval_invalidated: "orange",
  submission_stale: "orange",
  tombstoned: "orange",
  orphan_commit: "orange",
  dispute: "orange",
  submitted: "gold",
  review_spawned: "gold",
  rework_spawned: "gold",
  claimed: "blue",
  created: "blue",
  feedback: "cyan",
  content_changed: "default",
  moved: "default",
  note: "default"
}

export function eventColor(event: string): string {
  return EVENT_COLOR_MAP[event] ?? "default"
}
