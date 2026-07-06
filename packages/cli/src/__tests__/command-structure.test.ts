import { describe, it, expect } from "vitest";
import { buildProgram } from "../program.js";

describe("[FR-CLI-006-AC1] init/pull/push/status/create/list/show/update/link/delete/close/context/sprint/serve/conflicts/resolve/ac/loop コマンドが定義されている", () => {
  const program = buildProgram();
  const commandNames = program.commands.map((c) => c.name());

  // --- フラット化されたトップレベルコマンド ---

  it("list がトップレベルコマンドとして定義されている", () => {
    expect(commandNames).toContain("list");
  });

  it("show がトップレベルコマンドとして定義されている", () => {
    expect(commandNames).toContain("show");
  });

  it("update がトップレベルコマンドとして定義されている", () => {
    expect(commandNames).toContain("update");
  });

  it("link がトップレベルコマンドとして定義されている", () => {
    expect(commandNames).toContain("link");
  });

  it("[FR-CLI-014-AC3] close がトップレベルコマンドとして定義されている", () => {
    expect(commandNames).toContain("close");
  });

  it("[FR-CLI-016-AC1] close コマンドに --evidence オプションが定義されている", () => {
    const closeCommand = program.commands.find((c) => c.name() === "close")!;
    expect(closeCommand.options.map((option) => option.long)).toContain("--evidence");
  });

  it("[FR-CLI-017-AC1] delete がトップレベルコマンドとして定義され --yes を要求できる", () => {
    expect(commandNames).toContain("delete");
    const deleteCommand = program.commands.find((c) => c.name() === "delete")!;
    expect(deleteCommand.options.map((option) => option.long)).toContain("--yes");
  });

  it("context がトップレベルコマンドとして定義されている", () => {
    expect(commandNames).toContain("context");
  });

  it("sprint がトップレベルコマンドとして定義されている", () => {
    expect(commandNames).toContain("sprint");
  });

  it("ac がトップレベルコマンドとして定義されている", () => {
    expect(commandNames).toContain("ac");
    const acCmd = program.commands.find((c) => c.name() === "ac")!;
    const acSubNames = acCmd.commands.map((c) => c.name());
    expect(acSubNames).toContain("add");
    expect(acSubNames).toContain("check");
  });

  // --- 既存のトップレベルコマンドは維持 ---

  it("既存のトップレベルコマンドを維持している", () => {
    for (const name of [
      "init",
      "pull",
      "push",
      "status",
      "serve",
      "create",
      "conflicts",
      "resolve",
      "loop",
    ]) {
      expect(commandNames).toContain(name);
    }
  });

  // --- 後方互換: task サブコマンドがエイリアスとして残る ---

  it("task が後方互換のエイリアスグループとして定義されている", () => {
    expect(commandNames).toContain("task");
    const taskCmd = program.commands.find((c) => c.name() === "task")!;
    const taskSubNames = taskCmd.commands.map((c) => c.name());
    expect(taskSubNames).toContain("list");
    expect(taskSubNames).toContain("show");
    expect(taskSubNames).toContain("update");
    expect(taskSubNames).toContain("link");
    expect(taskSubNames).toContain("close");
  });

  // --- milestone サブコマンドは廃止 ---

  it("milestone はトップレベルコマンドとして定義されていない", () => {
    expect(commandNames).not.toContain("milestone");
  });

  // --- トップレベルとエイリアスのコマンドは独立したインスタンス ---

  it("トップレベルコマンドと task エイリアス配下のコマンドは別インスタンスである", () => {
    const taskCmd = program.commands.find((c) => c.name() === "task")!;
    for (const name of ["list", "show", "update", "link", "close"]) {
      const topLevel = program.commands.find((c) => c.name() === name);
      const alias = taskCmd.commands.find((c) => c.name() === name);
      expect(topLevel).not.toBe(alias);
    }
  });
});
