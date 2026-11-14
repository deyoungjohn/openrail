import { notFound } from "next/navigation";
import { DocsShell } from "@/components/docs/docs-shell";
import { readDoc, searchIndex } from "@/lib/docs/load";
import { renderMarkdown } from "@/lib/docs/markdown";
import { DOCS_NAV } from "@/lib/docs/nav";

/** One docs page, rendered from its Markdown at build time. */
export function DocPage({ slug }: { slug: string }) {
  const src = readDoc(slug);
  if (src === null) notFound();
  const { body, headings, title, lead } = renderMarkdown(src);
  const group = DOCS_NAV.find((g) => g.items.some((i) => i.slug === slug))?.group ?? "Docs";
  return (
    <DocsShell
      slug={slug}
      title={title}
      lead={lead}
      group={group}
      headings={headings}
      index={searchIndex()}
    >
      {body}
    </DocsShell>
  );
}

export function docMeta(slug: string): { title: string; description: string } {
  const src = readDoc(slug) ?? "";
  const { title, lead } = renderMarkdown(src);
  return { title: `${title} · Openrail Docs`, description: lead.slice(0, 200) };
}
