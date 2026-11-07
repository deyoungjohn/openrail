import Image from "next/image";
import { copy } from "@/copy";

/**
 * The wordmark (the O with its orbit, then "Openrail"). It is one flat blue (`#3F46FE`, the accent in both
 * themes), so it reads on the white page and on the black one. Nothing else draws the brand: shells,
 * the landing page and the receipts use this component.
 */
export function Brand({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/wordmark.svg"
      alt={copy.brand}
      width={1430}
      height={478}
      priority
      unoptimized
      className={className ?? "h-8 w-auto"}
    />
  );
}

/** The mark alone (the O with its orbit), for the collapsed sidebar and other small spaces. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/mark.svg"
      alt=""
      aria-hidden
      width={144}
      height={115}
      unoptimized
      className={className ?? "h-6 w-auto"}
    />
  );
}
