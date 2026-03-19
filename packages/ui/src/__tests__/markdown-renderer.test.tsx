import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../components/MarkdownRenderer.js";

describe("MarkdownRenderer", () => {
  it("renders headings, paragraphs, inline code, and links", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer markdown={"# Title\n\nParagraph with `inline` and [link](https://example.com)."} />,
    );

    expect(html).toContain("<h1");
    expect(html).toContain("Title");
    expect(html).toContain("<p");
    expect(html).toContain("<code");
    expect(html).toContain("inline");
    expect(html).toContain('href="https://example.com"');
  });

  it("renders fenced code blocks with language class", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer markdown={"```ts\nconst x = 1;\n```"} />,
    );

    expect(html).toContain("<pre");
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain("const x = 1;");
  });

  it("renders unordered, ordered, and checklist items", () => {
    const markdown = [
      "- item a",
      "- [x] done item",
      "- [ ] todo item",
      "",
      "1. first",
      "2. second",
    ].join("\n");

    const html = renderToStaticMarkup(<MarkdownRenderer markdown={markdown} />);

    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("done item");
    expect(html).toContain("todo item");
  });

  it("renders blockquote and table", () => {
    const markdown = [
      "> quote text",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| a | 1 |",
      "| b | 2 |",
    ].join("\n");

    const html = renderToStaticMarkup(<MarkdownRenderer markdown={markdown} />);

    expect(html).toContain("<blockquote");
    expect(html).toContain("quote text");
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<tbody");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("does not interpret raw HTML and blocks unsafe javascript links", () => {
    const markdown = "<script>alert(1)</script>\n\n[bad](javascript:alert(1))";
    const html = renderToStaticMarkup(<MarkdownRenderer markdown={markdown} />);

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('href="javascript:alert(1)"');
  });
});
