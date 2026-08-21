import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
import { z } from "zod";
import { AppError } from "../common/errors.js";
import type { AppLogger } from "../common/logger.js";
import { withTimeout } from "../common/timeout.js";
import type { AppEnv } from "../config/env.js";
import { ModelProviderSchema } from "../schemas/api.js";
import { extractJsonObject, messageContentToText } from "./json.js";
import type {
  ChatModelInstance,
  JsonInvokeOptions,
  ModelSelection,
  TextInvokeOptions,
  TokenUsage
} from "./types.js";

type ModelFactoryOptions = {
  env: AppEnv;
  logger: AppLogger;
  selection?: Partial<ModelSelection>;
};

export class ModelAdapter {
  private readonly model: ChatModelInstance;
  private readonly provider: z.infer<typeof ModelProviderSchema>;
  private readonly modelName: string;
  private readonly responsesClient: OpenAI | undefined;

  constructor(private readonly options: ModelFactoryOptions) {
    const provider = options.selection?.provider ?? options.env.DEFAULT_MODEL_PROVIDER;
    this.provider = ModelProviderSchema.parse(provider);
    this.modelName = this.resolveModelName(options.selection?.model);
    this.model = this.createModel();
    this.responsesClient = this.createResponsesClient();
  }

  get rawModel(): ChatModelInstance {
    return this.model;
  }

  async invokeText(
    messages: BaseMessage[],
    options: TextInvokeOptions
  ): Promise<{ text: string; usage?: TokenUsage }> {
    return await this.safeModelCall(async (signal) => {
      const response = await this.model.invoke(messages, {
        signal: options.signal ?? signal
      });
      const text = messageContentToText(response.content);
      const usage = this.extractUsage(response);
      return usage ? { text, usage } : { text };
    }, options.operation, options.timeoutMs);
  }

  async streamText(
    messages: BaseMessage[],
    onToken: (token: string) => void,
    options: TextInvokeOptions
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const responseState = options.responseState;
    if (responseState && this.responsesClient) {
      return await this.safeModelCall(
        async (signal) =>
          await this.streamResponsesApi(
            messages,
            onToken,
            responseState,
            signal
          ),
        options.operation,
        options.timeoutMs
      );
    }
    return await this.safeModelCall(async (signal) => {
      if (!this.model.stream) {
        const response = await this.model.invoke(messages, {
          signal: options.signal ?? signal
        });
        const text = messageContentToText(response.content);
        if (text) {
          onToken(text);
        }
        const usage = this.extractUsage(response);
        return usage ? { text, usage } : { text };
      }

      const stream = await this.model.stream(messages, {
        signal: options.signal ?? signal
      });
      let text = "";
      let usage: TokenUsage | undefined;

      for await (const chunk of stream) {
        const token = messageContentToText(chunk.content);
        if (token) {
          text += token;
          onToken(token);
        }
        usage = this.extractUsage(chunk) ?? usage;
      }

      return usage ? { text, usage } : { text };
    }, options.operation, options.timeoutMs);
  }

  async invokeJson<T>(
    messages: BaseMessage[],
    schema: z.ZodSchema<T>,
    options: JsonInvokeOptions
  ): Promise<T> {
    const jsonMessages = [
      new SystemMessage(
        [
          "You must return exactly one valid JSON object.",
          "Do not include markdown fences or explanatory text.",
          "All fields must conform to the requested schema."
        ].join(" ")
      ),
      ...messages
    ];

    const response = await this.invokeText(jsonMessages, options);
    try {
      return schema.parse(extractJsonObject(response.text));
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new AppError("MODEL_ERROR", "Model JSON failed schema validation", {
          details: error.issues,
          cause: error
        });
      }
      throw error;
    }
  }

  helperMessages(system: string, user: string): BaseMessage[] {
    return [new SystemMessage(system), new HumanMessage(user)];
  }

  private resolveModelName(modelOverride?: string): string {
    if (modelOverride) {
      return modelOverride;
    }
    switch (this.provider) {
      case "anthropic":
        return this.options.env.ANTHROPIC_MODEL;
      case "openai-compatible":
        return this.options.env.OPENAI_COMPATIBLE_MODEL;
      case "openai":
        return this.options.env.OPENAI_MODEL;
    }
  }

  private createModel(): ChatModelInstance {
    switch (this.provider) {
      case "anthropic":
        if (!this.options.env.ANTHROPIC_API_KEY) {
          throw new AppError("MODEL_ERROR", "ANTHROPIC_API_KEY is required");
        }
        return new ChatAnthropic({
          apiKey: this.options.env.ANTHROPIC_API_KEY,
          model: this.modelName,
          maxRetries: this.options.env.MODEL_MAX_RETRIES
        }) as ChatModelInstance;

      case "openai-compatible":
        if (!this.options.env.OPENAI_COMPATIBLE_API_KEY) {
          throw new AppError(
            "MODEL_ERROR",
            "OPENAI_COMPATIBLE_API_KEY is required"
          );
        }
        return new ChatOpenAI({
          apiKey: this.options.env.OPENAI_COMPATIBLE_API_KEY,
          model: this.modelName,
          configuration: {
            baseURL: this.options.env.OPENAI_COMPATIBLE_BASE_URL
          },
          timeout: this.options.env.MODEL_TIMEOUT_MS,
          maxRetries: this.options.env.MODEL_MAX_RETRIES
        }) as ChatModelInstance;

      case "openai":
        if (!this.options.env.OPENAI_API_KEY) {
          throw new AppError("MODEL_ERROR", "OPENAI_API_KEY is required");
        }
        return new ChatOpenAI({
          apiKey: this.options.env.OPENAI_API_KEY,
          model: this.modelName,
          timeout: this.options.env.MODEL_TIMEOUT_MS,
          maxRetries: this.options.env.MODEL_MAX_RETRIES
        }) as ChatModelInstance;
    }
  }

  private createResponsesClient(): OpenAI | undefined {
    if (!this.isResponsesStateEnabled()) {
      return undefined;
    }
    const apiKey = this.getResponsesApiKey();
    return new OpenAI({
      apiKey,
      ...(this.provider === "openai-compatible"
        ? { baseURL: this.options.env.OPENAI_COMPATIBLE_BASE_URL }
        : {}),
      timeout: this.options.env.MODEL_TIMEOUT_MS,
      maxRetries: this.options.env.MODEL_MAX_RETRIES
    });
  }

  private async streamResponsesApi(
    messages: BaseMessage[],
    onToken: (token: string) => void,
    state: NonNullable<TextInvokeOptions["responseState"]>,
    signal: AbortSignal
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const stream = await this.responsesClient!.responses.create(
      buildOpenAIResponsesRequest({
        model: this.modelName,
        messages,
        ...(state.previousResponseId
          ? { previousResponseId: state.previousResponseId }
          : {}),
        store: this.getResponsesStoreEnabled()
      }),
      { signal }
    );
    let text = "";
    let responseId: string | undefined;
    let usage: TokenUsage | undefined;

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        text += event.delta;
        onToken(event.delta);
      }
      if (event.type === "response.completed") {
        responseId = event.response.id;
        usage = extractOpenAIResponsesUsage(event.response.usage);
      }
    }

    if (!responseId) {
      throw new AppError(
        "MODEL_ERROR",
        "Responses API stream completed without a response id"
      );
    }
    await state.onResponseStored(responseId);
    return usage ? { text, usage } : { text };
  }

  private isResponsesStateEnabled(): boolean {
    return (
      (this.provider === "openai" &&
        this.options.env.OPENAI_RESPONSES_STATE_ENABLED) ||
      (this.provider === "openai-compatible" &&
        this.options.env.OPENAI_COMPATIBLE_RESPONSES_STATE_ENABLED)
    );
  }

  private getResponsesApiKey(): string {
    if (this.provider === "openai") {
      if (!this.options.env.OPENAI_API_KEY) {
        throw new AppError("MODEL_ERROR", "OPENAI_API_KEY is required");
      }
      return this.options.env.OPENAI_API_KEY;
    }
    if (this.provider === "openai-compatible") {
      if (!this.options.env.OPENAI_COMPATIBLE_API_KEY) {
        throw new AppError(
          "MODEL_ERROR",
          "OPENAI_COMPATIBLE_API_KEY is required"
        );
      }
      return this.options.env.OPENAI_COMPATIBLE_API_KEY;
    }
    throw new AppError(
      "MODEL_ERROR",
      "Responses API state is unavailable for this model provider"
    );
  }

  private getResponsesStoreEnabled(): boolean {
    return this.provider === "openai"
      ? this.options.env.OPENAI_RESPONSES_STORE
      : this.options.env.OPENAI_COMPATIBLE_RESPONSES_STORE;
  }

  private async safeModelCall<T>(
    call: (signal: AbortSignal) => Promise<T>,
    operation: string,
    timeoutMs = this.options.env.MODEL_TIMEOUT_MS
  ): Promise<T> {
    try {
      const result = await withTimeout(
        call,
        timeoutMs,
        `Model call timed out during ${operation}`,
        "MODEL_TIMEOUT"
      );
      this.options.logger.info(
        {
          provider: this.provider,
          model: this.modelName,
          operation
        },
        "model_call_completed"
      );
      return result;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const providerError = describeModelProviderError(error);
      this.options.logger.error(
        {
          error,
          provider: this.provider,
          model: this.modelName,
          operation,
          providerError
        },
        "model_call_failed"
      );
      throw new AppError("MODEL_ERROR", providerError.message, {
        details: providerError.details,
        cause: error
      });
    }
  }

  private extractUsage(message: BaseMessage): TokenUsage | undefined {
    const candidate = message as unknown as {
      usage_metadata?: Record<string, unknown>;
      response_metadata?: Record<string, unknown>;
    };
    const usageMetadata = candidate.usage_metadata;
    const tokenUsage = this.asRecord(candidate.response_metadata?.tokenUsage);
    if (!usageMetadata && !tokenUsage) {
      return undefined;
    }

    const usage: TokenUsage = {};
    const inputTokens = usageMetadata?.input_tokens ?? tokenUsage?.promptTokens;
    const outputTokens =
      usageMetadata?.output_tokens ?? tokenUsage?.completionTokens;
    const totalTokens = usageMetadata?.total_tokens ?? tokenUsage?.totalTokens;
    if (typeof inputTokens === "number") {
      usage.inputTokens = inputTokens;
    }
    if (typeof outputTokens === "number") {
      usage.outputTokens = outputTokens;
    }
    if (typeof totalTokens === "number") {
      usage.totalTokens = totalTokens;
    }
    return Object.keys(usage).length > 0 ? usage : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }
}

/**
 * Converts LangChain messages into the subset used by the final Responses API
 * request. System instructions are explicitly resent because OpenAI does not
 * carry prior instructions forward with `previous_response_id`.
 */
export function buildOpenAIResponsesRequest(input: {
  model: string;
  messages: BaseMessage[];
  previousResponseId?: string;
  store: boolean;
}) {
  const instructions = input.messages
    .filter((message) => message instanceof SystemMessage)
    .map((message) => messageContentToText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const prompt = input.messages
    .filter((message) => !(message instanceof SystemMessage))
    .map((message) => messageContentToText(message.content))
    .filter(Boolean)
    .join("\n\n");

  return {
    model: input.model,
    input: prompt,
    ...(instructions ? { instructions } : {}),
    ...(input.previousResponseId
      ? { previous_response_id: input.previousResponseId }
      : {}),
    store: input.store,
    stream: true as const
  };
}

function extractOpenAIResponsesUsage(value: unknown): TokenUsage | undefined {
  const usage = value as
    | { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
    | undefined;
  if (!usage) {
    return undefined;
  }
  const result: TokenUsage = {};
  if (typeof usage.input_tokens === "number") {
    result.inputTokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    result.outputTokens = usage.output_tokens;
  }
  if (typeof usage.total_tokens === "number") {
    result.totalTokens = usage.total_tokens;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * The OpenAI SDK also backs compatible providers. Preserve their actionable
 * HTTP/code/request-id fields, but never return request bodies or credentials
 * to browser clients and logs.
 */
export function describeModelProviderError(error: unknown): {
  message: string;
  details?: Record<string, string | number>;
} {
  if (!(error instanceof Error)) {
    return { message: "Model call failed" };
  }
  const candidate = error as Error & {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    request_id?: unknown;
    requestID?: unknown;
  };
  const details: Record<string, string | number> = {};
  if (typeof candidate.status === "number") {
    details.httpStatus = candidate.status;
  }
  if (typeof candidate.code === "string") {
    details.providerCode = candidate.code;
  }
  if (typeof candidate.type === "string") {
    details.providerType = candidate.type;
  }
  const requestId = candidate.request_id ?? candidate.requestID;
  if (typeof requestId === "string") {
    details.providerRequestId = requestId;
  }
  const suffix =
    Object.keys(details).length > 0
      ? ` (${Object.entries(details)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")})`
      : "";
  const providerMessage = redactSensitiveText(error.message).slice(0, 1_000);
  return {
    message: providerMessage
      ? `Model call failed${suffix}: ${providerMessage}`
      : `Model call failed${suffix}`,
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:sk|ark)-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]");
}
