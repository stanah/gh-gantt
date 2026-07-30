import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  GANTT_DIR,
  GRAPH_CONTRACTS_DIR,
  GraphContractSchema,
  RUN_GRAPH_DIR,
  type GraphContract,
} from "@gh-gantt/shared";

function safeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export interface GraphContractBinding {
  planId: string;
  planVersion: string;
  schemaVersion: string;
}

/** versioned Graph Contract を immutable artifact として保存する。 */
export class GraphContractStore {
  private readonly root: string;

  constructor(projectRoot: string) {
    this.root = join(projectRoot, GANTT_DIR, RUN_GRAPH_DIR, GRAPH_CONTRACTS_DIR);
  }

  private path(binding: GraphContractBinding): string {
    return join(
      this.root,
      safeSegment(binding.planId),
      `${safeSegment(binding.planVersion)}-${safeSegment(binding.schemaVersion)}.json`,
    );
  }

  async install(input: GraphContract): Promise<void> {
    const contract = GraphContractSchema.parse(input);
    const filePath = this.path({
      planId: contract.planId,
      planVersion: contract.planVersion,
      schemaVersion: contract.schemaVersion,
    });
    await mkdir(dirname(filePath), { recursive: true });
    const content = JSON.stringify(contract, null, 2) + "\n";
    try {
      await writeFile(filePath, content, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = GraphContractSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
      if (JSON.stringify(existing) !== JSON.stringify(contract)) {
        throw new Error("同じ Graph Contract binding に異なる内容は install できません");
      }
    }
  }

  async read(binding: GraphContractBinding): Promise<GraphContract> {
    try {
      return GraphContractSchema.parse(JSON.parse(await readFile(this.path(binding), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Graph Contract が見つかりません: ${binding.planId}@${binding.planVersion} schema ${binding.schemaVersion}`,
        );
      }
      throw error;
    }
  }
}
