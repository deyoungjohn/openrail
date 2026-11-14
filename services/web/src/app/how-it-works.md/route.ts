import { howItWorksMarkdown } from "@/lib/how-it-works";

export const dynamic = "force-static";

/** How it works as Markdown, for agents and language models. */
export function GET() {
  return new Response(howItWorksMarkdown(), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
