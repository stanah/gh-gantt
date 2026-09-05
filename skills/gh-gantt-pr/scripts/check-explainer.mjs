#!/usr/bin/env node
// 説明資料 HTML の単一ファイル契約を検証する。エージェントと workflow が同じ検証を使う。
// 使い方: node skills/gh-gantt-pr/scripts/check-explainer.mjs <file.html>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// artifact の直接表示は単一ファイルしか配信しない。別ファイルへの参照は data: URI 以外すべて違反
const RULES = [
  [
    /<(?:script|link|img|iframe|video|audio|source|object|embed|track)\b[^>]*\b(?:src|href|srcset|poster|data)\s*=\s*["']?(?!data:)[^"'\s>]/i,
    "src、href、srcset、poster、data に data: URI 以外の参照がある",
  ],
  [/@import\b/i, "@import は別ファイルの読み込み"],
  [/url\(\s*["']?(?!data:|#)[^)"'\s]/i, "url() に data: URI と #fragment 以外の参照がある"],
];

/** 違反の一覧を返す。空なら契約を満たす */
export function checkExplainer(html) {
  const problems = /<!doctype\s+html|<html\b/i.test(html) ? [] : ["HTML 文書ではない"];
  for (const [regex, message] of RULES) if (regex.test(html)) problems.push(message);
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
