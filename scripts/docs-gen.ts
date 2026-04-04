import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const GENERATED_DIR = resolve(ROOT, "docs/generated");

async function generateOpenApi() {
  const { generateOpenApiDocument } = await import("../packages/cli/src/server/openapi.js");
  const doc = generateOpenApiDocument();
  const outPath = resolve(GENERATED_DIR, "openapi.yaml");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, stringify(doc), "utf-8");
  console.log(`OpenAPI spec written to ${outPath}`);
}

async function generateTypedoc() {
  const { Application } = await import("typedoc");
  const app = await Application.bootstrapWithPlugins({
    entryPoints: [
      resolve(ROOT, "packages/shared/src/index.ts"),
      resolve(ROOT, "packages/cli/src/index.ts"),
    ],
    tsconfig: resolve(ROOT, "tsconfig.typedoc.json"),
    out: resolve(GENERATED_DIR, "api"),
    readme: "none",
    excludePrivate: true,
    excludeInternal: true,
    skipErrorChecking: true,
  });

  const project = await app.convert();
  if (!project) {
    throw new Error("TypeDoc conversion failed");
  }
  await app.generateDocs(project, resolve(GENERATED_DIR, "api"));
  console.log(`TypeDoc output written to ${resolve(GENERATED_DIR, "api")}`);
}

async function main() {
  await mkdir(GENERATED_DIR, { recursive: true });

  console.log("Generating OpenAPI spec...");
  await generateOpenApi();

  console.log("Generating TypeDoc...");
  await generateTypedoc();

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
