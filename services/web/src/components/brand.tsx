import { copy } from "@/copy";

/**
 * The product name, set in the interface font. There is no logo or wordmark yet; when one exists
 * this is the only place to change (shells use it, nothing else draws the brand).
 */
export function Brand({ className }: { className?: string }) {
  return <span className={className ?? "text-[18px] leading-6 font-semibold"}>{copy.brand}</span>;
}
