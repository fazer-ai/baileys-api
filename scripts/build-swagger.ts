import { file, spawnSync } from "bun";
import app from "@/app";
import config from "@/config";
import { errorToString } from "@/helpers/errorToString";

async function getGitIndexContent(filePath: string): Promise<string | null> {
  const proc = spawnSync(["git", "show", `:${filePath}`]);
  if (proc.exitCode === 0) {
    return proc.stdout.toString();
  }
  return null;
}

function patchAnyOf(swaggerJson: Record<string, any>) {
  // NOTE: `anyOf` is generated incorrectly in the swagger.json file for `t.Enum` types.
  // The "correct" approach would be to use `t.Unsafe` for the body definition instead of applying this patch, but that won't work with ElysiaJS.
  // That is due to schema definition in ElysiaJS wrapping the options object in `t.Object` internally, which is not compatible with `t.Unsafe`.
  const traverse = (node: any) => {
    if (node && typeof node === "object") {
      if (node.properties && typeof node.properties === "object") {
        for (const [propName, propSchema] of Object.entries(
          node.properties as Record<string, any>,
        )) {
          if (
            propSchema.anyOf &&
            Array.isArray(propSchema.anyOf) &&
            propSchema.anyOf[0]?.type === "string"
          ) {
            const enumValues = propSchema.anyOf
              .filter((item: any) => item.const !== undefined)
              .map((item: any) => item.const);

            const newSchema: any = {
              type: "string",
              enum: enumValues,
            };
            if (propSchema.description) {
              newSchema.description = propSchema.description;
            }
            if (propSchema.example) {
              newSchema.example = propSchema.example;
            }

            node.properties[propName] = newSchema;
          } else {
            traverse(propSchema);
          }
        }
      } else {
        for (const child of Object.values(node)) {
          traverse(child);
        }
      }
    }
  };

  traverse(swaggerJson);
}

async function checkOrUpdateSwagger(): Promise<number> {
  const swaggerFilePath = "./swagger.json";

  try {
    const res = await fetch(`http://localhost:${config.port}/swagger/json`);
    if (res.status !== 200) {
      console.error(
        `Error: Failed to fetch swagger JSON. Status: ${res.status}`,
      );
      return 1;
    }

    const newSwaggerJsonObject = await res.json();
    patchAnyOf(newSwaggerJsonObject);

    const expectedSwaggerContent = JSON.stringify(
      newSwaggerJsonObject,
      null,
      2,
    );
    const swaggerFile = file(swaggerFilePath);

    const contentToCommit = (await getGitIndexContent(swaggerFilePath)) ?? "";

    if (expectedSwaggerContent !== contentToCommit) {
      await swaggerFile.write(expectedSwaggerContent);
      console.error(
        `Error: ${swaggerFilePath} has been updated. Please stage it before committing.`,
      );
      return 1;
    }

    return 0;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error during swagger check: ${errorToString(error)}`);
    } else {
      console.error(`An unknown error occurred during swagger check.`);
    }
    return 1;
  }
}

app.listen(config.port, async (server) => {
  const exitCode = await checkOrUpdateSwagger();
  server.stop(true);
  process.exit(exitCode);
});
