import type { Metadata } from "next";
import { IssueScreen } from "@/components/dash/issue-screen";

export const metadata: Metadata = { title: "Create invoice" };

export default function Page() {
  return <IssueScreen />;
}
