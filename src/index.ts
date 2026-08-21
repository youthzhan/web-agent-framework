import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify, {
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { AgentService } from "./agent/service.js";
import { AgentWorkflow } from "./agent/workflow.js";
import { AppError, normalizeError } from "./common/errors.js";
import { createLogger } from "./common/logger.js";
import { formatSse } from "./common/sse.js";
import { loadEnv } from "./config/env.js";
import { ModelRouter } from "./model/model-router.js";
import { ConversationMemoryService } from "./memory/conversation-memory-service.js";
import { ConversationMemoryStore } from "./memory/conversation-memory-store.js";
import { createRedisCheckpointer } from "./persistence/checkpointer.js";
import { MemoryPersistenceStore } from "./persistence/memory.js";
import { MessageStore } from "./persistence/message-store.js";
import { createRedisClient } from "./persistence/redis.js";
import type { PersistenceStore } from "./persistence/store.js";
import { ThreadStore } from "./persistence/thread-store.js";
import {
  ChatRequestSchema,
  HumanConfirmationSchema,
  ThreadParamsSchema
} from "./schemas/api.js";
import { SkillEngine } from "./skills/skill-engine.js";
import { SkillLoader } from "./skills/skill-loader.js";
import { ToolExecutor } from "./tools/executor.js";
import { createFileReadTool } from "./tools/file-read.js";
import { createHttpRequestTool } from "./tools/http-request.js";
import { InMemoryToolRegistry } from "./tools/registry.js";
import { AGENT_CHAT_HTML } from "./ui/agent-chat.js";

const SSE_HEADERS = {
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
  "x-accel-buffering": "no"
} as const;

// A small zero-dependency playground keeps the framework immediately usable
// after startup. Production deployments can replace this route with a real
// frontend while continuing to use the same JSON/SSE API contracts.
const EVENT_DEBUG_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Web Agent Playground</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #101315;
        color: #e7eceb;
        --surface: #171c1e;
        --surface-2: #1d2426;
        --line: #344044;
        --muted: #9ba8a8;
        --accent: #63d2ad;
        --danger: #ff8d8d;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #101315; }
      .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 44px; }
      header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
      h1 { margin: 0; font-size: clamp(26px, 4vw, 42px); letter-spacing: 0; line-height: 1.1; }
      .subtitle { color: var(--muted); margin: 9px 0 0; font-size: 14px; }
      .badge { border: 1px solid #3b6d5e; color: var(--accent); padding: 7px 10px; font-size: 12px; white-space: nowrap; }
      .layout { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(300px, .9fr); gap: 16px; align-items: start; }
      .panel { background: var(--surface); border: 1px solid var(--line); padding: 18px; }
      .panel h2 { margin: 0 0 16px; font-size: 16px; font-weight: 650; }
      .field { display: grid; gap: 7px; margin-bottom: 13px; }
      label { color: #c9d2d0; font-size: 13px; }
      input, textarea, select, button { font: inherit; }
      input, textarea, select { width: 100%; color: #eef4f2; background: var(--surface-2); border: 1px solid var(--line); padding: 10px 11px; outline: none; border-radius: 4px; }
      input:focus, textarea:focus, select:focus { border-color: var(--accent); }
      textarea { min-height: 110px; resize: vertical; line-height: 1.45; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 5px; }
      button { border: 1px solid #4b766a; background: #234d42; color: #effffc; padding: 10px 14px; border-radius: 4px; cursor: pointer; }
      button:hover { background: #2d6254; }
      button.secondary { background: transparent; border-color: var(--line); color: #c8d0cf; }
      button.danger { background: #592f35; border-color: #92535c; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .status { min-height: 20px; color: var(--muted); font-size: 13px; margin-top: 12px; }
      .status.error { color: var(--danger); }
      .stream { min-height: 410px; max-height: 620px; overflow: auto; background: #0c1011; border: 1px solid var(--line); padding: 12px; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .event { border-bottom: 1px solid #20292b; padding: 8px 0; white-space: pre-wrap; word-break: break-word; }
      .event:last-child { border-bottom: 0; }
      .event-type { color: var(--accent); font-weight: 700; }
      .event-data { color: #c5cfcd; margin-top: 3px; }
      .confirm { display: none; border-color: #92704b; background: #282016; margin-top: 16px; }
      .confirm.visible { display: block; }
      .confirm h2 { color: #f2c486; }
      .confirm-meta { color: #d7c2a8; font-size: 13px; line-height: 1.45; margin-bottom: 12px; }
      .hint { color: var(--muted); font-size: 12px; line-height: 1.45; }
      @media (max-width: 820px) {
        .shell { width: min(100% - 20px, 700px); padding-top: 18px; }
        header { align-items: flex-start; flex-direction: column; }
        .layout { grid-template-columns: 1fr; }
        .stream { min-height: 300px; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <div>
          <h1>Web Agent Playground</h1>
          <p class="subtitle">LangGraph 状态流、工具调用与人工确认调试台</p>
        </div>
        <div class="badge">SSE / StateGraph</div>
      </header>

      <div class="layout">
        <section class="panel">
          <h2>发送消息</h2>
          <div class="row">
            <div class="field">
              <label for="userId">用户 ID</label>
              <input id="userId" value="demo-user" autocomplete="off" />
            </div>
            <div class="field">
              <label for="threadId">会话 ID（可选）</label>
              <input id="threadId" placeholder="首次发送自动创建" autocomplete="off" />
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label for="provider">模型提供商（可选）</label>
              <select id="provider">
                <option value="">使用服务端默认模型</option>
                <option value="openai">OpenAI</option>
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div class="field">
              <label for="model">模型名（可选）</label>
              <input id="model" placeholder="使用服务端默认模型" autocomplete="off" />
            </div>
          </div>
          <div class="field">
            <label for="apiKey">API Key（仅启用 AUTH_API_KEY 时填写）</label>
            <input id="apiKey" type="password" placeholder="可留空" autocomplete="off" />
          </div>
          <div class="field">
            <label for="message">消息</label>
            <textarea id="message" placeholder="例如：读取工作目录下的 README.md，并总结主要内容"></textarea>
          </div>
          <div class="actions">
            <button id="send" type="button">发送消息</button>
            <button id="clear" class="secondary" type="button">清空事件</button>
          </div>
          <div id="status" class="status">就绪</div>
        </section>

        <section class="panel">
          <h2>实时事件</h2>
          <div id="stream" class="stream"><div class="hint">发送消息后，这里会显示 token、工具调用、状态更新和完成事件。</div></div>
          <div id="confirm" class="panel confirm">
            <h2>等待人工确认</h2>
            <div id="confirmMeta" class="confirm-meta"></div>
            <div class="field">
              <label for="confirmArgs">工具参数 JSON（可修改）</label>
              <textarea id="confirmArgs"></textarea>
            </div>
            <div class="field">
              <label for="confirmReason">审批备注（可选）</label>
              <input id="confirmReason" placeholder="例如：确认访问该地址" />
            </div>
            <div class="actions">
              <button id="approve" type="button">确认执行</button>
              <button id="reject" class="danger" type="button">拒绝执行</button>
            </div>
          </div>
        </section>
      </div>
    </main>

    <script>
      const $ = (id) => document.getElementById(id);
      let activeConfirmation = null;
      let activeController = null;

      function setStatus(message, isError = false) {
        $("status").textContent = message;
        $("status").className = isError ? "status error" : "status";
      }

      function addEvent(type, data) {
        const stream = $("stream");
        const empty = stream.querySelector(".hint");
        if (empty) empty.remove();
        const item = document.createElement("div");
        item.className = "event";
        const title = document.createElement("div");
        title.innerHTML = '<span class="event-type">' + escapeHtml(type) + '</span>';
        const body = document.createElement("div");
        body.className = "event-data";
        body.textContent = JSON.stringify(data, null, 2);
        item.append(title, body);
        stream.appendChild(item);
        stream.scrollTop = stream.scrollHeight;
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
      }

      function showConfirmation(record) {
        activeConfirmation = record;
        const method = record.args && record.args.method ? record.args.method : "";
        const target = record.args && (record.args.url || record.args.path) ? (record.args.url || record.args.path) : "未提供目标";
        $("confirm").classList.add("visible");
        $("confirmMeta").textContent = record.toolName + "：" + (method ? method + " " : "") + target + "（确认 ID：" + record.confirmationId + "）";
        $("confirmArgs").value = JSON.stringify(record.args, null, 2);
      }

      function hideConfirmation() {
        activeConfirmation = null;
        $("confirm").classList.remove("visible");
      }

      async function streamRequest(url, payload) {
        if (activeController) activeController.abort();
        activeController = new AbortController();
        const headers = {"content-type": "application/json", "accept": "text/event-stream"};
        const apiKey = $("apiKey").value.trim();
        if (apiKey) headers["x-api-key"] = apiKey;
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: activeController.signal });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(response.status + " " + text);
        }
        if (!response.body) throw new Error("浏览器未提供 SSE 响应流");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split("\\n\\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const dataLine = frame.split("\\n").find((line) => line.startsWith("data: "));
            if (!dataLine) continue;
            const event = JSON.parse(dataLine.slice(6));
            addEvent(event.type, event.data);
            if (event.type === "need_human_confirm") showConfirmation(event.data);
            if (event.type === "done") setStatus("任务结束：" + event.data.status);
            if (event.type === "error") setStatus(event.data.message, true);
          }
        }
      }

      $("send").addEventListener("click", async () => {
        const message = $("message").value.trim();
        if (!message) return setStatus("请输入消息", true);
        const payload = { message, userId: $("userId").value.trim() || "anonymous" };
        const threadId = $("threadId").value.trim();
        const provider = $("provider").value;
        const model = $("model").value.trim();
        if (threadId) payload.threadId = threadId;
        if (provider) payload.modelProvider = provider;
        if (model) payload.model = model;
        hideConfirmation();
        setStatus("正在执行…");
        $("send").disabled = true;
        try { await streamRequest("/v1/chat/stream", payload); }
        catch (error) { if (error.name !== "AbortError") setStatus(error.message, true); }
        finally { $("send").disabled = false; }
      });

      async function submitConfirmation(approved) {
        if (!activeConfirmation) return;
        const confirmation = activeConfirmation;
        let argsOverride;
        try { argsOverride = JSON.parse($("confirmArgs").value); }
        catch { return setStatus("工具参数不是合法 JSON", true); }
        const payload = {
          threadId: confirmation.threadId,
          userId: $("userId").value.trim() || confirmation.userId || "anonymous",
          confirmationId: confirmation.confirmationId,
          approved,
          reason: $("confirmReason").value.trim() || undefined,
          argsOverride
        };
        setStatus(approved ? "已确认，继续执行…" : "已拒绝，结束任务…");
        $("approve").disabled = true;
        $("reject").disabled = true;
        try {
          await streamRequest("/v1/chat/confirm/stream", payload);
          if (activeConfirmation?.confirmationId === confirmation.confirmationId) hideConfirmation();
        }
        catch (error) { if (error.name !== "AbortError") setStatus(error.message, true); }
        finally { $("approve").disabled = false; $("reject").disabled = false; }
      }

      $("approve").addEventListener("click", () => submitConfirmation(true));
      $("reject").addEventListener("click", () => submitConfirmation(false));
      $("clear").addEventListener("click", () => {
        $("stream").innerHTML = '<div class="hint">发送消息后，这里会显示 token、工具调用、状态更新和完成事件。</div>';
        setStatus("就绪");
      });
    </script>
  </body>
</html>`;

async function writeSse(
  reply: FastifyReply,
  events: AsyncIterable<Parameters<typeof formatSse>[0]>
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, SSE_HEADERS);
  reply.raw.flushHeaders?.();

  // A heartbeat keeps proxies from closing an otherwise quiet model stream.
  const heartbeat = setInterval(() => {
    reply.raw.write(": heartbeat\n\n");
  }, 15_000);

  try {
    for await (const event of events) {
      if (reply.raw.destroyed) {
        break;
      }
      reply.raw.write(formatSse(event));
    }
  } finally {
    clearInterval(heartbeat);
    if (!reply.raw.destroyed) {
      reply.raw.end();
    }
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const [markedBrowserScript, domPurifyBrowserScript] = await Promise.all([
    fs.readFile(
      path.resolve(process.cwd(), "node_modules/marked/lib/marked.umd.js"),
      "utf8"
    ),
    fs.readFile(
      path.resolve(process.cwd(), "node_modules/dompurify/dist/purify.min.js"),
      "utf8"
    )
  ]);
  const server = Fastify({
    loggerInstance: logger,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID()
  });

  await server.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "x-api-key", "x-request-id"]
  });

  server.addHook("onRequest", async (request, reply) => {
    const publicPage =
      request.method === "GET" &&
      [
        "/",
        "/health",
        "/debug/events",
        "/assets/marked.umd.js",
        "/assets/purify.min.js"
      ].includes(request.url.split("?")[0] ?? "");
    if (
      env.AUTH_API_KEY &&
      !publicPage &&
      request.headers["x-api-key"] !== env.AUTH_API_KEY
    ) {
      await reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "Invalid or missing x-api-key"
      });
    }
  });

  let persistence: PersistenceStore;
  if (env.checkpointBackend === "redis") {
    const redisPersistence = createRedisClient(env, logger);
    try {
      await redisPersistence.connect();
    } catch (error) {
      redisPersistence.disconnect();
      throw new AppError(
        "PERSISTENCE_ERROR",
        `Redis is unavailable at ${env.REDIS_URL}. Start Redis Stack before running the Agent service.`,
        {
          statusCode: 503,
          details: {
            redisUrl: env.REDIS_URL,
            command: "docker compose up -d redis"
          },
          cause: error
        }
      );
    }
    persistence = redisPersistence;
  } else {
    persistence = new MemoryPersistenceStore();
  }
  const checkpointer = await createRedisCheckpointer(env);

  const messageStore = new MessageStore(persistence, env);
  const threadStore = new ThreadStore(persistence, env);
  const memoryStore = new ConversationMemoryStore(persistence, env);
  const modelRouter = new ModelRouter(env, logger);
  const conversationMemory = new ConversationMemoryService(
    env,
    logger,
    messageStore,
    memoryStore,
    modelRouter
  );
  const registry = new InMemoryToolRegistry();
  registry.register(createFileReadTool(env));
  registry.register(createHttpRequestTool(env));

  const skillLoader = new SkillLoader(env.skillsDirAbs, logger);
  const toolExecutor = new ToolExecutor(registry, threadStore, logger);
  const skillEngine = new SkillEngine(
    env,
    skillLoader,
    registry,
    toolExecutor,
    threadStore,
    logger
  );
  const workflow = new AgentWorkflow(
    env,
    logger,
    modelRouter,
    skillLoader,
    skillEngine,
    messageStore,
    threadStore,
    checkpointer
  );
  const agentService = new AgentService(
    env,
    logger,
    workflow,
    messageStore,
    threadStore,
    conversationMemory
  );

  server.get("/health", async () => ({
    status: "ok",
    service: "web-agent-framework"
  }));

  server.get("/assets/marked.umd.js", async (_request, reply) => {
    return await reply
      .header("cache-control", "public, max-age=86400, immutable")
      .type("application/javascript; charset=utf-8")
      .send(markedBrowserScript);
  });

  server.get("/assets/purify.min.js", async (_request, reply) => {
    return await reply
      .header("cache-control", "public, max-age=86400, immutable")
      .type("application/javascript; charset=utf-8")
      .send(domPurifyBrowserScript);
  });

  // Expose only operator-approved routing metadata. API keys remain server-only.
  server.get("/v1/models", async () => ({
    defaultModelId: env.modelCatalog[0]?.id,
    models: env.modelCatalog
  }));

  server.get("/", async (_request, reply) => {
    return await reply.type("text/html; charset=utf-8").send(AGENT_CHAT_HTML);
  });

  server.get("/debug/events", async (_request, reply) => {
    return await reply.type("text/html; charset=utf-8").send(EVENT_DEBUG_HTML);
  });

  server.post("/v1/chat/stream", async (request, reply) => {
    try {
      const chatRequest = ChatRequestSchema.parse(request.body);
      const run = agentService.runChat(request.id, chatRequest);
      await writeSse(reply, run.events);
    } catch (error) {
      await sendRouteError(reply, error);
    }
  });

  server.post("/v1/chat/confirm/stream", async (request, reply) => {
    try {
      const confirmation = HumanConfirmationSchema.parse(request.body);
      const run = agentService.runConfirmation(request.id, confirmation);
      await writeSse(reply, run.events);
    } catch (error) {
      await sendRouteError(reply, error);
    }
  });

  server.get("/v1/threads/:threadId", async (request, reply) => {
    try {
      const { threadId } = ThreadParamsSchema.parse(request.params);
      const thread = await threadStore.get(threadId);
      if (!thread) {
        return await reply.code(404).send({
          code: "BAD_REQUEST",
          message: "Thread not found"
        });
      }
      const messages = await messageStore.list(threadId);
      return { thread, messages };
    } catch (error) {
      await sendRouteError(reply, error);
    }
  });

  server.addHook("onClose", async () => {
    await Promise.allSettled([
      persistence.quit(),
      "end" in checkpointer && typeof checkpointer.end === "function"
        ? checkpointer.end()
        : Promise.resolve()
    ]);
  });

  await server.listen({ host: env.HOST, port: env.PORT });
  logger.info(
    { host: env.HOST, port: env.PORT, checkpointBackend: env.checkpointBackend },
    "web_agent_server_started"
  );
}

async function sendRouteError(
  reply: FastifyReply,
  error: unknown
): Promise<void> {
  const normalized =
    error instanceof ZodError
      ? normalizeError(error)
      : normalizeError(error);
  await reply.code(normalized.statusCode).send({
    code: normalized.code,
    message: normalized.message,
    details: normalized.details
  });
}

void main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  // Fastify is not initialized when bootstrap fails, so use stderr directly.
  console.error(
    JSON.stringify({
      level: "fatal",
      code: normalized.code,
      message: normalized.message,
      details: normalized.details
    })
  );
  process.exitCode = 1;
});
