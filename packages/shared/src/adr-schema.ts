import { parse } from "yaml";
import { z } from "zod";

export type AdrStatus = "accepted" | "superseded" | "deprecated";

export interface AdrFrontmatter {
  id: string;
  title: string;
  date: string;
  status: AdrStatus;
  related_requirements?: string[];
}

export const AdrFrontmatterSchema: z.ZodType<AdrFrontmatter> = z.object({
  id: z.string().regex(/^ADR-\d{3}$/),
  title: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["accepted", "superseded", "deprecated"]),
  related_requirements: z.array(z.string()).optional(),
});

export interface ParsedAdr {
  frontmatter: AdrFrontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function parseAdrFile(content: string): ParsedAdr {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error("ADR ファイルに frontmatter が見つかりません");
  }
  const rawFrontmatter: unknown = parse(match[1]);
  const frontmatter = AdrFrontmatterSchema.parse(rawFrontmatter);
  return { frontmatter, body: match[2] };
}
