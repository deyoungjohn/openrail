import { copy } from "@/copy";
import { Card } from "../ui/card";
import { EmptyState, ErrorState } from "../ui/state";
import type { ClaimLoad } from "./use-claim";

/** Loading, not-found and error views shared by every screen that opens one invoice. Returns null when ready. */
export function ClaimStates({ load, onRetry }: { load: ClaimLoad; onRetry: () => void }) {
  if (load.state === "loading") return <Card title="" state="loading" />;
  if (load.state === "error")
    return (
      <div className="surface-card">
        <ErrorState body={copy.loadError} onRetry={onRetry} />
      </div>
    );
  if (load.state === "notfound")
    return (
      <div className="surface-card">
        <EmptyState title={copy.notFound.title} body={copy.notFound.body} />
      </div>
    );
  return null;
}
