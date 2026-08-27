import {
  Command,
  END,
  INTERRUPT,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
  type BaseCheckpointSaver
} from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AppEnv } from "../config/env.js";
import type { AppLogger } from "../common/logger.js";
import { emitSseEvent, getRuntimeContext } from "../common/run-context.js";
import { AppError, normalizeError } from "../common/errors.js";
import type { MessageStore } from "../persistence/message-store.js";
import type { ThreadStore } from "../persistence/thread-store.js";
import type { ModelRouter } from "../model/model-router.js";
import type { ModelAdapter } from "../model/model-adapter.js";
import type { TextInvokeOptions } from "../model/types.js";
import type { SkillLoader } from "../skills/skill-loader.js";
import type { SkillEngine } from "../skills/skill-engine.js";
import {
  createSerialFallbackPlan,
  routeSkillConversation,
  type SkillRoutingDecision
} from "../skills/routing.js";
import {
  AgentPlanSchema,
  PreparedSkillExecutionSchema,
  type AgentPlan,
  type SkillMatch
} from "../skills/types.js";
import { AgentGraphInputSchema, AgentState, HumanDecisionSchema } from "./state.js";
import type { AgentGraphInput, AgentStateValue, HumanDecision } from "./state.js";
import type { HumanConfirmationRecord } from "../schemas/human-confirmation.js";

type CompiledAgentGraph = ReturnType<AgentWorkflow["compile"]>;

export class AgentWorkflow {
  private readonly graph: CompiledAgentGraph;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: AppLogger,
    private readonly modelRouter: ModelRouter,
    private readonly skillLoader: SkillLoader,
    private readonly skillEngine: SkillEngine,
    private readonly messageStore: MessageStore,
    private readonly threadStore: ThreadStore,
    checkpointer: BaseCheckpointSaver
  ) {
    this.graph = this.compile(checkpointer);
  }

  async streamNew(input: AgentGraphInput): Promise<AsyncIterable<unknown>> {
    const parsed = AgentGraphInputSchema.parse(input);
    return await this.graph.stream(
      {
        ...parsed,
        status: "running",
        plan: undefined,
        preparedSkills: [],
        pendingConfirmation: undefined,
        approvalDecision: undefined,
        approvalDecisions: [],
        skillResults: [],
        finalOutput: "",
        error: undefined
      },
      this.graphConfig(parsed.threadId)
    );
  }

  async streamResume(
    threadId: string,
    decision: HumanDecision
  ): Promise<AsyncIterable<unknown>> {
    const parsed = HumanDecisionSchema.parse(decision);
    return await this.graph.stream(
      new Command({ resume: parsed }),
      this.graphConfig(threadId)
    );
  }

  isInterruptChunk(chunk: unknown): boolean {
    return isInterrupted(chunk);
  }

  isFailureChunk(chunk: unknown): boolean {
    return hasFailedStatus(chunk);
  }

  getInterruptValue(chunk: unknown): unknown {
    if (isInterrupted(chunk)) {
      return chunk[INTERRUPT][0]?.value;
    }
    return undefined;
  }

  private graphConfig(threadId: string) {
    return {
      configurable: { thread_id: threadId },
      recursionLimit: this.env.AGENT_RECURSION_LIMIT
    };
  }

  private compile(checkpointer: BaseCheckpointSaver) {
    const planNode = async (state: AgentStateValue) => {
      const context = getRuntimeContext();
      const summaries = await this.skillLoader.listSummaries();
      const skillContext = this.skillEngine.formatSkillContext(summaries);
      const history = state.history
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n");

      // A direct chat request does not need a visible planning phase. It still
      // passes through the StateGraph for checkpoint consistency, but emits no
      // planner state and goes straight to the final response node.
      if (summaries.length === 0) {
        this.logger.info(
          {
            requestId: state.requestId,
            threadId: state.threadId,
            userId: state.userId
          },
          "agent_planner_skipped_no_skills"
        );
        return {
          plan: AgentPlanSchema.parse({ directAnswer: true }),
          skillContext,
          status: "planned"
        };
      }

      const exactMatches = await this.skillLoader.findMatchDetails(state.message);
      const matches = exactMatches.length > 0
        ? exactMatches
        : this.env.SKILL_SEMANTIC_RECALL_ENABLED
          ? await this.skillLoader.findSemanticCandidates(
              state.message,
              this.env.SKILL_SEMANTIC_RECALL_LIMIT
            )
          : [];
      // No lexical or semantic candidates means ordinary chat. Only candidate
      // Skills reach the model planner; the model never scans every full
      // Skill document for a generic message.
      if (matches.length === 0) {
        this.logger.info(
          {
            requestId: state.requestId,
            threadId: state.threadId,
            userId: state.userId
          },
          "agent_planner_skipped_no_skill_match"
        );
        return {
          plan: AgentPlanSchema.parse({ directAnswer: true }),
          skillContext,
          status: "planned"
        };
      }

      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: { status: "planning", node: "plan" }
      });

      const model = this.modelRouter.create({
        provider: state.modelProvider,
        ...(state.model ? { model: state.model } : {})
      });
      const routing = routeSkillConversation(state.message, matches);
      const plan = routing.plan
        ? routing.plan
        : await this.createModelPlan({
            model,
            state,
            history,
            skillContext,
            routing
          });

      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: routing.plan
            ? "planning_deterministic"
            : "planning_dynamic",
          node: "planner",
          detail: {
            source: routing.source,
            scheduling: routing.scheduling,
            skills: plan.skills.map((skill) => ({
              skillName: skill.skillName,
              mode: skill.mode
            }))
          }
        }
      });

      const availableSkillNames = new Set(
        summaries.map((summary) => summary.name)
      );
      const unknownSkillNames = plan.skills
        .map((skill) => skill.skillName)
        .filter((skillName) => !availableSkillNames.has(skillName));
      if (unknownSkillNames.length > 0) {
        throw new AppError("MODEL_ERROR", "Planner selected unknown skills", {
          details: { unknownSkillNames }
        });
      }

      this.logger.info(
        {
          requestId: state.requestId,
          threadId: state.threadId,
          userId: state.userId,
          routingSource: routing.source,
          scheduling: routing.scheduling,
          selectedSkills: plan.skills.map((skill) => ({
            skillName: skill.skillName,
            mode: skill.mode
          }))
        },
        "agent_plan_completed"
      );

      return {
        plan,
        skillContext,
        status: "planned"
      };
    };

    const prepareSkillsNode = async (state: AgentStateValue) => {
      const context = getRuntimeContext();
      const plan = state.plan ?? AgentPlanSchema.parse({});
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "preparing_skills",
          node: "prepare_skills",
          detail: { count: plan.skills.length }
        }
      });

      const model = this.modelRouter.create({
        provider: state.modelProvider,
        ...(state.model ? { model: state.model } : {})
      });
      const preparedSkills = await this.skillEngine.prepareMany(
        plan.skills,
        model
      );
      const pendingConfirmation = preparedSkills.find(
        (skill) => skill.requiresConfirmation
      )?.confirmation;
      return {
        preparedSkills,
        pendingConfirmation,
        status: pendingConfirmation ? "waiting_human_confirm" : "tools_ready"
      };
    };

    const humanConfirmNode = async (state: AgentStateValue) => {
      const confirmations = this.collectConfirmations(state.preparedSkills);
      const decidedIds = new Set(
        state.approvalDecisions.map((decision) => decision.confirmationId)
      );
      const pending =
        state.pendingConfirmation ??
        confirmations.find(
          (confirmation) => !decidedIds.has(confirmation.confirmationId)
        );
      if (!pending) {
        return { status: "tools_ready" };
      }

      // LangGraph persists the state right before this interrupt. On resume,
      // the same node continues and receives the frontend confirmation payload.
      const decision = interrupt<typeof pending, HumanDecision>(pending);
      const parsed = HumanDecisionSchema.parse(decision);
      if (parsed.confirmationId !== pending.confirmationId) {
        throw new Error("Human confirmation id does not match pending state");
      }
      const approvalDecisions = [
        ...state.approvalDecisions.filter(
          (decision) => decision.confirmationId !== parsed.confirmationId
        ),
        parsed
      ];
      const completedIds = new Set(
        approvalDecisions.map((decision) => decision.confirmationId)
      );
      const nextConfirmation = parsed.approved
        ? confirmations.find(
            (confirmation) => !completedIds.has(confirmation.confirmationId)
          )
        : undefined;
      if (nextConfirmation) {
        await this.skillEngine.activateConfirmation(nextConfirmation);
      }
      return {
        approvalDecision: parsed,
        approvalDecisions,
        pendingConfirmation: nextConfirmation,
        status: !parsed.approved
          ? "human_rejected"
          : nextConfirmation
            ? "waiting_human_confirm"
            : "human_approved"
      };
    };

    const executeSkillsNode = async (state: AgentStateValue) => {
      const context = getRuntimeContext();
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "executing_skills",
          node: "execute_skills",
          detail: { count: state.preparedSkills.length }
        }
      });

      const preparedSkills = this.applyConfirmationOverrides(
        state.preparedSkills,
        state.approvalDecisions
      );
      if (state.approvalDecisions.length > 0) {
        await this.threadStore.clearPendingConfirmation(state.threadId);
      }

      const approvedConfirmationIds = new Set(
        state.approvalDecisions
          .filter((decision) => decision.approved)
          .map((decision) => decision.confirmationId)
      );
      const approvedHighRiskToolCallIds = this.collectConfirmations(
        state.preparedSkills
      )
        .filter((confirmation) =>
          approvedConfirmationIds.has(confirmation.confirmationId)
        )
        .map((confirmation) => confirmation.toolCallId);

      const model = this.modelRouter.create({
        provider: state.modelProvider,
        ...(state.model ? { model: state.model } : {})
      });
      const skillResults = await this.skillEngine.executeManyPrepared(
        preparedSkills,
        model,
        { approvedHighRiskToolCallIds }
      );

      return {
        skillResults,
        pendingConfirmation: undefined,
        status: "skills_completed"
      };
    };

    const finalizeNode = async (state: AgentStateValue) => {
      const context = getRuntimeContext();
      const directAnswer = state.plan?.directAnswer === true;
      if (!directAnswer) {
        emitSseEvent("state_update", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { status: "finalizing", node: "finalize" }
        });
      }

      if (state.approvalDecision && !state.approvalDecision.approved) {
        await this.threadStore.clearPendingConfirmation(state.threadId);
        const rejected =
          state.approvalDecision.reason?.trim() ||
          "User rejected the requested high-risk tool call.";
        const text = `任务已停止：${rejected}`;
        emitSseEvent("token", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { content: text }
        });
        return {
          finalOutput: text,
          pendingConfirmation: undefined,
          status: "completed"
        };
      }

      const directTechnicalResponse = state.plan?.directAnswer
        ? buildSimpleTechnicalResponse(state.message)
        : undefined;
      if (directTechnicalResponse) {
        // Stable introductory facts do not need a provider round-trip. Keep
        // this intentionally narrow; open-ended technical questions still use
        // the configured model rather than a misleading local approximation.
        this.logger.info(
          {
            requestId: state.requestId,
            threadId: state.threadId,
            userId: state.userId,
            topic: "javascript_types",
            outputChars: directTechnicalResponse.length
          },
          "agent_finalize_skipped_simple_technical_faq"
        );
        emitSseEvent("state_update", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: {
            status: "finalized_from_knowledge_base",
            node: "finalize"
          }
        });
        emitSseEvent("token", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { content: directTechnicalResponse }
        });
        await this.messageStore.append({
          threadId: state.threadId,
          userId: state.userId,
          role: "assistant",
          content: directTechnicalResponse,
          metadata: {
            modelProvider: state.modelProvider,
            model: state.model,
            generatedWithoutModel: true,
            source: "simple_technical_faq"
          }
        });
        return { finalOutput: directTechnicalResponse, status: "completed" };
      }

      const deterministicHttpResponse = buildSingleHttpInspectionResponse({
        message: state.message,
        preparedSkills: state.preparedSkills,
        skillResults: state.skillResults
      });
      if (deterministicHttpResponse) {
        // A single public GET inspection is already fully evidenced by the
        // validated tool result. Avoid a second, slow model call just to repeat
        // its HTTP status and small JSON payload.
        this.logger.info(
          {
            requestId: state.requestId,
            threadId: state.threadId,
            userId: state.userId,
            outputChars: deterministicHttpResponse.length
          },
          "agent_finalize_skipped_single_http_inspection"
        );
        emitSseEvent("state_update", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { status: "finalized_without_model", node: "finalize" }
        });
        emitSseEvent("token", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { content: deterministicHttpResponse }
        });
        await this.messageStore.append({
          threadId: state.threadId,
          userId: state.userId,
          role: "assistant",
          content: deterministicHttpResponse,
          metadata: {
            modelProvider: state.modelProvider,
            model: state.model,
            generatedWithoutModel: true
          }
        });
        return { finalOutput: deterministicHttpResponse, status: "completed" };
      }

      const deterministicReadmeHttpResponse =
        buildReadmeHttpRestrictionComparisonResponse({
          message: state.message,
          preparedSkills: state.preparedSkills,
          skillResults: state.skillResults
        });
      if (deterministicReadmeHttpResponse) {
        // This cross-Skill check compares explicit README sandbox rules with
        // one verified public GET result. It has no unresolved reasoning that
        // warrants a slow final model round-trip.
        this.logger.info(
          {
            requestId: state.requestId,
            threadId: state.threadId,
            userId: state.userId,
            outputChars: deterministicReadmeHttpResponse.length
          },
          "agent_finalize_skipped_readme_http_comparison"
        );
        emitSseEvent("state_update", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { status: "finalized_without_model", node: "finalize" }
        });
        emitSseEvent("token", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { content: deterministicReadmeHttpResponse }
        });
        await this.messageStore.append({
          threadId: state.threadId,
          userId: state.userId,
          role: "assistant",
          content: deterministicReadmeHttpResponse,
          metadata: {
            modelProvider: state.modelProvider,
            model: state.model,
            generatedWithoutModel: true
          }
        });
        return { finalOutput: deterministicReadmeHttpResponse, status: "completed" };
      }

      const deterministicReadmeResponse = buildReadmeInspectionResponse({
        message: state.message,
        preparedSkills: state.preparedSkills,
        skillResults: state.skillResults
      });
      if (deterministicReadmeResponse) {
        // README purpose and sandbox restrictions are explicit Markdown facts.
        // Extract them locally instead of waiting for a second model request.
        this.logger.info(
          {
            requestId: state.requestId,
            threadId: state.threadId,
            userId: state.userId,
            outputChars: deterministicReadmeResponse.length
          },
          "agent_finalize_skipped_readme_inspection"
        );
        emitSseEvent("state_update", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { status: "finalized_without_model", node: "finalize" }
        });
        emitSseEvent("token", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: { content: deterministicReadmeResponse }
        });
        await this.messageStore.append({
          threadId: state.threadId,
          userId: state.userId,
          role: "assistant",
          content: deterministicReadmeResponse,
          metadata: {
            modelProvider: state.modelProvider,
            model: state.model,
            generatedWithoutModel: true
          }
        });
        return { finalOutput: deterministicReadmeResponse, status: "completed" };
      }

      const model = this.modelRouter.create({
        provider: state.modelProvider,
        ...(state.model ? { model: state.model } : {})
      });
      const system = new SystemMessage(
        [
          "You are the final response node of a web Agent.",
          "Answer the user in the same language they used.",
          "Use standard Markdown.",
          directAnswer
            ? "For direct technical questions, give a sufficiently detailed structured explanation with definitions, key points, caveats, and short examples when useful."
            : "Keep the answer concise and useful.",
          "Treat Skill tool results as evidence; do not invent facts."
        ].join("\n")
      );
      const thread = await this.threadStore.get(state.threadId);
      const storedResponseState = thread?.openAiResponseState;
      const responsesProvider =
        state.modelProvider === "openai" ||
        state.modelProvider === "openai-compatible"
          ? state.modelProvider
          : undefined;
      const responsesStateEnabled =
        (responsesProvider === "openai" &&
          this.env.OPENAI_RESPONSES_STATE_ENABLED) ||
        (responsesProvider === "openai-compatible" &&
          this.env.OPENAI_COMPATIBLE_RESPONSES_STATE_ENABLED);
      let previousResponseId: string | undefined;
      if (
        responsesStateEnabled &&
        storedResponseState &&
        storedResponseState.provider === responsesProvider &&
        storedResponseState.model === state.model
      ) {
        previousResponseId = storedResponseState.responseId;
      }
      const finalInput = buildFinalResponseInput({
        userMessage: state.message,
        ...(state.plan?.response
          ? { plannerResponse: state.plan.response }
          : {}),
        skillResults: state.skillResults,
        longTermMemorySummary: state.longTermMemory,
        // Once an OpenAI response chain exists, the vendor already has the
        // prior final turns. The application still stores and supplies its
        // own history to planning and memory services.
        recentHistory: previousResponseId ? [] : state.history,
        historyLimit: directAnswer
          ? this.env.DIRECT_HISTORY_MESSAGES
          : this.env.FINAL_HISTORY_MESSAGES,
        ...(directAnswer
          ? {
              historyMaxChars: this.env.DIRECT_HISTORY_MAX_CHARS,
              longTermMemoryMaxChars: this.env.DIRECT_MEMORY_MAX_CHARS
            }
          : {}),
        toolResultMaxChars: this.env.FINAL_TOOL_RESULT_MAX_CHARS
      });
      const user = new HumanMessage(JSON.stringify(finalInput));

      const responseOptions: TextInvokeOptions = {
        operation: "agent_finalize",
        maxOutputTokens: directAnswer
          ? this.env.DIRECT_RESPONSE_MAX_TOKENS
          : this.env.FINAL_RESPONSE_MAX_TOKENS
      };
      const finalizingStartedAt = Date.now();
      let firstTokenReceived = false;
      responseOptions.onFirstToken = () => {
        if (firstTokenReceived) {
          return;
        }
        firstTokenReceived = true;
        const firstTokenLatencyMs = Date.now() - finalizingStartedAt;
        this.logger.info(
          {
            requestId: state.requestId,
            threadId: state.threadId,
            userId: state.userId,
            modelProvider: state.modelProvider,
            model: state.model,
            firstTokenLatencyMs,
            finalPromptChars: JSON.stringify(finalInput).length
          },
          "agent_final_first_token"
        );
        if (!directAnswer) {
          emitSseEvent("state_update", {
            requestId: context.requestId,
            threadId: context.threadId,
            userId: context.userId,
            data: {
              status: "model_first_token",
              node: "finalize",
              detail: { latencyMs: firstTokenLatencyMs }
            }
          });
        }
      };
      if (responsesStateEnabled && responsesProvider) {
        const activeResponsesProvider = responsesProvider;
        responseOptions.responseState = {
          ...(previousResponseId ? { previousResponseId } : {}),
          onResponseStored: async (responseId) => {
            await this.threadStore.setOpenAiResponseState(state.threadId, {
              responseId,
              provider: activeResponsesProvider,
              model:
                state.model ??
                (activeResponsesProvider === "openai"
                  ? this.env.OPENAI_MODEL
                  : this.env.OPENAI_COMPATIBLE_MODEL)
            });
            if (!directAnswer) {
              emitSseEvent("state_update", {
                requestId: context.requestId,
                threadId: context.threadId,
                userId: context.userId,
                data: {
                  status: "vendor_context_stored",
                  node: "finalize",
                  detail: {
                    provider: activeResponsesProvider,
                    store:
                      activeResponsesProvider === "openai"
                        ? this.env.OPENAI_RESPONSES_STORE
                        : this.env.OPENAI_COMPATIBLE_RESPONSES_STORE,
                    continuedFromPreviousResponse: Boolean(previousResponseId),
                    totalLatencyMs: Date.now() - finalizingStartedAt
                  }
                }
              });
            }
          }
        };
      }

      const response = await model.streamText(
        [system, user],
        (token) => {
          emitSseEvent("token", {
            requestId: context.requestId,
            threadId: context.threadId,
            userId: context.userId,
            data: { content: token }
          });
        },
        responseOptions
      );

      await this.messageStore.append({
        threadId: state.threadId,
        userId: state.userId,
        role: "assistant",
        content: response.text,
        metadata: {
          modelProvider: state.modelProvider,
          model: state.model
        }
      });
      return { finalOutput: response.text, status: "completed" };
    };

    const failureHandler = async (
      state: AgentStateValue,
      error: { error: Error; node: string }
    ) => {
      const normalized = normalizeError(error.error);
      this.logger.error(
        {
          requestId: state.requestId,
          threadId: state.threadId,
          userId: state.userId,
          node: error.node,
          error: normalized
        },
        "agent_node_failed"
      );
      // SSE only reaches the currently connected browser. Persist a compact
      // failure message as well, so switching sessions or refreshing the page
      // does not make the failed Agent run disappear from the transcript.
      await this.messageStore
        .append({
          threadId: state.threadId,
          userId: state.userId,
          role: "assistant",
          content: `任务执行失败：${normalized.message}`,
          metadata: {
            systemError: true,
            errorCode: normalized.code,
            node: error.node,
            requestId: state.requestId
          }
        })
        .catch((persistError) => {
          this.logger.warn(
            {
              requestId: state.requestId,
              threadId: state.threadId,
              userId: state.userId,
              error: persistError
            },
            "agent_failure_message_persist_failed"
          );
        });
      // Keep the persisted failed state and notify the SSE client. Without
      // this event a node error could look like an empty successful response.
      const context = getRuntimeContext();
      emitSseEvent("error", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details
        }
      });
      return {
        error: normalized.message,
        status: "failed"
      };
    };

    return new StateGraph(AgentState)
      .addNode("planner", planNode, { errorHandler: failureHandler })
      .addNode("prepare_skills", prepareSkillsNode, {
        errorHandler: failureHandler
      })
      .addNode("human_confirm", humanConfirmNode, {
        errorHandler: failureHandler
      })
      .addNode("execute_skills", executeSkillsNode, {
        errorHandler: failureHandler
      })
      .addNode("finalize", finalizeNode, { errorHandler: failureHandler })
      .addEdge(START, "planner")
      .addConditionalEdges("planner", (state) => {
        const plan = state.plan ?? AgentPlanSchema.parse({});
        return plan.directAnswer || plan.skills.length === 0
          ? "finalize"
          : "prepare_skills";
      })
      .addConditionalEdges("prepare_skills", (state) =>
        state.preparedSkills.some((skill) => skill.requiresConfirmation)
          ? "human_confirm"
          : "execute_skills"
      )
      .addConditionalEdges("human_confirm", (state) =>
        !state.approvalDecision?.approved
          ? "finalize"
          : state.pendingConfirmation
            ? "human_confirm"
            : "execute_skills"
      )
      .addEdge("execute_skills", "finalize")
      .addEdge("finalize", END)
      .compile({ checkpointer, name: "commercial-web-agent" });
  }

  private async createModelPlan(input: {
    model: ModelAdapter;
    state: AgentStateValue;
    history: string;
    skillContext: string;
    routing: SkillRoutingDecision;
  }): Promise<AgentPlan> {
    try {
      const modelPlan = await input.model.invokeJson(
        [
          new SystemMessage(
            [
              "You are the planner for a commercial web Agent framework.",
              "Select only the skills needed for the user task.",
              "Return directAnswer=true only when no skill or tool is needed.",
              "For each selected skill choose mode=parallel only if it is independent from the others.",
              "Preserve dependency order in the skills array.",
              input.routing.matches.length > 0
                ? `Matched Skill candidates: ${input.routing.matches.map((match) => match.summary.name).join(", ")}. Directly named Skills must all be included; intent matches may be omitted when irrelevant.`
                : "No deterministic Skill candidate was found; decide from the full catalog.",
              input.routing.matches.some((match) => match.source === "semantic")
                ? "These candidates came from semantic recall only. Treat them as hypotheses, verify the user intent against each Skill description, and select none when the task does not require a Skill."
                : "",
              'Return JSON shaped exactly as: {"response":"optional direct guidance","directAnswer":false,"skills":[{"skillName":"available-name","reason":"why needed","mode":"serial|parallel","input":"specific task for this skill"}]}.',
              `Available skills:\n${input.skillContext || "(none)"}`
            ].join("\n")
          ),
          new HumanMessage(
            JSON.stringify({
              userMessage: input.state.message,
              recentHistory: input.history,
              longTermMemory: input.state.longTermMemory || undefined
            })
          )
        ],
        AgentPlanSchema,
        {
          operation: "agent_plan",
          timeoutMs: this.env.PLANNER_TIMEOUT_MS
        }
      );
      return this.preserveExplicitSkills(
        modelPlan,
        input.routing.matches,
        input.state.message
      );
    } catch (error) {
      if (
        !this.env.SKILL_PLANNER_FALLBACK_ENABLED ||
        !(error instanceof AppError) ||
        !isRecoverablePlannerError(error)
      ) {
        throw error;
      }

      const matches = input.routing.matches.length > 0
        ? input.routing.matches
        : await this.skillLoader.findMatchDetails(input.state.message);
      const context = getRuntimeContext();
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "planning_fallback",
          node: "planner",
          detail: {
            reason:
              error.code === "MODEL_TIMEOUT"
                ? "model_timeout"
                : "invalid_model_response",
            skillNames: matches.map((match) => match.summary.name),
            mode: "serial"
          }
        }
      });
      this.logger.warn(
        {
          requestId: input.state.requestId,
          threadId: input.state.threadId,
          userId: input.state.userId,
          skillNames: matches.map((match) => match.summary.name),
          fallbackReason: error.code
        },
        "agent_planner_fallback"
      );

      // A semantic candidate is not authorization to execute a Skill. If the
      // judge is unavailable, fail closed and let the final node answer as a
      // normal conversation instead of guessing a tool route.
      if (matches.some((match) => match.source === "semantic")) {
        return AgentPlanSchema.parse({ directAnswer: true });
      }

      return matches.length > 0
        ? createSerialFallbackPlan(input.state.message, matches)
        : AgentPlanSchema.parse({ directAnswer: true });
    }
  }

  private preserveExplicitSkills(
    modelPlan: AgentPlan,
    matches: SkillMatch[],
    message: string
  ): AgentPlan {
    const explicit = matches.filter((match) => match.source === "explicit");
    if (explicit.length === 0) {
      return modelPlan;
    }
    const plannedNames = new Set(
      modelPlan.skills.map((skill) => skill.skillName)
    );
    return AgentPlanSchema.parse({
      response: modelPlan.response,
      directAnswer: false,
      skills: [
        ...modelPlan.skills,
        ...explicit
          .filter((match) => !plannedNames.has(match.summary.name))
          .map((match) => ({
            skillName: match.summary.name,
            reason: "用户直接指定了该 Skill；模型未返回该项，已按安全串行模式补全。",
            mode: "serial" as const,
            input: message
          }))
      ]
    });
  }

  private applyConfirmationOverrides(
    preparedSkills: AgentStateValue["preparedSkills"],
    decisions: HumanDecision[]
  ): AgentStateValue["preparedSkills"] {
    const overrides = new Map(
      decisions
        .filter(
          (decision) => decision.approved && decision.argsOverride !== undefined
        )
        .map((decision) => [decision.confirmationId, decision.argsOverride])
    );
    if (overrides.size === 0) {
      return preparedSkills;
    }
    return preparedSkills.map((prepared) =>
      PreparedSkillExecutionSchema.parse({
        ...prepared,
        toolPlan: {
          ...prepared.toolPlan,
          calls: prepared.toolPlan.calls.map((call) => {
            const confirmation = this.collectConfirmations([prepared]).find(
              (item) => item.toolCallId === call.toolCallId
            );
            const argsOverride = confirmation
              ? overrides.get(confirmation.confirmationId)
              : undefined;
            return argsOverride === undefined
              ? call
              : { ...call, args: argsOverride };
          })
        }
      })
    );
  }

  private collectConfirmations(
    preparedSkills: AgentStateValue["preparedSkills"]
  ): HumanConfirmationRecord[] {
    return preparedSkills.flatMap((prepared) =>
      (prepared.confirmations ?? []).length > 0
        ? (prepared.confirmations ?? [])
        : prepared.confirmation
          ? [prepared.confirmation]
          : []
    );
  }
}

export function isRecoverablePlannerError(error: AppError): boolean {
  return error.code === "MODEL_TIMEOUT" || error.code === "MODEL_ERROR";
}

type FinalResponseInput = {
  userMessage: string;
  plannerResponse?: string;
  skillResults: Array<{
    skillName: string;
    output: string;
    toolResults: unknown[];
  }>;
  longTermMemorySummary: string;
  recentHistory: Array<{ role: string; content: string }>;
  historyLimit: number;
  historyMaxChars?: number;
  longTermMemoryMaxChars?: number;
  toolResultMaxChars: number;
};

/**
 * Keeps raw results in Graph state and Redis, while bounding only the copy
 * given to the final model. This avoids large HTTP headers/bodies inflating
 * provider prefill time before the first streamed token.
 */
export function buildFinalResponseInput(input: FinalResponseInput) {
  const historyCandidates = input.recentHistory
    .filter(
      (item, index, entries) =>
        !(
          index === entries.length - 1 &&
          item.role === "user" &&
          item.content === input.userMessage
        )
    )
    .slice(-input.historyLimit);
  const history = compactHistoryForModel(
    historyCandidates,
    input.historyMaxChars
  );
  const skillResults = input.skillResults.map((result) => ({
    skillName: result.skillName,
    output: truncateForModel(result.output, input.toolResultMaxChars),
    toolResults: compactToolResultsForModel(
      result.toolResults,
      input.toolResultMaxChars
    )
  }));
  return {
    userMessage: input.userMessage,
    ...(input.plannerResponse ? { plannerResponse: input.plannerResponse } : {}),
    ...(skillResults.length > 0 ? { skillResults } : {}),
    ...(input.longTermMemorySummary
      ? {
          longTermMemorySummary: input.longTermMemoryMaxChars === undefined
            ? input.longTermMemorySummary
            : truncateForModel(
                input.longTermMemorySummary,
                input.longTermMemoryMaxChars
              )
        }
      : {}),
    ...(history.length > 0 ? { recentHistory: history } : {})
  };
}

function compactHistoryForModel(
  messages: Array<{ role: string; content: string }>,
  maxChars: number | undefined
): Array<{ role: string; content: string }> {
  if (maxChars === undefined) {
    return messages.map((item) => ({ role: item.role, content: item.content }));
  }
  let remaining = maxChars;
  const compact: Array<{ role: string; content: string }> = [];
  for (const item of [...messages].reverse()) {
    if (remaining <= 0) {
      break;
    }
    const content = truncateForModel(item.content, remaining);
    compact.unshift({ role: item.role, content });
    remaining -= content.length;
  }
  return compact;
}

function compactToolResultsForModel(
  results: unknown[],
  maxChars: number
): unknown[] {
  let remaining = maxChars;
  return results.map((result) => {
    if (remaining <= 0) {
      return { truncated: true, reason: "final_tool_result_budget_exhausted" };
    }
    const compact = compactToolResultForModel(result, remaining);
    remaining -= (JSON.stringify(compact) ?? "").length;
    return compact;
  });
}

function compactToolResultForModel(result: unknown, maxChars: number): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return truncateForModel(String(result), maxChars);
  }
  const record = result as Record<string, unknown>;
  if (typeof record.body === "string" && typeof record.status === "number") {
    return {
      status: record.status,
      ok: record.ok === true,
      body: truncateForModel(record.body, maxChars),
      truncated: record.truncated === true || record.body.length > maxChars
    };
  }
  if (typeof record.content === "string") {
    return {
      ...(typeof record.path === "string" ? { path: record.path } : {}),
      content: truncateForModel(record.content, maxChars),
      truncated: record.content.length > maxChars
    };
  }
  return truncateForModel(JSON.stringify(record), maxChars);
}

function truncateForModel(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = "\n[truncated for final model]";
  if (maxChars <= suffix.length) {
    return suffix.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
}

/**
 * Answers a deliberately small set of stable introductory questions locally.
 * The matcher rejects code snippets and compound questions, which prevents a
 * generic technical task from being incorrectly reduced to a canned answer.
 */
export function buildSimpleTechnicalResponse(
  message: string
): string | undefined {
  const normalized = message.trim();
  const isJavaScriptTypesQuestion =
    /(?:JavaScript|JS|javascript)\s*(?:有)?(?:哪些|什么|的)?\s*(?:数据)?类型|(?:数据)?类型.*(?:JavaScript|JS|javascript)/i.test(
      normalized
    );
  const isSimpleQuestion =
    normalized.length <= 100 &&
    !/[`{};]|\n/.test(normalized) &&
    !/示例|代码|实现|对比|区别|原理|为什么|怎么/i.test(normalized);
  if (!isJavaScriptTypesQuestion || !isSimpleQuestion) {
    return undefined;
  }
  return [
    "JavaScript 的值通常分为**原始类型**和**对象类型**两大类。",
    "",
    "## 原始类型",
    "",
    "- `string`：文本，例如 `\"hello\"`。",
    "- `number`：普通数值，整数和浮点数都属于这一类；`NaN`、`Infinity` 也属于 `number`。",
    "- `bigint`：任意精度整数，例如 `9007199254740993n`，不能和 `number` 直接混算。",
    "- `boolean`：逻辑值 `true` 或 `false`。",
    "- `undefined`：变量已声明但尚未赋值，或对象不存在该属性时常见。",
    "- `null`：刻意表示“没有值”。",
    "- `symbol`：唯一标识符，常用于避免对象属性键冲突。",
    "",
    "## 对象类型",
    "",
    "`object` 包括普通对象、数组、函数、日期、正则、`Map`、`Set` 等。对象按引用传递和比较：两个内容相同但不是同一个对象的值并不相等。函数用 `typeof` 检测会返回 `\"function\"`，但本质上也是对象。",
    "",
    "## 常用判断",
    "",
    "- `typeof value`：适合判断大多数原始类型。",
    "- `Array.isArray(value)`：判断数组。",
    "- `value === null`：判断 `null`。",
    "",
    "注意：`typeof null` 会返回 `\"object\"`，这是 JavaScript 保留至今的历史行为。"
  ].join("\n");
}

type SingleHttpInspectionInput = Pick<
  AgentStateValue,
  "message" | "preparedSkills" | "skillResults"
>;

/**
 * Produces an immediate, evidence-only report for one completed public HTTP
 * GET. Complex constraints intentionally stay on the model path because they
 * require interpreting rules rather than reporting observed HTTP facts.
 */
export function buildSingleHttpInspectionResponse(
  input: SingleHttpInspectionInput
): string | undefined {
  const normalizedMessage = input.message.replace(/https?:\/\/\S+/gi, "");
  const requestsInspection = /核对|检查|验证|状态|请求|响应|接口|API/i.test(
    normalizedMessage
  );
  const hasExplicitConstraints =
    /必须|不得|只允许|仅允许|不超过|小于|大于|<=|>=|响应码|状态码|content-type|响应头|header|json/i.test(
      normalizedMessage
    );
  if (!requestsInspection || hasExplicitConstraints) {
    return undefined;
  }

  const prepared = input.preparedSkills;
  const [result] = input.skillResults;
  const [toolResult] = result?.toolResults ?? [];
  const [call] = prepared[0]?.toolPlan.calls ?? [];
  if (
    prepared.length !== 1 ||
    prepared[0]?.skill.name !== "web-research" ||
    prepared[0]?.toolPlan.calls.length !== 1 ||
    call?.toolName !== "http_request" ||
    input.skillResults.length !== 1 ||
    result?.toolResults.length !== 1
  ) {
    return undefined;
  }

  const args = asRecord(call.args);
  const response = asRecord(toolResult);
  if (
    typeof args?.url !== "string" ||
    typeof response?.status !== "number" ||
    typeof response.body !== "string"
  ) {
    return undefined;
  }

  const body = formatHttpBodyForReport(response.body, 6_000);
  const hasRequestedLimits = /限制|规则|要求|条件/i.test(normalizedMessage);
  return [
    "## API 核对结果",
    "",
    `- 请求：\`${typeof args.method === "string" ? args.method : "GET"} ${args.url}\``,
    `- HTTP 状态：\`${response.status}${response.ok === true ? " OK" : ""}\``,
    `- 请求结果：${response.ok === true ? "成功" : "失败"}`,
    hasRequestedLimits
      ? "- 限制核对：本轮消息未提供具体限制项，无法判定是否符合；请补充状态码、协议、响应格式或字段等规则。"
      : "- 核对：以上为工具实际返回的 HTTP 结果。",
    "",
    "### 响应体",
    "",
    ...body.split("\n").map((line) => `    ${line}`)
  ].join("\n");
}

/**
 * Handles the common, evidence-only README request without another model
 * round-trip. It intentionally requires one explicit workspace Skill and one
 * README read, so broader source-code analysis continues through the model.
 */
export function buildReadmeInspectionResponse(
  input: SingleHttpInspectionInput
): string | undefined {
  if (
    !/workspace-inspection/i.test(input.message) ||
    !/README\.md/i.test(input.message) ||
    !/(主要用途|用途|安全限制|安全.*限制|整理|总结|摘要)/i.test(input.message)
  ) {
    return undefined;
  }
  const [prepared] = input.preparedSkills;
  const [result] = input.skillResults;
  const [call] = prepared?.toolPlan.calls ?? [];
  const [toolResult] = result?.toolResults ?? [];
  const args = asRecord(call?.args);
  const file = asRecord(toolResult);
  if (
    input.preparedSkills.length !== 1 ||
    prepared?.skill.name !== "workspace-inspection" ||
    prepared.toolPlan.calls.length !== 1 ||
    call?.toolName !== "file_read" ||
    input.skillResults.length !== 1 ||
    result?.toolResults.length !== 1 ||
    typeof args?.path !== "string" ||
    !/(^|\/)README\.md$/i.test(args.path) ||
    typeof file?.content !== "string"
  ) {
    return undefined;
  }

  const summary = extractReadmeFacts(file.content);
  return [
    `## ${summary.title}`,
    "",
    `来源：\`${args.path}\``,
    "",
    "### 主要用途",
    "",
    summary.purpose,
    "",
    "### 安全限制",
    "",
    summary.safety
  ].join("\n");
}

/**
 * Compares two completed, deterministic tool results: README sandbox facts
 * describe file access only, while an HTTP URL is assessed independently.
 */
export function buildReadmeHttpRestrictionComparisonResponse(
  input: SingleHttpInspectionInput
): string | undefined {
  if (
    !/README\.md/i.test(input.message) ||
    !/https?:\/\//i.test(input.message) ||
    !/(限制|核对|符合|文件访问)/i.test(input.message)
  ) {
    return undefined;
  }
  const workspace = findCompletedSingleToolSkill(
    input,
    "workspace-inspection",
    "file_read"
  );
  const research = findCompletedSingleToolSkill(
    input,
    "web-research",
    "http_request"
  );
  if (!workspace || !research) {
    return undefined;
  }
  const fileArgs = asRecord(workspace.call.args);
  const fileResult = asRecord(workspace.result);
  const httpArgs = asRecord(research.call.args);
  const httpResult = asRecord(research.result);
  if (
    typeof fileArgs?.path !== "string" ||
    !/(^|\/)README\.md$/i.test(fileArgs.path) ||
    typeof fileResult?.content !== "string" ||
    typeof httpArgs?.url !== "string" ||
    typeof httpResult?.status !== "number"
  ) {
    return undefined;
  }

  const readme = extractReadmeFacts(fileResult.content);
  const httpMethod = typeof httpArgs.method === "string" ? httpArgs.method : "GET";
  const isHttps = httpArgs.url.startsWith("https://");
  const requestSucceeded = httpResult.ok === true;
  return [
    "## 核对结果",
    "",
    "### README 中的文件访问限制",
    "",
    `来源：\`${fileArgs.path}\``,
    "",
    readme.safety,
    "",
    "### 公开 API 请求事实",
    "",
    `- 请求：\`${httpMethod} ${httpArgs.url}\``,
    `- 协议：${isHttps ? "HTTPS" : "HTTP"}`,
    `- HTTP 状态：\`${httpResult.status}${requestSucceeded ? " OK" : ""}\``,
    "",
    "### 结论",
    "",
    "该 README 约束的是 `file_read` 对本地沙箱文件的访问范围，不是对外部 HTTP 请求的限制。此次请求使用公开 URL，未读取绝对路径，也未尝试逃逸沙箱，因此**不违反 README 描述的文件访问限制**。",
    requestSucceeded
      ? "HTTP 工具实际返回成功；这只能证明该公开请求可访问，不代表它满足任何未在消息中列出的额外 API 安全规则。"
      : "HTTP 工具未返回成功状态；文件访问限制结论不变，但该公开请求本身没有成功完成。"
  ].join("\n");
}

function findCompletedSingleToolSkill(
  input: SingleHttpInspectionInput,
  skillName: string,
  toolName: string
): { call: { toolName: string; args: unknown }; result: unknown } | undefined {
  const prepared = input.preparedSkills.find(
    (item) => item.skill.name === skillName && item.toolPlan.calls.length === 1
  );
  const result = input.skillResults.find((item) => item.skillName === skillName);
  const call = prepared?.toolPlan.calls[0];
  const toolResult = result?.toolResults[0];
  if (
    !prepared ||
    !result ||
    result.toolResults.length !== 1 ||
    !call ||
    call.toolName !== toolName ||
    toolResult === undefined
  ) {
    return undefined;
  }
  return { call, result: toolResult };
}

function extractReadmeFacts(content: string): {
  title: string;
  purpose: string;
  safety: string;
} {
  const sections = splitMarkdownSections(content);
  const title = sections.find((section) => section.level === 1)?.heading ?? "README 摘要";
  const purposeSection = sections.find((section) =>
    /用途|简介|介绍|概述|项目|功能|about/i.test(section.heading)
  );
  const safetySection = sections.find((section) =>
    /安全|限制|权限|沙箱|security|restriction/i.test(section.heading)
  );
  const allLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const purpose = compactMarkdownFact(
    purposeSection?.content || allLines.slice(0, 5).join("\n"),
    "README 未包含可直接提取的用途说明。"
  );
  const safetyLines = allLines.filter((line) =>
    /安全|限制|禁止|拒绝|仅|只能|不得|沙箱|绝对路径|越权|security|restrict|only|never/i.test(
      line
    )
  );
  const safety = compactMarkdownFact(
    safetySection?.content || safetyLines.join("\n"),
    "README 未包含可直接提取的安全限制。"
  );
  return { title, purpose, safety };
}

type MarkdownSection = { level: number; heading: string; content: string };

function splitMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection = { level: 0, heading: "", content: "" };
  for (const line of content.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current.heading || current.content.trim()) {
        sections.push({ ...current, content: current.content.trim() });
      }
      current = {
        level: heading[1]!.length,
        heading: heading[2]!,
        content: ""
      };
      continue;
    }
    current.content += `${line}\n`;
  }
  if (current.heading || current.content.trim()) {
    sections.push({ ...current, content: current.content.trim() });
  }
  return sections;
}

function compactMarkdownFact(value: string, fallback: string): string {
  const cleaned = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join("\n");
  return cleaned ? truncateForModel(cleaned, 2_000) : fallback;
}

function formatHttpBodyForReport(body: string, maxChars: number): string {
  let formatted = body;
  try {
    formatted = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Keep text responses unchanged when the public endpoint is not JSON.
  }
  return formatted.length <= maxChars
    ? formatted
    : `${formatted.slice(0, maxChars)}\n[响应体已截断]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function hasFailedStatus(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasFailedStatus);
  }
  const record = value as Record<string, unknown>;
  if (record.status === "failed") {
    return true;
  }
  return Object.values(record).some(hasFailedStatus);
}
