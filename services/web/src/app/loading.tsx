import { PageSkeleton } from "@/components/ui/page-skeleton";

// Shown first while any other page (the pay page, a receipt, a link) is on its way.
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <PageSkeleton variant="public" />
    </div>
  );
}
