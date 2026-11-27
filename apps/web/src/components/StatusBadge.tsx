import type { Tone } from "../ui/status"

export const StatusBadge = ({ label, tone = "neutral" }: { label: string; tone?: Tone }) => (
  <span className={`badge badge--${tone}`}>{label}</span>
)
