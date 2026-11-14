import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_ORDER } from "./nav";

const DIR = join(process.cwd(), "content", "docs");

/** A page's Markdown, read at build time (the docs are static pages). */
export function readDoc(slug: string): string | null {
  if (!DOC_ORDER.some((d) => d.slug === slug)) return null;
  try {
    return readFileSync(join(DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
}

/** Plain text of every page, for the search box (title, headings and body). */
export function searchIndex(): { slug: string; title: string; text: string }[] {
  return DOC_ORDER.map((d) => {
    const src = readDoc(d.slug) ?? "";
    const text = src
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#>*`|[\]()_-]/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 4000);
    return { slug: d.slug, title: d.title, text };
  });
}
