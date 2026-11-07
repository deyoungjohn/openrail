import { redirect } from "next/navigation";

/**
 * Older invoice pay links ended in `/c/<claim id>`. They are paid on `/pay/<claim id>`; this keeps them working.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/pay/${encodeURIComponent(id)}`);
}
