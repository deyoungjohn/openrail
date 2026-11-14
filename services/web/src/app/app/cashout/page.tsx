import { redirect } from "next/navigation";

/** The page moved to /app/payout (14 Nov); old links still land there. */
export default function Page() {
  redirect("/app/payout");
}
