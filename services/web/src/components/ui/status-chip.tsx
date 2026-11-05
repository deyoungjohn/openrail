import {
  Ban,
  CheckCircle2,
  Clock,
  FileEdit,
  PieChart,
  ThumbsUp,
  TimerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";

export type Status =
  | { kind: "draft" }
  | { kind: "sent" }
  | { kind: "acknowledged" }
  | { kind: "partial"; due?: string }
  | { kind: "paid" }
  | { kind: "overdue"; days: number }
  | { kind: "closed" }
  | { kind: "cancelled" }
  | { kind: "late" };

type Tone = "grey" | "info" | "accent" | "warning" | "success" | "danger";

const tones: Record<Tone, string> = {
  grey: "text-muted bg-surface-2",
  info: "text-info bg-surface-2",
  accent: "text-accent-text bg-accent-soft",
  warning: "text-warning bg-surface-2",
  success: "text-success-text bg-surface-2",
  danger: "text-danger-text bg-surface-2",
};

function describe(s: Status): { label: string; tone: Tone; Icon: LucideIcon } {
  switch (s.kind) {
    case "draft":
      return { label: copy.status.draft, tone: "grey", Icon: FileEdit };
    case "sent":
      return { label: copy.status.sent, tone: "info", Icon: Clock };
    case "acknowledged":
      return { label: copy.status.acknowledged, tone: "accent", Icon: ThumbsUp };
    case "partial":
      return {
        label: s.due ? copy.status.partial(s.due) : copy.status.partialNoAmount,
        tone: "warning",
        Icon: PieChart,
      };
    case "paid":
      return { label: copy.status.paid, tone: "success", Icon: CheckCircle2 };
    case "overdue":
      return { label: copy.status.overdue(s.days), tone: "danger", Icon: TriangleAlert };
    case "closed":
      return { label: copy.status.closed, tone: "grey", Icon: Ban };
    case "cancelled":
      return { label: copy.status.cancelled, tone: "grey", Icon: Ban };
    case "late":
      return { label: copy.status.late, tone: "warning", Icon: TimerOff };
  }
}

export function StatusChip({ status }: { status: Status }) {
  const { label, tone, Icon } = describe(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] leading-5 font-medium whitespace-nowrap",
        tones[tone],
      )}
    >
      <Icon size={14} strokeWidth={1.5} aria-hidden />
      {label}
    </span>
  );
}
