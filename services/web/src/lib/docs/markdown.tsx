/**
 * A small Markdown renderer for the docs (no dependency, no raw HTML: every node is React, so nothing in a page can
 * inject markup). Supports headings with anchors, paragraphs, bold/italic/code/links, lists, tables, fenced code (with a
 * copy button), callouts (`> [!NOTE]`, `[!TIP]`, `[!WARNING]`) and rules.
 */
import { AlertTriangle, Info, Lightbulb } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CodeBlock } from "@/components/ui/code-block";

export interface Heading {
  depth: 2 | 3;
  text: string;
  id: string;
}

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Inline: `code`, **bold**, *italic* or _italic_, [text](href). */
function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|((?<!\w)_[^_\s][^_]*_(?!\w))|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (tok.startsWith("`")) {
      out.push(
        <code key={k} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.88em]">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={k} className="font-semibold text-text">
          {inline(tok.slice(2, -2), k)}
        </strong>,
      );
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    } else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const href = lm?.[2] ?? "#";
      const external = /^https?:/.test(href);
      out.push(
        external ? (
          <a
            key={k}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-text underline decoration-accent/40 underline-offset-3 hover:decoration-accent"
          >
            {inline(label, k)}
          </a>
        ) : (
          <Link
            key={k}
            href={href}
            className="font-medium text-accent-text underline decoration-accent/40 underline-offset-3 hover:decoration-accent"
          >
            {inline(label, k)}
          </Link>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const CALLOUT = {
  NOTE: { icon: Info, cls: "border-accent/30 bg-accent-soft/60", tone: "text-accent-text" },
  TIP: { icon: Lightbulb, cls: "border-success/30 bg-success/8", tone: "text-success-text" },
  WARNING: {
    icon: AlertTriangle,
    cls: "border-[#d97706]/35 bg-[#d97706]/8",
    tone: "text-[#b45309] dark:text-[#fbbf24]",
  },
} as const;

/** Parses a page; returns the rendered body and its h2/h3 headings (for "On this page"). */
export function renderMarkdown(src: string): {
  body: ReactNode;
  headings: Heading[];
  title: string;
  lead: string;
} {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  const headings: Heading[] = [];
  let title = "";
  let lead = "";
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Fenced code.
    const fence = /^```(\S*)\s*(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const label = fence[2] || lang || "Code";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) buf.push(lines[i++] ?? "");
      i++;
      nodes.push(<CodeBlock key={key()} label={label} code={buf.join("\n")} className="my-5" />);
      continue;
    }
    // Headings.
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const depth = h[1]!.length;
      const text = h[2]!.trim();
      if (depth === 1) {
        title = text;
        i++;
        // The paragraph right after the title is the page's lead.
        const buf: string[] = [];
        while (i < lines.length && lines[i]!.trim() === "") i++;
        while (i < lines.length && lines[i]!.trim() !== "" && !/^[#>`|-]|^\d+\./.test(lines[i]!))
          buf.push(lines[i++]!);
        lead = buf.join(" ");
        continue;
      }
      const id = slugify(text);
      headings.push({ depth: depth as 2 | 3, text, id });
      nodes.push(
        depth === 2 ? (
          <h2
            key={key()}
            id={id}
            className="group mt-14 scroll-mt-24 border-t border-border pt-10 text-[26px] leading-tight font-bold tracking-[-0.02em] first:mt-6 first:border-0 first:pt-0"
          >
            <a href={`#${id}`} className="hover:text-accent-text">
              {inline(text)}
            </a>
          </h2>
        ) : (
          <h3
            key={key()}
            id={id}
            className="mt-9 scroll-mt-24 text-[19px] leading-snug font-semibold"
          >
            <a href={`#${id}`} className="hover:text-accent-text">
              {inline(text)}
            </a>
          </h3>
        ),
      );
      i++;
      continue;
    }
    // Rule.
    if (/^---+\s*$/.test(line)) {
      nodes.push(<hr key={key()} className="my-10 border-border" />);
      i++;
      continue;
    }
    // Callout or quote.
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">"))
        buf.push(lines[i++]!.replace(/^>\s?/, ""));
      const kind = /^\[!(NOTE|TIP|WARNING)\]/.exec(buf[0] ?? "")?.[1] as
        keyof typeof CALLOUT | undefined;
      const text = (kind ? buf.slice(1) : buf).join(" ").trim();
      const c = CALLOUT[kind ?? "NOTE"];
      nodes.push(
        <div
          key={key()}
          className={`my-6 flex gap-3 rounded-2xl border px-4 py-3.5 text-[15px] leading-7 ${c.cls}`}
        >
          <c.icon aria-hidden size={18} className={`mt-1 shrink-0 ${c.tone}`} />
          <p>{inline(text)}</p>
        </div>,
      );
      continue;
    }
    // Table.
    if (line.startsWith("|") && /^\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) rows.push(cells(lines[i++]!));
      nodes.push(
        <div key={key()} className="my-6 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-left text-[14px]">
            <thead className="bg-surface-2">
              <tr>
                {head.map((c, j) => (
                  <th key={j} className="px-4 py-2.5 font-semibold">
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-t border-border align-top">
                  {r.map((c, j) => (
                    <td key={j} className="px-4 py-2.5 leading-6 text-muted">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // Lists.
    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^(\s*)([-*]|\d+\.)\s+/.test(lines[i] ?? "")) {
        let item = lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, "");
        i++;
        // A wrapped line belongs to the item above.
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i] ?? "") &&
          !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)
        )
          item += " " + lines[i++]!.trim();
        items.push(item);
      }
      const Tag = ordered ? "ol" : "ul";
      nodes.push(
        <Tag
          key={key()}
          className={`my-5 space-y-2 pl-6 text-[16px] leading-7 text-muted ${ordered ? "list-decimal marker:font-semibold marker:text-accent-text" : "list-disc marker:text-accent"}`}
        >
          {items.map((it, j) => (
            <li key={j} className="pl-1">
              {inline(it)}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }
    // Paragraph.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,3}\s|```|>|\||---)/.test(lines[i]!) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)
    )
      buf.push(lines[i++]!.trim());
    nodes.push(
      <p key={key()} className="my-4 text-[16px] leading-7 text-muted">
        {inline(buf.join(" "))}
      </p>,
    );
  }
  return { body: nodes, headings, title, lead };
}
