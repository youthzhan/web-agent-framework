import type { AppLogger } from "../common/logger.js";
import type { AppEnv } from "../config/env.js";
import type { ModelSelection } from "./types.js";
import { ModelAdapter } from "./model-adapter.js";

export class ModelRouter {
  constructor(
    private readonly env: AppEnv,
    private readonly logger: AppLogger
  ) {}

  create(selection?: Partial<ModelSelection>): ModelAdapter {
    return new ModelAdapter({
      env: this.env,
      logger: this.logger,
      ...(selection ? { selection } : {})
    });
  }
}
