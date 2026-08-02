import { Command } from "commander";
import type {
  MutationProposalCommand,
  MutationProposalFullView,
  MutationProposalReceipt,
  MutationProposalView,
} from "@gh-gantt/shared";
import { MutationProposalStore } from "../store/mutation-proposals.js";
import { withProjectStorage } from "../store/project-storage.js";
import { WorkGraphCommandEngine } from "../work-graph/command-engine.js";
import { MutationProposalControlPlane } from "../work-graph/mutation-control-plane.js";
import { ProductionMutationEnvironment } from "../work-graph/production-mutation-environment.js";

interface MutationCommandControlPlane {
  execute(command: unknown): Promise<MutationProposalReceipt>;
  inspect(query: {
    proposalId?: string;
    full?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<MutationProposalView | MutationProposalFullView>;
}

export interface MutationCommandDependencies {
  projectRoot?: () => string;
  createControlPlane?: (projectRoot: string) => Promise<MutationCommandControlPlane>;
}

async function createProductionControlPlane(
  projectRoot: string,
): Promise<MutationCommandControlPlane> {
  const config = await withProjectStorage(
    projectRoot,
    { mode: "read", scope: "workspace" },
    async ({ configStore }) => configStore.read(),
  );
  const engine = new WorkGraphCommandEngine(config);
  return new MutationProposalControlPlane(
    new MutationProposalStore(projectRoot),
    engine,
    new ProductionMutationEnvironment(projectRoot, engine),
  );
}

/** schema-validated JSONだけをproposal control planeへ渡すpublic CLI。 */
export function createMutationCommand(dependencies: MutationCommandDependencies = {}): Command {
  const mutation = new Command("mutation").description(
    "承認付きWork Graph mutation proposalを実行・参照する",
  );
  const control = (projectRoot: string) =>
    dependencies.createControlPlane?.(projectRoot) ?? createProductionControlPlane(projectRoot);

  mutation
    .command("execute")
    .description("schemaVersion 1 のmutation command JSONを実行する")
    .requiredOption("--input <json>", "MutationProposalCommand JSON")
    .action(async (options: { input: string }) => {
      const projectRoot = dependencies.projectRoot?.() ?? process.cwd();
      let command: MutationProposalCommand | unknown;
      try {
        command = JSON.parse(options.input);
      } catch (error) {
        console.error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      const receipt = await (await control(projectRoot)).execute(command);
      console.log(JSON.stringify(receipt, null, 2));
      if (!receipt.accepted) process.exitCode = 1;
    });

  mutation
    .command("show")
    .description("proposalのbounded viewを表示する")
    .argument("<proposal-id>", "proposal ID")
    .option("--full", "frozen planを含む全文viewを取得する")
    .option("--limit <number>", "最大件数", (value) => Number(value), 20)
    .option("--offset <number>", "pagination offset", (value) => Number(value), 0)
    .action(
      async (proposalId: string, options: { full?: boolean; limit: number; offset: number }) => {
        const projectRoot = dependencies.projectRoot?.() ?? process.cwd();
        const view = await (
          await control(projectRoot)
        ).inspect({
          proposalId,
          full: options.full ?? false,
          limit: options.limit,
          offset: options.offset,
        });
        console.log(JSON.stringify(view, null, 2));
      },
    );

  return mutation;
}
