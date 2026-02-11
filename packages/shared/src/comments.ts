import { z } from "zod";

export interface Comment {
  id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface CommentsFile {
  version: "1";
  fetched_at: Record<string, string>;
  comments: Record<string, Comment[]>;
}

const CommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const CommentsFileSchema = z.object({
  version: z.literal("1"),
  fetched_at: z.record(z.string()),
  comments: z.record(z.array(CommentSchema)),
});
