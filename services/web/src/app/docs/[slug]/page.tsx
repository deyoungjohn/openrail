import type { Metadata } from "next";
import { DocPage, docMeta } from "@/components/docs/doc-page";
import { DOC_ORDER } from "@/lib/docs/nav";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_ORDER.filter((d) => d.slug !== "introduction").map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  return docMeta((await params).slug);
}

export default async function Doc({ params }: { params: Promise<{ slug: string }> }) {
  return <DocPage slug={(await params).slug} />;
}
