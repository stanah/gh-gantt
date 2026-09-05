#!/usr/bin/env node
// インタラクティブな単一 HTML の説明資料を、project の pr-explainer workflow で公開するための helper。
// HTML の単一ファイル契約を検証し、サイズに応じて輸送路を選び、実行するコマンドを組み立てる。
//
//   - dispatch: `gh workflow run pr-explainer.yml -F pr=<n> -F title=<t> -F html=@<file>`
//               （既定。workflow_dispatch input の総量 65,535 文字の制約内）
//   - branch:   HTML だけを含む孤立コミットを一時 branch `pr-explainer/<n>-<時刻>` に push し、
//               `-F source_branch=<branch>` で workflow に渡す（64KB 超の fallback。workflow が branch を削除する）
//
// 使い方:
//   node skills/gh-gantt-pr/scripts/pr-explainer-publish.mjs <input.html> --pr <number> [--title <title>]
//        [--workflow <file>] [--mode auto|dispatch|branch] [--run]
//
// 既定では検証結果と実行予定のコマンドを JSON で出力するだけで、何も実行しない（dry-run）。
// `--run` を付けると `gh` と `git` を順に実行する。PR 本文やコメントに HTML は書き込まない。
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** workflow_dispatch input 総量 65,535 文字の内側で、pr / title / 余白を除いた HTML の上限 */
export const DISPATCH_MAX_CHARS = 60_000;
export const DEFAULT_WORKFLOW = "pr-explainer.yml";
const USAGE =
  "使い方: node skills/gh-gantt-pr/scripts/pr-explainer-publish.mjs <input.html> --pr <number> [--title <title>] [--workflow <file>] [--mode auto|dispatch|branch] [--run]";

// 外部リソース参照の検出パターン。通常のリンク (<a href>) は許可する
const EXTERNAL_PATTERNS = [
  {
    label: "script / link / img / iframe / video / audio / source の外部 URL",
    regex:
      /<(?:script|link|img|iframe|video|audio|source)\b[^>]*\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i,
  },
  { label: "CSS の @import", regex: /@import\s+(?:url\()?["']?(?:https?:)?\/\//i },
  { label: "CSS の url(http...)", regex: /url\(\s*["']?(?:https?:)?\/\//i },
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function parseArgs(argv) {
  const positional = [];
  const options = {
    pr: undefined,
    title: "PR 説明資料",
    workflow: DEFAULT_WORKFLOW,
    mode: "auto",
    run: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") {
      options.run = true;
      continue;
    }
    if (arg === "--pr" || arg === "--title" || arg === "--workflow" || arg === "--mode") {
      const value = argv[i + 1];
      if (value === undefined || value.trim() === "") {
        fail(`${arg} には値が必要です\n${USAGE}`);
      }
      options[arg.slice(2)] = value.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      fail(`不明なオプションです: ${arg}\n${USAGE}`);
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    fail(`入力 HTML を 1 つ指定してください\n${USAGE}`);
  }
  if (!/\.html?$/i.test(positional[0])) {
    fail(`入力は .html ファイルを指定してください: ${positional[0]}\n${USAGE}`);
  }
  if (options.pr === undefined || !/^\d+$/.test(options.pr)) {
    fail(`--pr には PR 番号（整数）を指定してください\n${USAGE}`);
  }
  if (!["auto", "dispatch", "branch"].includes(options.mode)) {
    fail(`--mode は auto / dispatch / branch のいずれかです: ${options.mode}\n${USAGE}`);
  }
  if (/\r?\n/.test(options.title)) {
    fail("--title に改行を含めることはできません");
  }
  return { input: resolve(positional[0]), ...options, pr: Number(options.pr) };
}

/** HTML が単一ファイル契約を満たすか検証し、違反があれば理由の配列を返す */
export function validateHtml(html) {
  const problems = [];
  if (!/<!doctype\s+html|<html\b/i.test(html)) {
    problems.push("HTML 文書ではありません（<!doctype html> または <html> が必要）");
  }
  for (const { label, regex } of EXTERNAL_PATTERNS) {
    if (regex.test(html)) {
      problems.push(`外部リソースを参照しています: ${label}`);
    }
  }
  return problems;
}

/** サイズと指定から輸送路を決める */
export function chooseMode(htmlLength, requested) {
  if (requested === "dispatch") {
    if (htmlLength > DISPATCH_MAX_CHARS) {
      return {
        error: `HTML が ${htmlLength} 文字で dispatch の上限 ${DISPATCH_MAX_CHARS} 文字を超えています。--mode branch を使ってください`,
      };
    }
    return { mode: "dispatch" };
  }
  if (requested === "branch") return { mode: "branch" };
  return { mode: htmlLength > DISPATCH_MAX_CHARS ? "branch" : "dispatch" };
}

/** 一時 branch 名。同名衝突を避けるため時刻を付ける */
export function temporaryBranchName(pr, now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `pr-explainer/${pr}-${stamp}`;
}

/**
 * 実行するコマンド列を組み立てる。各要素は argv 配列で、shell を介さずに実行する。
 * branch モードの `commit-tree` は前段の出力に依存するため、実行時に埋める placeholder を使う。
 */
export function buildPlan({ mode, pr, title, workflow, input, branch }) {
  if (mode === "dispatch") {
    return [
      {
        argv: [
          "gh",
          "workflow",
          "run",
          workflow,
          "-F",
          `pr=${pr}`,
          "-F",
          `title=${title}`,
          "-F",
          `html=@${input}`,
        ],
      },
    ];
  }
  return [
    { argv: ["git", "hash-object", "-w", input], capture: "blob" },
    { argv: ["git", "mktree"], stdin: "100644 blob {blob}\texplainer.html\n", capture: "tree" },
    {
      argv: [
        "git",
        "commit-tree",
        "{tree}",
        "-m",
        `pr-explainer: PR #${pr} の説明資料（一時 branch）`,
      ],
      capture: "commit",
    },
    { argv: ["git", "push", "origin", `{commit}:refs/heads/${branch}`] },
    {
      argv: [
        "gh",
        "workflow",
        "run",
        workflow,
        "-F",
        `pr=${pr}`,
        "-F",
        `title=${title}`,
        "-F",
        `source_branch=${branch}`,
      ],
    },
  ];
}

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 人間が読める形のコマンド行（dry-run 表示用） */
export function renderPlan(plan) {
  return plan.map((step) => {
    const line = step.argv.map(shellQuote).join(" ");
    return step.stdin
      ? `printf '${step.stdin.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}' | ${line}`
      : line;
  });
}

function runPlan(plan) {
  const captured = {};
  const fill = (value) => value.replace(/\{(\w+)\}/g, (_, key) => captured[key] ?? "");
  for (const step of plan) {
    const argv = step.argv.map(fill);
    const result = spawnSync(argv[0], argv.slice(1), {
      input: step.stdin ? fill(step.stdin) : undefined,
      encoding: "utf8",
      stdio: [step.stdin ? "pipe" : "ignore", "pipe", "inherit"],
    });
    if (result.error) {
      fail(`${argv[0]} を実行できません: ${result.error.message}`);
    }
    if (result.status !== 0) {
      fail(`コマンドが失敗しました (exit ${result.status}): ${argv.join(" ")}`);
    }
    if (step.capture) captured[step.capture] = result.stdout.trim();
    else if (result.stdout) process.stdout.write(result.stdout);
  }
  return captured;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let html;
  try {
    html = await readFile(args.input, "utf-8");
  } catch {
    fail(`入力 HTML を読み込めません: ${args.input}`);
  }

  const problems = validateHtml(html);
  if (problems.length > 0) {
    fail(`説明資料の契約に違反しています:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }

  const chosen = chooseMode(html.length, args.mode);
  if (chosen.error) fail(chosen.error);

  const branch = chosen.mode === "branch" ? temporaryBranchName(args.pr) : undefined;
  const plan = buildPlan({ ...args, mode: chosen.mode, branch });

  if (args.run) {
    runPlan(plan);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        input: args.input,
        pr: args.pr,
        title: args.title,
        htmlChars: html.length,
        mode: chosen.mode,
        branch: branch ?? null,
        executed: args.run,
        commands: renderPlan(plan),
      },
      null,
      2,
    )}\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  main().catch((error) => {
    fail(
      `公開コマンドの組み立てに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
