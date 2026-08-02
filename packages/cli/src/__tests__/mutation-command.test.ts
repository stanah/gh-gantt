import { afterEach, describe, expect, it, vi } from "vitest";
import { createMutationCommand } from "../commands/mutation.js";

describe("mutation JSON CLI契約", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("execute/showだけを公開し、JSON commandをcontrol planeへ委譲する", async () => {
    const execute = vi.fn(async () => ({
      schemaVersion: "1" as const,
      accepted: true,
      commandId: "command-1",
      commandFingerprint: "a".repeat(64),
      proposalId: "proposal-1",
      revision: 1,
      status: "awaiting_human" as const,
      stateUnchanged: false,
      errorCode: null,
      diagnostic: null,
      changedTaskIds: [],
      successorPlanRevision: null,
    }));
    const inspect = vi.fn(async () => ({
      schemaVersion: "1" as const,
      total: 1,
      limit: 5,
      offset: 0,
      truncated: false,
      items: [],
      approvalRequests: [
        {
          purpose: "replan" as const,
          proposalId: "proposal-1",
          revision: 3,
          proposalFingerprint: "b".repeat(64),
          expiresAt: "2026-08-03T00:00:00.000Z",
          issueUrl: "https://github.com/example/public/issues/1",
          machineBlock: "<!-- gh-gantt:mutation-approval:v1 -->",
        },
      ],
    }));
    const command = createMutationCommand({
      projectRoot: () => "/fixture",
      createControlPlane: async () => ({ execute, inspect }),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(command.commands.map((item) => item.name())).toEqual(["execute", "show"]);
    const input = {
      schemaVersion: "1",
      commandId: "command-1",
      type: "propose",
      actor: { id: "planner-1", role: "planner" },
      originRunId: "run-1",
      intent: {
        kind: "add",
        parentTaskId: null,
        task: { clientId: "child-1", title: "子task", type: "task" },
      },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    };
    await command.parseAsync(["execute", "--input", JSON.stringify(input)], { from: "user" });
    expect(execute).toHaveBeenCalledWith(input);

    await command.parseAsync(["show", "proposal-1", "--full", "--limit", "5"], {
      from: "user",
    });
    expect(inspect).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      full: true,
      limit: 5,
      offset: 0,
    });
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('"approvalRequests"'));
  });
});
