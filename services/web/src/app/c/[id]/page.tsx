import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ComponentType } from "react";
import { PublicShell } from "@/components/shell/public-shell";
import { enabledModules } from "@/enabled";

export const metadata: Metadata = { title: "Pay order", robots: { index: false } };

type OrderPage = ComponentType<{ id: string }>;

interface OrderModule {
  PublicOrderPage?: OrderPage;
  resolveClaimKind?: (id: string) => Promise<number | null>;
}

const moduleEntry = enabledModules
  .map((entry) => entry.module as OrderModule | null)
  .find(
    (candidate): candidate is OrderModule & { PublicOrderPage: OrderPage } =>
      candidate?.PublicOrderPage !== undefined,
  );

const PageComponent: OrderPage | undefined = moduleEntry?.PublicOrderPage;

/**
 * Resolves older invoice pay links (`/c/<id>` for kind-0 claims) by redirecting to `/pay/<id>`.
 * Checkouts (kind-1 claims) stay on `/c/<id>` and render the checkout page.
 * When `checkout` is disabled, redirects to `/pay/<id>` as core does.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Case 1: when checkout is disabled, redirect as core does
  if (PageComponent === undefined) {
    redirect(`/pay/${encodeURIComponent(id)}`);
  }

  // Case 2: when the id is a claim of kind 0 (an invoice), redirect to /pay/<id>
  const kind = moduleEntry?.resolveClaimKind ? await moduleEntry.resolveClaimKind(id) : null;
  if (kind === 0) {
    redirect(`/pay/${encodeURIComponent(id)}`);
  }

  // Case 3: when it is a checkout (kind 1), show the checkout
  return (
    <PublicShell wide>
      <PageComponent id={id} />
    </PublicShell>
  );
}
