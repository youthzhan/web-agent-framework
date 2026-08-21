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
      const summaries = await this.skillLoader.listSummaries();
      const skillContext = this.skillEngine.formatSkillContext(summaries);
      const history = state.history
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n");

      // There is nothing to plan when no SKILL.md is installed. Skipping this
      // extra structured model call makes ordinary chat use one model request
      // and avoids timing out a planner that has no available capabilities.
      if (summaries.length === 0) {
        emitSseEvent("state_update", {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          data: {
            status: "planning_skipped",
            node: "planner",
            detail: { reason: "no_skills_available" }
          }
        });
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

      const matches = await this.skillLoader.findMatchDetails(state.message);
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
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: { status: "finalizing", node: "finalize" }
      });

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

      const model = this.modelRouter.create({
        provider: state.modelProvider,
        ...(state.model ? { model: state.model } : {})
      });
      const system = new SystemMessage(
        [
          "You are the final response node of a web Agent.",
          "Answer the user in the same language they used.",
          "Format the response as standard Markdown. Do not wrap the entire response in a code fence.",
          "Use skill results as evidence. Do not invent tool results.",
          "Keep the answer concise and useful."
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
      const user = new HumanMessage(
        JSON.stringify({
          userMessage: state.message,
            plannerResponse: state.plan?.response,
            skillResults: state.skillResults,
            longTermMemorySummary: state.longTermMemory || undefined,
            // Once an OpenAI response chain exists, the vendor already has the
            // prior final turns. The application still stores and supplies its
            // own history to planning and memory services.
            recentHistory: previousResponseId
              ? undefined
              : state.history.map((item) => ({
                  role: item.role,
                  content: item.content
                }))
        })
      );

      const responseOptions: TextInvokeOptions = { operation: "agent_finalize" };
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
                  continuedFromPreviousResponse: Boolean(previousResponseId)
                }
              }
            });
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
