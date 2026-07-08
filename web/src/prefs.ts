import { createContext, useContext } from "react"

export type Lang = "zh" | "en"
export type ThemeMode = "dark" | "light"

export interface UiPrefs {
  lang: Lang
  theme: ThemeMode
  setLang: (l: Lang) => void
  setTheme: (t: ThemeMode) => void
}

export const UiPrefsCtx = createContext<UiPrefs>({
  lang: "zh",
  theme: "dark",
  setLang: () => {},
  setTheme: () => {}
})

export const useUiPrefs = () => useContext(UiPrefsCtx)
