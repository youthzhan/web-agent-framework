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
import { normalizeError } from "../common/errors.js";
import type { MessageStore } from "../persistence/message-store.js";
import type { ThreadStore } from "../persistence/thread-store.js";
import type { ModelRouter } from "../model/model-router.js";
import type { SkillLoader } from "../skills/skill-loader.js";
import type { SkillEngine } from "../skills/skill-engine.js";
import { AgentPlanSchema, PreparedSkillExecutionSchema } from "../skills/types.js";
import { AgentGraphInputSchema, AgentState, HumanDecisionSchema } from "./state.js";
import type { AgentGraphInput, AgentStateValue, HumanDecision } from "./state.js";

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
        status: "running"
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

      const plan = await model.invokeJson(
        [
          new SystemMessage(
            [
              "You are the planner for a commercial web Agent framework.",
              "Select only the skills needed for the user task.",
              "Return directAnswer=true only when no skill or tool is needed.",
              "For each selected skill choose mode=parallel only if it is independent from the others.",
              `Available skills:\n${skillContext || "(none)"}`
            ].join("\n")
          ),
          new HumanMessage(
            JSON.stringify({
              userMessage: state.message,
              recentHistory: history
            })
          )
        ],
        AgentPlanSchema,
        { operation: "agent_plan" }
      );

      this.logger.info(
        {
          requestId: state.requestId,
          threadId: state.threadId,
          userId: state.userId,
          selectedSkills: plan.skills.map((skill) => skill.skillName)
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
      const pending =
        state.pendingConfirmation ??
        state.preparedSkills.find((skill) => skill.requiresConfirmation)
          ?.confirmation;
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
      return {
        approvalDecision: parsed,
        status: parsed.approved ? "human_approved" : "human_rejected"
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
        state.approvalDecision,
        state.pendingConfirmation
      );
      if (state.approvalDecision?.approved) {
        await this.threadStore.clearPendingConfirmation(state.threadId);
      }

      const model = this.modelRouter.create({
        provider: state.modelProvider,
        ...(state.model ? { model: state.model } : {})
      });
      const skillResults = await this.skillEngine.executeManyPrepared(
        preparedSkills,
        model,
        { allowHighRisk: state.approvalDecision?.approved === true }
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
          "Use skill results as evidence. Do not invent tool results.",
          "Keep the answer concise and useful."
        ].join("\n")
      );
      const user = new HumanMessage(
        JSON.stringify({
          userMessage: state.message,
          plannerResponse: state.plan?.response,
          skillResults: state.skillResults,
          recentHistory: state.history.map((item) => ({
            role: item.role,
            content: item.content
          }))
        })
      );

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
        { operation: "agent_finalize" }
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
        state.approvalDecision?.approved ? "execute_skills" : "finalize"
      )
      .addEdge("execute_skills", "finalize")
      .addEdge("finalize", END)
      .compile({ checkpointer, name: "commercial-web-agent" });
  }

  private applyConfirmationOverrides(
    preparedSkills: AgentStateValue["preparedSkills"],
    decision: HumanDecision | undefined,
    pendingConfirmation: AgentStateValue["pendingConfirmation"]
  ): AgentStateValue["preparedSkills"] {
    if (!decision?.approved || decision.argsOverride === undefined) {
      return preparedSkills;
    }
    const targetToolCallId =
      pendingConfirmation?.toolCallId ?? decision.confirmationId.split(":").at(-1);
    return preparedSkills.map((prepared) =>
      PreparedSkillExecutionSchema.parse({
        ...prepared,
        toolPlan: {
          ...prepared.toolPlan,
          calls: prepared.toolPlan.calls.map((call) =>
            call.toolCallId === targetToolCallId
              ? { ...call, args: decision.argsOverride }
              : call
          )
        }
      })
    );
  }
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
