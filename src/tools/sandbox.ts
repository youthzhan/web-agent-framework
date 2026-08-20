import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../common/errors.js";

export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export function resolveSandboxPath(root: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    throw new AppError(
      "SECURITY_VIOLATION",
      "Absolute paths are not allowed by the file tool",
      { statusCode: 403 }
    );
  }

  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, requestedPath);
  const relative = path.relative(rootAbs, candidate);
  const isOutside = relative === ".." || relative.startsWith(`..${path.sep}`);

  if (isOutside) {
    throw new AppError(
      "SECURITY_VIOLATION",
      "Requested path is outside the sandbox",
      { statusCode: 403, details: { requestedPath } }
    );
  }
  return candidate;
}

export async function readSandboxFile(
  root: string,
  requestedPath: string,
  maxBytes: number
): Promise<{ path: string; content: string; bytes: number }> {
  const resolved = resolveSandboxPath(root, requestedPath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new AppError("TOOL_ERROR", "Sandbox path is not a regular file", {
      statusCode: 400
    });
  }
  if (stat.size > maxBytes) {
    throw new AppError("TOOL_ERROR", "File exceeds the configured read limit", {
      statusCode: 413,
      details: { maxBytes, actualBytes: stat.size }
    });
  }
  const content = await fs.readFile(resolved, "utf8");
  return { path: path.relative(root, resolved), content, bytes: stat.size };
}
