import { ConfigProvider, theme as antdTheme } from "antd"
import enUS from "antd/locale/en_US"
import zhCN from "antd/locale/zh_CN"
import React, { useState } from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { setLang as applyLang } from "./i18n"
import { type Lang, type ThemeMode, UiPrefsCtx } from "./prefs"
import { ACCENT, SEED } from "./ui"
import "./styles.css"

function Root({ initialLang, initialTheme }: { initialLang: Lang; initialTheme: ThemeMode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme)

  const setLang = (l: Lang) => {
    applyLang(l) // 同步更新 i18n 模块变量,使本次 re-render 的 t() 即为新语言
    localStorage.setItem("wb-lang", l)
    setLangState(l)
  }
  const setTheme = (t: ThemeMode) => {
    document.documentElement.dataset.theme = t // 翻转 CSS 变量(内联样式随之变)
    localStorage.setItem("wb-theme", t)
    setThemeState(t)
  }

  const seed = SEED[theme]
  return (
    <UiPrefsCtx.Provider value={{ lang, theme, setLang, setTheme }}>
      <ConfigProvider
        locale={lang === "en" ? enUS : zhCN}
        theme={{
          algorithm: theme === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: ACCENT,
            colorInfo: ACCENT,
            colorBgBase: seed.canvas,
            colorBgContainer: seed.panel,
            colorBgElevated: seed.raised,
            colorBgLayout: seed.canvas,
            colorBorder: seed.lineStrong,
            colorBorderSecondary: seed.line,
            borderRadius: 8,
            fontSize: 15,
            controlHeight: 36,
            sizeUnit: 5,
            sizeStep: 5,
            fontFamily:
              '-apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, "PingFang SC", "Microsoft YaHei", sans-serif'
          },
          components: {
            Tree: { indentSize: 20 },
            Tabs: { horizontalMargin: "0 0 12px 0" },
            Drawer: { paddingLG: 20 }
          }
        }}
      >
        <App />
      </ConfigProvider>
    </UiPrefsCtx.Provider>
  )
}

// 启动:语言取 localStorage → 否则 /api/meta(config.language)→ 否则 zh;主题取 localStorage → 否则 dark
async function boot() {
  let lang = localStorage.getItem("wb-lang") as Lang | null
  if (lang !== "zh" && lang !== "en") {
    try {
      const meta = await fetch("/api/meta").then(r => r.json())
      lang = meta?.language === "en" ? "en" : "zh"
    } catch {
      lang = "zh"
    }
  }
  const theme: ThemeMode = localStorage.getItem("wb-theme") === "light" ? "light" : "dark"
  applyLang(lang)
  document.documentElement.dataset.theme = theme

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Root initialLang={lang} initialTheme={theme} />
    </React.StrictMode>
  )
}

boot()
