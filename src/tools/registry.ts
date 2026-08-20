import { AppError } from "../common/errors.js";
import type { AgentTool, ToolRegistry } from "./types.js";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new AppError("TOOL_ERROR", `Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  getRequired(name: string): AgentTool {
    const tool = this.get(name);
    if (!tool) {
      throw new AppError("TOOL_ERROR", `Unknown tool: ${name}`, {
        statusCode: 404
      });
    }
    return tool;
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }
}
