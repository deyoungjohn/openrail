import type { Metadata } from "next";
import { DocPage, docMeta } from "@/components/docs/doc-page";

export const metadata: Metadata = docMeta("introduction");

export default function DocsHome() {
  return <DocPage slug="introduction" />;
}
