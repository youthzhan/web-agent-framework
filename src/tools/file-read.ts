import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import { readSandboxFile } from "./sandbox.js";
import type { AgentTool } from "./types.js";

const FileReadArgsSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !value.includes("\0"), "NUL bytes are not allowed")
});

export function createFileReadTool(env: AppEnv): AgentTool<
  typeof FileReadArgsSchema
> {
  return {
    name: "file_read",
    description:
      "Read a UTF-8 text file under the configured sandbox directory. Never use absolute paths.",
    argsSchema: FileReadArgsSchema,
    risk: "low",
    async execute(args) {
      return await readSandboxFile(
        env.sandboxRootAbs,
        args.path,
        env.MAX_FILE_READ_BYTES
      );
    }
  };
}
