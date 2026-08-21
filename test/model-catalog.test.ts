import { describe, expect, it } from "vitest";
import {
  parseModelCatalog,
  type ModelCatalogEntry
} from "../src/config/env.js";

const defaultModel: ModelCatalogEntry = {
  id: "default",
  label: "Default",
  provider: "openai-compatible",
  model: "deepseek-v4-flash-ga-260731"
};

describe("model catalog", () => {
  it("keeps the default model and exposes distinct configured choices", () => {
    const catalog = parseModelCatalog(
      JSON.stringify([
        {
          id: "deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          provider: "openai-compatible",
          model: "deepseek-v4-flash-ga-260731"
        },
        {
          id: "doubao-seed-2-1-pro",
          label: "Doubao Seed 2.1 Pro",
          provider: "openai-compatible",
          model: "doubao-seed-2-1-pro-260628"
        }
      ]),
      defaultModel
    );

    expect(catalog).toEqual([
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        provider: "openai-compatible",
        model: "deepseek-v4-flash-ga-260731"
      },
      {
        id: "doubao-seed-2-1-pro",
        label: "Doubao Seed 2.1 Pro",
        provider: "openai-compatible",
        model: "doubao-seed-2-1-pro-260628"
      }
    ]);
  });

  it("rejects an invalid catalog before the server starts", () => {
    expect(() => parseModelCatalog("not-json", defaultModel)).toThrow(
      "MODEL_CATALOG must be valid JSON"
    );
  });
});
