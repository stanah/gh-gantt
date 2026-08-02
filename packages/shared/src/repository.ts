import { z } from "zod";

/** dispatch contract 全体で共有する正規化済み owner/repo の形式。 */
export const NORMALIZED_REPOSITORY_PATTERN: RegExp =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export const NormalizedRepositorySchema: z.ZodType<string> = z
  .string()
  .regex(NORMALIZED_REPOSITORY_PATTERN);

/** trim と lower-case 化後に正規 owner/repo のみ返す。 */
export function normalizeRepository(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return NORMALIZED_REPOSITORY_PATTERN.test(normalized) ? normalized : null;
}
