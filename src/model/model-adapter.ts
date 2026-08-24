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
        signal: options.signal ?? signal,
        ...(options.maxOutputTokens
          ? { maxTokens: options.maxOutputTokens }
          : {})
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
    let receivedFirstToken = false;
    const emitToken = (token: string) => {
      if (!receivedFirstToken) {
        receivedFirstToken = true;
        options.onFirstToken?.();
      }
      onToken(token);
    };
    const responseState = options.responseState;
    if (responseState && this.responsesClient) {
      return await this.safeModelCall(
        async (signal) =>
          await this.streamResponsesApi(
            messages,
            emitToken,
            responseState,
            signal,
            options.maxOutputTokens
          ),
        options.operation,
        options.timeoutMs
      );
    }
    return await this.safeModelCall(async (signal) => {
      if (!this.model.stream) {
        const response = await this.model.invoke(messages, {
          signal: options.signal ?? signal,
          ...(options.maxOutputTokens
            ? { maxTokens: options.maxOutputTokens }
            : {})
        });
        const text = messageContentToText(response.content);
        if (text) {
          emitToken(text);
        }
        const usage = this.extractUsage(response);
        return usage ? { text, usage } : { text };
      }

      const stream = await this.model.stream(messages, {
        signal: options.signal ?? signal,
        ...(options.maxOutputTokens
          ? { maxTokens: options.maxOutputTokens }
          : {})
      });
      let text = "";
      let usage: TokenUsage | undefined;

      for await (const chunk of stream) {
        const token = messageContentToText(chunk.content);
        if (token) {
          text += token;
          emitToken(token);
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
    signal: AbortSignal,
    maxOutputTokens?: number
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const stream = await this.responsesClient!.responses.create(
      buildOpenAIResponsesRequest({
        model: this.modelName,
        messages,
        ...(state.previousResponseId
          ? { previousResponseId: state.previousResponseId }
          : {}),
        store: this.getResponsesStoreEnabled(),
        ...(maxOutputTokens ? { maxOutputTokens } : {})
      }),
      { signal }
    );
    let text = "";
    let completedText: string | undefined;
    let responseId: string | undefined;
    let usage: TokenUsage | undefined;

    for await (const event of stream) {
      const chunk = extractOpenAIResponsesTextChunk(event);
      if (chunk.delta) {
        text += chunk.delta;
        onToken(chunk.delta);
      }
      completedText ??= chunk.completedText;
      // OpenAI emits the response object on created, in-progress, and completed
      // events. Compatible endpoints may omit the completed payload, so retain
      // the first valid ID seen anywhere in the stream.
      const metadata = extractOpenAIResponsesStreamMetadata(event);
      responseId ??= metadata.responseId;
      usage = metadata.usage ?? usage;
    }

    // Some compatible endpoints omit delta events and only include the final
    // text in response.output_text or response.output_text.done. Emit it once
    // at the end so the frontend still receives the standard token event.
    if (!text && completedText) {
      text = completedText;
      onToken(text);
    }
    if (!text && responseId) {
      const recoveredText = await this.retrieveResponsesOutput(responseId, signal);
      if (recoveredText) {
        text = recoveredText;
        onToken(text);
      }
    }
    if (!text.trim()) {
      throw new AppError(
        "MODEL_ERROR",
        "Responses API completed without output text"
      );
    }

    if (responseId) {
      await state.onResponseStored(responseId);
    } else {
      // A response ID is only an optimization for vendor-side continuation.
      // Do not discard a valid streamed reply when an OpenAI-compatible server
      // does not expose one. The next turn will use persisted Redis history.
      this.options.logger.warn(
        {
          provider: this.provider,
          model: this.modelName,
          store: this.getResponsesStoreEnabled(),
          outputChars: text.length
        },
        "responses_api_stream_missing_response_id"
      );
    }
    return usage ? { text, usage } : { text };
  }

  private async retrieveResponsesOutput(
    responseId: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    try {
      const response = await this.responsesClient!.responses.retrieve(
        responseId,
        undefined,
        { signal }
      );
      return extractOpenAIResponsesTextChunk({ response }).completedText;
    } catch (error) {
      this.options.logger.warn(
        {
          provider: this.provider,
          model: this.modelName,
          responseId,
          error: describeModelProviderError(error)
        },
        "responses_api_output_retrieval_failed"
      );
      return undefined;
    }
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
    const startedAt = Date.now();
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
          operation,
          durationMs: Date.now() - startedAt
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
          durationMs: Date.now() - startedAt,
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
  maxOutputTokens?: number;
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
    ...(input.maxOutputTokens
      ? { max_output_tokens: input.maxOutputTokens }
      : {}),
    store: input.store,
    stream: true as const
  };
}

/**
 * Reads continuation metadata without relying on a single terminal event.
 * Some OpenAI-compatible Responses endpoints send the ID only when the
 * response is created or in progress, while others expose `response_id` on
 * text events.
 */
export function extractOpenAIResponsesStreamMetadata(event: unknown): {
  responseId?: string;
  usage?: TokenUsage;
} {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return {};
  }
  const record = event as Record<string, unknown>;
  const response = asPlainRecord(record.response);
  const responseId =
    typeof response?.id === "string"
      ? response.id
      : typeof record.response_id === "string"
        ? record.response_id
        : typeof record.responseId === "string"
          ? record.responseId
          : undefined;
  const usage = extractOpenAIResponsesUsage(response?.usage ?? record.usage);
  return {
    ...(responseId ? { responseId } : {}),
    ...(usage ? { usage } : {})
  };
}

/**
 * Normalizes streamed text across OpenAI and compatible Responses endpoints.
 * Delta events are preferred; final text is retained strictly as a fallback
 * to avoid duplicating content when both event forms are sent.
 */
export function extractOpenAIResponsesTextChunk(event: unknown): {
  delta?: string;
  completedText?: string;
} {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return {};
  }
  const record = event as Record<string, unknown>;
  if (
    record.type === "response.output_text.delta" &&
    typeof record.delta === "string"
  ) {
    return { delta: record.delta };
  }
  if (
    record.type === "response.output_text.done" &&
    typeof record.text === "string"
  ) {
    return { completedText: record.text };
  }
  if (record.type === "response.content_part.done") {
    const part = asPlainRecord(record.part);
    if (part?.type === "output_text" && typeof part.text === "string") {
      return { completedText: part.text };
    }
  }
  if (record.type === "response.output_item.done") {
    const outputText = extractResponseOutputText([record.item]);
    if (outputText) {
      return { completedText: outputText };
    }
  }
  const response = asPlainRecord(record.response);
  const outputText =
    typeof response?.output_text === "string"
      ? response.output_text
      : extractResponseOutputText(response?.output);
  return outputText ? { completedText: outputText } : {};
}

function extractResponseOutputText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .flatMap((item) => {
      const message = asPlainRecord(item);
      if (message?.type === "output_text" && typeof message.text === "string") {
        return [message];
      }
      const content = message?.content;
      return Array.isArray(content) ? content : [];
    })
    .map(asPlainRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .filter((item): item is string => typeof item === "string")
    .join("");
  return text || undefined;
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

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
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
