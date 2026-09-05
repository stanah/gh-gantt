#!/usr/bin/env node
// 説明資料 HTML の単一ファイル契約を検証する。エージェントと workflow が同じ検証を使う。
// 使い方: node skills/gh-gantt-pr/scripts/check-explainer.mjs <file.html>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// srcset は「URL 記述子, URL 記述子」の列。data: URI 自身がカンマを含むので空白で区切り、記述子（1x、2.5x、640w）を除いた残りを URL とみなす
const SRCSET = /<(?:img|source)\b[^>]*\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
function hasExternalSrcset(html) {
  return [...html.matchAll(SRCSET)].some(([, a, b, c]) =>
    (a ?? b ?? c)
      .split(/\s+/)
      .filter((token) => token && !/^\d*\.?\d+[wxh],?$/.test(token))
      .some((url) => !/^data:/i.test(url)),
  );
}

// artifact の直接表示は単一ファイルしか配信しない。別ファイルへの参照は data: URI 以外すべて違反
// SVG の image と use も見る。href は xlink:href にも一致し、#fragment は同一文書内なので許す
const RULES = [
  [
    /<(?:script|link|img|iframe|video|audio|source|object|embed|track|image|use)\b[^>]*\b(?:src|href|poster|data)\s*=\s*["']?(?!data:|#)[^"'\s>]/i,
    "src、href、poster、data に data: URI 以外の参照がある",
  ],
  [hasExternalSrcset, "srcset に data: URI 以外の候補がある"],
  [/@import\b/i, "@import は別ファイルの読み込み"],
  [/url\(\s*["']?(?!data:|#)[^)"'\s]/i, "url() に data: URI と #fragment 以外の参照がある"],
];

/** 違反の一覧を返す。空なら契約を満たす */
export function checkExplainer(html) {
  const problems = /<!doctype\s+html|<html\b/i.test(html) ? [] : ["HTML 文書ではない"];
  for (const [rule, message] of RULES) {
    if (typeof rule === "function" ? rule(html) : rule.test(html)) problems.push(message);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("使い方: node skills/gh-gantt-pr/scripts/check-explainer.mjs <file.html>");
    process.exit(2);
  }
  const problems = checkExplainer(readFileSync(file, "utf8"));
  for (const problem of problems) console.error(`違反: ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
