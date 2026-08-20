import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import type { AppEnv } from "../config/env.js";

// LangGraph RedisSaver API has changed names across minor releases.
// This wrapper keeps the application code isolated from those package-level changes.
export async function createRedisCheckpointer(
  env: AppEnv
): Promise<BaseCheckpointSaver> {
  if (env.checkpointBackend === "memory") {
    return new MemorySaver();
  }
  const module = await import("@langchain/langgraph-checkpoint-redis");
  return await module.RedisSaver.fromUrl(env.REDIS_URL, {
    defaultTTL: env.CHECKPOINT_TTL_SECONDS,
    refreshOnRead: true
  });
}
