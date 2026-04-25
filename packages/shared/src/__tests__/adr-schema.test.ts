import { describe, it, expect } from "vitest";
import { AdrFrontmatterSchema, parseAdrFile } from "../adr-schema.js";

const validFrontmatter = {
  id: "ADR-001",
  title: "同期エンジンに 3-way merge を採用",
  date: "2026-03-20",
  status: "accepted",
  related_requirements: ["FR-SYNC-001", "NFR-SYNC-001"],
};

describe("AdrFrontmatterSchema", () => {
  it("正しい frontmatter を受理する", () => {
    const result = AdrFrontmatterSchema.safeParse(validFrontmatter);
    expect(result.success).toBe(true);
  });

  it("related_requirements を省略しても受理する", () => {
    const { related_requirements: _omit, ...withoutRR } = validFrontmatter;
    const result = AdrFrontmatterSchema.safeParse(withoutRR);
    expect(result.success).toBe(true);
  });

  it("id が ADR-NNN 形式でない場合は reject する", () => {
    const result = AdrFrontmatterSchema.safeParse({ ...validFrontmatter, id: "ADR-1" });
    expect(result.success).toBe(false);
  });

  it("title が空文字列の場合は reject する", () => {
    const result = AdrFrontmatterSchema.safeParse({ ...validFrontmatter, title: "" });
    expect(result.success).toBe(false);
  });

  it("date が YYYY-MM-DD 形式でない場合は reject する", () => {
    const result = AdrFrontmatterSchema.safeParse({ ...validFrontmatter, date: "2026/03/20" });
    expect(result.success).toBe(false);
  });

  it("status が許可された値以外の場合は reject する", () => {
    const result = AdrFrontmatterSchema.safeParse({ ...validFrontmatter, status: "draft" });
    expect(result.success).toBe(false);
  });

  it("status が accepted/superseded/deprecated を全て受理する", () => {
    for (const status of ["accepted", "superseded", "deprecated"] as const) {
      const result = AdrFrontmatterSchema.safeParse({ ...validFrontmatter, status });
      expect(result.success).toBe(true);
    }
  });

  it("related_requirements が文字列配列でない場合は reject する", () => {
    const result = AdrFrontmatterSchema.safeParse({
      ...validFrontmatter,
      related_requirements: [123, 456],
    });
    expect(result.success).toBe(false);
  });
});

describe("parseAdrFile", () => {
  const sampleContent = `---
id: ADR-001
title: 同期エンジンに 3-way merge を採用
date: 2026-03-20
status: accepted
related_requirements:
  - FR-SYNC-001
---

## Context

GitHub Projects との同期で衝突の解決戦略が必要。

## Decision

3-way merge モデルを採用。

## Alternatives

### Last Write Wins

データ消失のリスクが高い。

## Consequences

- snapshot の保持が必要
`;

  it("frontmatter と body を分離する", () => {
    const result = parseAdrFile(sampleContent);
    expect(result.frontmatter.id).toBe("ADR-001");
    expect(result.frontmatter.title).toBe("同期エンジンに 3-way merge を採用");
    expect(result.frontmatter.status).toBe("accepted");
    expect(result.body).toContain("## Context");
    expect(result.body).toContain("## Decision");
  });

  it("frontmatter が無いファイルはエラーにする", () => {
    expect(() => parseAdrFile("## Context\n\nfoo")).toThrow(/frontmatter/);
  });

  it("frontmatter が Zod 検証で reject される値の場合はエラーにする", () => {
    const invalid = `---
id: ADR-1
title: bad
date: 2026-03-20
status: accepted
---

## Context

foo
`;
    expect(() => parseAdrFile(invalid)).toThrow();
  });

  it("body 内の `---` はセクション境界に影響しない", () => {
    const content = `---
id: ADR-002
title: テスト
date: 2026-03-20
status: accepted
---

## Context

ハイフン区切りを含む文字列: ---
`;
    const result = parseAdrFile(content);
    expect(result.frontmatter.id).toBe("ADR-002");
    expect(result.body).toContain("ハイフン区切り");
  });

  it("CRLF 改行 (Windows 改行コード) を受理する", () => {
    const lf = `---
id: ADR-003
title: CRLF テスト
date: 2026-03-20
status: accepted
---

## Context

foo
`;
    const crlf = lf.replace(/\n/g, "\r\n");
    const result = parseAdrFile(crlf);
    expect(result.frontmatter.id).toBe("ADR-003");
    expect(result.body).toContain("## Context");
  });

  it("UTF-8 BOM 付きファイルを受理する", () => {
    const content = `﻿---
id: ADR-004
title: BOM テスト
date: 2026-03-20
status: accepted
---

## Context

foo
`;
    const result = parseAdrFile(content);
    expect(result.frontmatter.id).toBe("ADR-004");
  });
});
