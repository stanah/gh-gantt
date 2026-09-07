import { z } from "zod";

export interface Comment {
  id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
}

/**
 * Issue コメントのキャッシュファイル (comments.json)。
 *
 * - `fetched_at`: task ID ごとのローカル取得時刻
 * - `issue_updated_at`: 取得時点で観測した Issue の updated_at。
 *   次回 pull で tasks の updated_at と一致すれば GitHub API を呼ばずにスキップする
 * - version "1" には `issue_updated_at` がなく、読み込み時に空として補完する
 */
export interface CommentsFile {
  version: "2";
  fetched_at: Record<string, string>;
  issue_updated_at: Record<string, string>;
  comments: Record<string, Comment[]>;
}

const CommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const CommentsFileV1Schema = z.object({
  version: z.literal("1"),
  fetched_at: z.record(z.string()),
  comments: z.record(z.array(CommentSchema)),
});

const CommentsFileV2Schema = z.object({
  version: z.literal("2"),
  fetched_at: z.record(z.string()),
  issue_updated_at: z.record(z.string()),
  comments: z.record(z.array(CommentSchema)),
});

/** version 1 / 2 の両方を受理し、常に version 2 の形へ正規化する。 */
export const CommentsFileSchema: z.ZodType<CommentsFile, z.ZodTypeDef, unknown> = z.union([
  CommentsFileV2Schema,
  CommentsFileV1Schema.transform(
    (legacy): CommentsFile => ({
      version: "2",
      fetched_at: legacy.fetched_at,
      issue_updated_at: {},
      comments: legacy.comments,
    }),
  ),
]);
