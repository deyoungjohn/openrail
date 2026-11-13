"use client";

import { ApiError } from "@openrail/api-client";
import type { ReactNode } from "react";
import { copy } from "@/copy";
import { client } from "@/lib/client";
import { useAsync } from "@/lib/use-async";
import { EmptyState, ErrorState, Skeleton } from "../ui/state";
import { PayScreen } from "./pay-screen";

/**
 * A public invoice link carries the invoice's own reference (`/<business>/inv/<ref>`), not the claim counter. This
 * finds the claim it belongs to, then shows the page for that claim. The business part of the link is only for
 * reading and is not checked.
 */
export function InvoiceRef({
  invoiceRef,
  children,
}: {
  invoiceRef: string;
  children: (tokenId: string) => ReactNode;
}) {
  const p = copy.pay;
  const [found, retry] = useAsync(
    () =>
      client.pay
        .getClaim(invoiceRef)
        .then((c) => c.token_id)
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }),
    [invoiceRef],
  );
  if (found.state === "loading") return <Skeleton className="h-64 w-full" />;
  if (found.state === "error") return <ErrorState body={p.loadError} onRetry={retry} />;
  if (found.data === null) return <EmptyState title={p.notFoundTitle} body={p.notFoundBody} />;
  return <>{children(found.data)}</>;
}

/** The pay page for an invoice link. */
export function PayByRef({ invoiceRef }: { invoiceRef: string }) {
  return (
    <InvoiceRef invoiceRef={invoiceRef}>{(tokenId) => <PayScreen tokenId={tokenId} />}</InvoiceRef>
  );
}
