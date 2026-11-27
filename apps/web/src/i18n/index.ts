import i18next from "i18next"
import LanguageDetector from "i18next-browser-languagedetector"
import { initReactI18next } from "react-i18next"
import { en } from "./en"
import { ru } from "./ru"

export const i18n = i18next

export const LANGUAGE_STORAGE_KEY = "intentra.language"

export type Locale = "ru" | "en"

export const isLocale = (value: string): value is Locale => value === "ru" || value === "en"

const syncDocumentLanguage = (language: string): void => {
  if (typeof document === "undefined") return
  document.documentElement.lang = language.startsWith("en") ? "en" : "ru"
}

i18n.on("languageChanged", syncDocumentLanguage)

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      ru: { translation: ru },
      en: { translation: en },
    },
    fallbackLng: "ru",
    supportedLngs: ["ru", "en"],
    load: "languageOnly",
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    },
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  })
