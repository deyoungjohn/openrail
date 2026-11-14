import { redirect } from "next/navigation";

/** /docs: the documentation lives in the repository for now; this address stays the same when it moves. */
export function GET() {
  redirect("https://github.com/deyoungjohn/openrail/tree/main/docs");
}
