// 工作台 i18n:语言在启动时从 /api/meta 读取(= workbench.config.json 的 language),
// 之后模块级不变。t(中文, English) 按当前语言返回。
export let LANG: "zh" | "en" = "zh"

export function setLang(l: "zh" | "en") {
  LANG = l === "en" ? "en" : "zh"
}

/** t(中文原文, English) —— 按当前语言返回对应文案 */
export function t(zh: string, en: string): string {
  return LANG === "en" ? en : zh
}
