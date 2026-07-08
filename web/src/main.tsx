import { ConfigProvider, theme } from "antd"
import enUS from "antd/locale/en_US"
import zhCN from "antd/locale/zh_CN"
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { LANG, setLang } from "./i18n"
import { ACCENT, SURFACE } from "./ui"
import "./styles.css"

// 启动时从 /api/meta 读语言(= workbench.config.json 的 language),定 UI 语言后再渲染
async function boot() {
  try {
    const meta = await fetch("/api/meta").then(r => r.json())
    if (meta?.language === "en") setLang("en")
  } catch {
    /* 拿不到就默认中文 */
  }
  render()
}

function render() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ConfigProvider
        locale={LANG === "en" ? enUS : zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: ACCENT,
          colorInfo: ACCENT,
          colorBgBase: SURFACE.canvas,
          colorBgContainer: SURFACE.panel,
          colorBgElevated: SURFACE.raised,
          colorBgLayout: SURFACE.canvas,
          colorBorder: SURFACE.lineStrong,
          colorBorderSecondary: SURFACE.line,
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
    </React.StrictMode>
  )
}

boot()
