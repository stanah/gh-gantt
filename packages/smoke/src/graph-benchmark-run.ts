#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { analyzeGraphBenchmark } from "./graph-benchmark.js";

export interface GraphBenchmarkCliIo {
  readText(path: string): Promise<string>;
  writeText(path: string, value: string): Promise<void>;
  stdout(value: string): void;
  stderr(value: string): void;
}

interface GraphBenchmarkCliOptions {
  input: string;
  output: string | null;
  requireQualified: boolean;
}

const USAGE = [
  "使い方: pnpm benchmark:graph -- --input <record.json> [--output <report.json>] [--require-qualified]",
  "",
  "外部 runner の bounded observation を検証・比較する。agent や任意 shell command は実行しない。",
].join("\n");

function parseArgs(argv: string[]): GraphBenchmarkCliOptions | "help" {
  let input: string | null = null;
  let output: string | null = null;
  let requireQualified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--require-qualified") {
      requireQualified = true;
      continue;
    }
    if (argument === "--input" || argument === "--output") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} には path が必要です`);
      }
      if (argument === "--input") input = value;
      else output = value;
      index += 1;
      continue;
    }
    throw new Error(`未対応の引数です: ${argument}`);
  }

  if (input === null) throw new Error("--input は必須です");
  return { input, output, requireQualified };
}

const defaultIo: GraphBenchmarkCliIo = {
  readText: (path) => readFile(resolve(path), "utf8"),
  writeText: (path, value) => writeFile(resolve(path), value, "utf8"),
  stdout: (value) => console.log(value),
  stderr: (value) => console.error(value),
};

/**
 * benchmark CLI の副作用を file I/O と表示だけに限定する。
 * 成功 report には入力 evidence の本文や URI を含めない。
 */
export async function runGraphBenchmarkCli(
  argv: string[],
  io: GraphBenchmarkCliIo = defaultIo,
): Promise<number> {
  let options: GraphBenchmarkCliOptions | "help";
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(USAGE);
    return 2;
  }

  if (options === "help") {
    io.stdout(USAGE);
    return 0;
  }

  try {
    const input = JSON.parse(await io.readText(options.input)) as unknown;
    const report = analyzeGraphBenchmark(input);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output === null) {
      io.stdout(serialized.trimEnd());
    } else {
      await io.writeText(options.output, serialized);
      io.stdout(
        `Graph benchmark: mode=${report.qualification.mode} pairs=${report.coverage.completePairCount}`,
      );
    }
    if (options.requireQualified && report.qualification.mode !== "graph_candidate") {
      io.stderr(`Graph qualification failed: ${report.qualification.reasons.join(", ")}`);
      return 1;
    }
    return 0;
  } catch (error) {
    io.stderr(`Graph benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  void runGraphBenchmarkCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
