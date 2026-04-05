import { describe, it, expect } from "vitest";
import { buildProgram } from "../program.js";

describe("[FR-CLI-006-AC1] init/pull/push/status/create/list/show/update/link/serve/conflicts/resolve コマンドが定義されている", () => {
  const program = buildProgram();
  const commandNames = program.commands.map((c) => c.name());

  // --- フラット化されたトップレベルコマンド ---

  it("has 'list' as a top-level command", () => {
    expect(commandNames).toContain("list");
  });

  it("has 'show' as a top-level command", () => {
    expect(commandNames).toContain("show");
  });

  it("has 'update' as a top-level command", () => {
    expect(commandNames).toContain("update");
  });

  it("has 'link' as a top-level command", () => {
    expect(commandNames).toContain("link");
  });

  // --- 既存のトップレベルコマンドは維持 ---

  it("keeps existing top-level commands", () => {
    for (const name of [
      "init",
      "pull",
      "push",
      "status",
      "serve",
      "create",
      "conflicts",
      "resolve",
    ]) {
      expect(commandNames).toContain(name);
    }
  });

  // --- 後方互換: task サブコマンドがエイリアスとして残る ---

  it("has 'task' as a backward-compat alias group", () => {
    expect(commandNames).toContain("task");
    const taskCmd = program.commands.find((c) => c.name() === "task")!;
    const taskSubNames = taskCmd.commands.map((c) => c.name());
    expect(taskSubNames).toContain("list");
    expect(taskSubNames).toContain("show");
    expect(taskSubNames).toContain("update");
    expect(taskSubNames).toContain("link");
  });

  // --- milestone サブコマンドは廃止 ---

  it("does not have 'milestone' as a top-level command", () => {
    expect(commandNames).not.toContain("milestone");
  });

  // --- トップレベルとエイリアスのコマンドは独立したインスタンス ---

  it("top-level and task-alias commands are distinct instances", () => {
    const taskCmd = program.commands.find((c) => c.name() === "task")!;
    for (const name of ["list", "show", "update", "link"]) {
      const topLevel = program.commands.find((c) => c.name() === name);
      const alias = taskCmd.commands.find((c) => c.name() === name);
      expect(topLevel).not.toBe(alias);
    }
  });
});
