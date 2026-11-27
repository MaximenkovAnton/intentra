export const formatDateTime = (value: string, locale: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

export const formatNumber = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale).format(value)

export const formatDuration = (milliseconds: number, locale: string): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(seconds)
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "minute",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(minutes)
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "hour",
    unitDisplay: "short",
    maximumFractionDigits: 0,
  }).format(Math.round(minutes / 60))
}
