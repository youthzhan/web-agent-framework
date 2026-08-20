// This page intentionally has no frontend build dependency. It is served by
// Fastify and talks to the same public SSE endpoints as a standalone web app.
export const AGENT_CHAT_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Agent Workspace</title>
    <style>
      :root {
        font-family: Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #202522;
        background: #f5f7f5;
        --canvas: #f5f7f5;
        --surface: #ffffff;
        --surface-muted: #eef2ef;
        --ink: #202522;
        --muted: #68736d;
        --line: #dce3df;
        --line-strong: #c8d2cc;
        --accent: #167a59;
        --accent-dark: #105b43;
        --accent-soft: #e6f3ed;
        --warning: #9a6417;
        --warning-soft: #fff6e7;
        --danger: #ad3434;
        --danger-soft: #fff0f0;
        --shadow: 0 12px 34px rgba(30, 45, 37, 0.08);
      }

      * { box-sizing: border-box; }
      html, body { width: 100%; min-width: 320px; height: 100%; }
      body { margin: 0; overflow: hidden; background: var(--canvas); }
      button, input, textarea, select { font: inherit; letter-spacing: 0; }
      button { cursor: pointer; }

      .app {
        display: grid;
        grid-template-columns: 252px minmax(0, 1fr) 316px;
        width: 100%;
        height: 100dvh;
      }

      .sidebar,
      .inspector {
        min-width: 0;
        background: var(--surface);
        z-index: 10;
      }

      .sidebar {
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--line);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 11px;
        height: 68px;
        padding: 0 18px;
        border-bottom: 1px solid var(--line);
      }

      .brand-mark,
      .avatar {
        display: grid;
        place-items: center;
        flex: 0 0 auto;
        color: #fff;
        background: var(--accent);
        font-weight: 750;
      }

      .brand-mark { width: 32px; height: 32px; border-radius: 6px; font-size: 15px; }
      .brand-name { font-size: 15px; font-weight: 720; }
      .brand-subtitle { margin-top: 2px; color: var(--muted); font-size: 11px; }

      .new-chat {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 42px;
        margin: 16px;
        border: 1px solid var(--accent);
        border-radius: 5px;
        color: var(--accent-dark);
        background: #fff;
        font-weight: 650;
      }

      .new-chat:hover { background: var(--accent-soft); }
      .section-label { padding: 5px 18px 8px; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
      .sessions { flex: 1; min-height: 0; overflow-y: auto; padding: 0 9px 12px; }

      .session {
        display: block;
        width: 100%;
        margin-bottom: 3px;
        padding: 10px 9px;
        overflow: hidden;
        border: 0;
        border-radius: 5px;
        color: var(--ink);
        background: transparent;
        text-align: left;
      }

      .session:hover { background: var(--surface-muted); }
      .session.active { background: var(--accent-soft); color: var(--accent-dark); }
      .session-title { display: block; overflow: hidden; font-size: 13px; font-weight: 630; text-overflow: ellipsis; white-space: nowrap; }
      .session-time { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; }
      .sessions-empty { padding: 18px 10px; color: var(--muted); font-size: 12px; line-height: 1.6; text-align: center; }

      .sidebar-footer {
        padding: 13px 16px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
        line-height: 1.5;
      }

      .conversation { display: flex; min-width: 0; min-height: 0; flex-direction: column; background: var(--canvas); }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex: 0 0 68px;
        gap: 12px;
        padding: 0 22px;
        border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.92);
      }

      .conversation-title { min-width: 0; }
      .conversation-title strong { display: block; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
      .conversation-title span { display: block; margin-top: 3px; overflow: hidden; color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
      .status-line { display: flex; align-items: center; flex: 0 0 auto; gap: 7px; color: var(--muted); font-size: 12px; }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #819088; }
      .status-dot.running { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
      .status-dot.waiting { background: #d7922b; box-shadow: 0 0 0 4px var(--warning-soft); }
      .status-dot.failed { background: var(--danger); box-shadow: 0 0 0 4px var(--danger-soft); }
      .mobile-controls { display: none; gap: 6px; }

      .icon-button {
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        padding: 0;
        border: 1px solid var(--line);
        border-radius: 5px;
        color: var(--ink);
        background: #fff;
        font-size: 16px;
      }

      .messages {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        scroll-behavior: smooth;
      }

      .messages-inner { width: min(820px, calc(100% - 40px)); margin: 0 auto; padding: 32px 0 24px; }
      .welcome { padding: min(12vh, 88px) 0 40px; }
      .welcome-mark { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 7px; color: white; background: var(--accent); font-size: 20px; font-weight: 750; }
      .welcome h1 { max-width: 620px; margin: 20px 0 10px; font-size: 30px; line-height: 1.25; letter-spacing: 0; }
      .welcome p { max-width: 620px; margin: 0; color: var(--muted); font-size: 14px; line-height: 1.7; }
      .suggestions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 28px; }
      .suggestion { min-height: 74px; padding: 13px 14px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: var(--surface); text-align: left; line-height: 1.45; }
      .suggestion:hover { border-color: var(--line-strong); box-shadow: var(--shadow); }
      .suggestion strong { display: block; margin-bottom: 4px; font-size: 13px; }
      .suggestion span { color: var(--muted); font-size: 12px; }

      .message { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 11px; margin: 0 0 26px; }
      .message.user { grid-template-columns: minmax(0, 1fr); justify-items: end; }
      .avatar { width: 30px; height: 30px; border-radius: 5px; font-size: 12px; }
      .message-body { min-width: 0; max-width: 100%; }
      .message-label { margin-bottom: 7px; color: var(--muted); font-size: 11px; font-weight: 650; }
      .message-content { font-size: 14px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
      .message.user .message-content { max-width: min(620px, 82%); padding: 10px 14px; border-radius: 6px; color: #fff; background: #27302b; }
      .message.error .message-content { padding: 10px 12px; border-left: 3px solid var(--danger); color: var(--danger); background: var(--danger-soft); }
      .typing::after { content: ""; display: inline-block; width: 7px; height: 15px; margin-left: 3px; vertical-align: -2px; background: var(--accent); animation: blink 0.9s steps(1) infinite; }
      @keyframes blink { 50% { opacity: 0; } }

      .approval-notice { margin: -8px 0 24px 43px; padding: 12px 14px; border: 1px solid #eccb99; border-radius: 6px; background: var(--warning-soft); color: #714a13; font-size: 13px; line-height: 1.5; }
      .approval-notice button { margin-top: 9px; border: 0; padding: 0; color: var(--warning); background: transparent; font-size: 12px; font-weight: 700; }

      .composer-wrap { flex: 0 0 auto; padding: 12px 20px 20px; background: linear-gradient(to bottom, rgba(245,247,245,0), var(--canvas) 20%); }
      .composer { width: min(820px, 100%); margin: 0 auto; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface); box-shadow: 0 8px 28px rgba(32, 50, 41, 0.07); }
      .composer textarea { display: block; width: 100%; min-height: 54px; max-height: 180px; padding: 15px 16px 8px; resize: none; border: 0; outline: 0; color: var(--ink); background: transparent; line-height: 1.5; }
      .composer-footer { display: flex; align-items: center; justify-content: space-between; min-height: 46px; padding: 6px 8px 8px 14px; }
      .composer-hint { color: var(--muted); font-size: 11px; }
      .composer-actions { display: flex; gap: 7px; }
      .send-button, .stop-button { min-width: 64px; height: 34px; border: 0; border-radius: 5px; color: #fff; background: var(--accent); font-weight: 680; }
      .send-button:hover { background: var(--accent-dark); }
      .stop-button { display: none; background: #4d5651; }
      .is-running .send-button { display: none; }
      .is-running .stop-button { display: block; }
      .send-button:disabled { opacity: 0.45; cursor: not-allowed; }

      .inspector { display: flex; min-height: 0; flex-direction: column; border-left: 1px solid var(--line); }
      .inspector-header { display: flex; align-items: center; justify-content: space-between; flex: 0 0 68px; padding: 0 18px; border-bottom: 1px solid var(--line); }
      .inspector-header h2 { margin: 0; font-size: 14px; }
      .close-inspector { display: none; }
      .inspector-scroll { min-height: 0; overflow-y: auto; }
      .inspector-section { padding: 17px 18px; border-bottom: 1px solid var(--line); }
      .inspector-section h3 { margin: 0 0 13px; color: var(--muted); font-size: 11px; text-transform: uppercase; }
      .field { margin-bottom: 11px; }
      .field:last-child { margin-bottom: 0; }
      .field label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 11px; }
      .field input, .field select, .field textarea { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 4px; outline: none; color: var(--ink); background: #fff; font-size: 12px; }
      .field textarea { min-height: 94px; resize: vertical; font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .field input:focus, .field select:focus, .field textarea:focus { border-color: var(--accent); }
      .thread-value { color: var(--muted); font: 10px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
      .activity { display: grid; gap: 8px; }
      .activity-empty { color: var(--muted); font-size: 12px; line-height: 1.6; }
      .activity-item { padding: 9px 10px; border-left: 2px solid var(--line-strong); background: var(--canvas); }
      .activity-item.tool { border-left-color: #3b73a5; }
      .activity-item.success { border-left-color: var(--accent); }
      .activity-item.warning { border-left-color: #d7922b; }
      .activity-item.error { border-left-color: var(--danger); }
      .activity-title { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 680; }
      .activity-time { color: var(--muted); font-size: 10px; font-weight: 400; }
      .activity-detail { margin-top: 5px; color: var(--muted); font: 10px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }

      .approval { display: none; padding: 16px 18px; border-bottom: 1px solid #eccb99; background: var(--warning-soft); }
      .approval.visible { display: block; }
      .approval h3 { margin: 0 0 8px; color: #714a13; font-size: 13px; }
      .approval-meta { margin-bottom: 12px; color: #795827; font-size: 11px; line-height: 1.55; }
      .approval-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
      .approval-actions button { height: 34px; border-radius: 4px; font-size: 12px; font-weight: 680; }
      .approve { border: 1px solid var(--accent); color: #fff; background: var(--accent); }
      .reject { border: 1px solid #dbaaaa; color: var(--danger); background: #fff; }
      .approval-actions button:disabled { opacity: 0.5; cursor: not-allowed; }

      .scrim { display: none; position: fixed; inset: 0; z-index: 20; background: rgba(19, 27, 23, 0.38); }

      @media (max-width: 1100px) {
        .app { grid-template-columns: 224px minmax(0, 1fr); }
        .inspector { position: fixed; top: 0; right: 0; bottom: 0; width: min(340px, 90vw); transform: translateX(105%); box-shadow: var(--shadow); transition: transform 180ms ease; z-index: 30; }
        body.show-inspector .inspector { transform: translateX(0); }
        body.show-inspector .scrim { display: block; }
        .mobile-controls { display: flex; }
        .close-inspector { display: grid; }
      }

      @media (max-width: 720px) {
        .app { grid-template-columns: minmax(0, 1fr); }
        .sidebar { position: fixed; top: 0; left: 0; bottom: 0; width: min(280px, 88vw); transform: translateX(-105%); box-shadow: var(--shadow); transition: transform 180ms ease; z-index: 30; }
        body.show-sessions .sidebar { transform: translateX(0); }
        body.show-sessions .scrim { display: block; }
        .topbar { height: 60px; padding: 0 12px; }
        .mobile-controls { display: flex; }
        .messages-inner { width: calc(100% - 24px); padding-top: 22px; }
        .welcome { padding-top: 8vh; }
        .welcome h1 { font-size: 25px; }
        .suggestions { grid-template-columns: 1fr; }
        .composer-wrap { padding: 10px 10px 12px; }
        .composer-hint { display: none; }
        .message.user .message-content { max-width: 90%; }
        .status-line span { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <aside class="sidebar" aria-label="会话列表">
        <div class="brand">
          <div class="brand-mark">A</div>
          <div><div class="brand-name">Agent Workspace</div><div class="brand-subtitle">LangGraph runtime</div></div>
        </div>
        <button id="newChat" class="new-chat" type="button"><span>+</span><span>新对话</span></button>
        <div class="section-label">最近会话</div>
        <div id="sessions" class="sessions"></div>
        <div class="sidebar-footer">会话列表保存在当前浏览器。消息与执行状态由服务端持久化。</div>
      </aside>

      <main id="conversation" class="conversation">
        <header class="topbar">
          <div class="mobile-controls">
            <button id="openSessions" class="icon-button" type="button" title="打开会话列表" aria-label="打开会话列表">☰</button>
          </div>
          <div class="conversation-title">
            <strong id="chatTitle">新对话</strong>
            <span id="threadLabel">尚未创建会话</span>
          </div>
          <div class="status-line"><i id="statusDot" class="status-dot"></i><span id="statusText">就绪</span></div>
          <div class="mobile-controls">
            <button id="openInspector" class="icon-button" type="button" title="打开运行详情" aria-label="打开运行详情">⚙</button>
          </div>
        </header>

        <section id="messages" class="messages" aria-live="polite">
          <div id="messagesInner" class="messages-inner">
            <div id="welcome" class="welcome">
              <div class="welcome-mark">A</div>
              <h1>今天需要 Agent 帮你完成什么？</h1>
              <p>可以直接对话，也可以让 Agent 选择 Skill、调用工具并在高风险操作前等待你的确认。</p>
              <div class="suggestions">
                <button class="suggestion" type="button" data-prompt="读取 sandbox 目录下的 README.md，并总结主要内容"><strong>分析工作区文件</strong><span>使用带沙盒限制的文件读取工具</span></button>
                <button class="suggestion" type="button" data-prompt="请列出当前可用的技能，并说明各自适用场景"><strong>查看可用技能</strong><span>了解渐进加载的 Skill 能力</span></button>
                <button class="suggestion" type="button" data-prompt="访问 https://api.github.com 并概括响应信息"><strong>调用 HTTP 工具</strong><span>观察工具参数、执行结果与审批</span></button>
                <button class="suggestion" type="button" data-prompt="请制定一个分步骤执行的任务计划，并说明哪些步骤可以并行"><strong>规划复杂任务</strong><span>体验串行与并行执行决策</span></button>
              </div>
            </div>
          </div>
        </section>

        <div class="composer-wrap">
          <div class="composer">
            <textarea id="messageInput" rows="1" aria-label="输入消息" placeholder="给 Agent 发送消息…"></textarea>
            <div class="composer-footer">
              <span class="composer-hint">Enter 发送，Shift + Enter 换行</span>
              <div class="composer-actions">
                <button id="stop" class="stop-button" type="button">停止接收</button>
                <button id="send" class="send-button" type="button">发送</button>
              </div>
            </div>
          </div>
        </div>
      </main>

      <aside class="inspector" aria-label="运行详情">
        <div class="inspector-header">
          <h2>运行详情</h2>
          <button id="closeInspector" class="icon-button close-inspector" type="button" title="关闭运行详情" aria-label="关闭运行详情">×</button>
        </div>
        <div class="inspector-scroll">
          <section id="approval" class="approval">
            <h3>需要人工确认</h3>
            <div id="approvalMeta" class="approval-meta"></div>
            <div class="field"><label for="approvalArgs">工具参数 JSON</label><textarea id="approvalArgs"></textarea></div>
            <div class="field"><label for="approvalReason">审批备注（可选）</label><input id="approvalReason" placeholder="填写确认或拒绝原因" /></div>
            <div class="approval-actions"><button id="approve" class="approve" type="button">确认执行</button><button id="reject" class="reject" type="button">拒绝</button></div>
          </section>

          <section class="inspector-section">
            <h3>模型设置</h3>
            <div class="field"><label for="userId">用户 ID</label><input id="userId" value="demo-user" autocomplete="off" /></div>
            <div class="field">
              <label for="provider">模型提供商</label>
              <select id="provider"><option value="">服务端默认</option><option value="openai">OpenAI</option><option value="openai-compatible">OpenAI Compatible</option><option value="anthropic">Anthropic</option></select>
            </div>
            <div class="field"><label for="model">模型名称</label><input id="model" placeholder="服务端默认模型" autocomplete="off" /></div>
            <div class="field"><label for="apiKey">服务 API Key</label><input id="apiKey" type="password" placeholder="启用 AUTH_API_KEY 时填写" autocomplete="off" /></div>
          </section>

          <section class="inspector-section">
            <h3>当前会话</h3>
            <div id="threadValue" class="thread-value">尚未创建</div>
          </section>

          <section class="inspector-section">
            <h3>执行活动</h3>
            <div id="activity" class="activity"><div class="activity-empty">Agent 开始执行后，这里会显示状态变化和工具调用。</div></div>
          </section>
        </div>
      </aside>
    </div>
    <div id="scrim" class="scrim"></div>

    <script>
      const byId = (id) => document.getElementById(id);
      const storageKey = "web-agent-framework:sessions";
      let threadId = "";
      let activeController = null;
      let activeConfirmation = null;
      let activeAssistantContent = null;
      let isRunning = false;
      let sessions = readSessions();

      function readSessions() {
        try {
          const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
          return Array.isArray(value) ? value.slice(0, 30) : [];
        } catch {
          return [];
        }
      }

      function saveSessions() {
        try { localStorage.setItem(storageKey, JSON.stringify(sessions.slice(0, 30))); } catch { /* Storage may be disabled. */ }
      }

      function formatTime(value) {
        try { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
        catch { return ""; }
      }

      function renderSessions() {
        const root = byId("sessions");
        root.replaceChildren();
        if (!sessions.length) {
          const empty = document.createElement("div");
          empty.className = "sessions-empty";
          empty.textContent = "发送第一条消息后，会话会显示在这里。";
          root.appendChild(empty);
          return;
        }
        sessions.forEach((session) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "session" + (session.threadId === threadId ? " active" : "");
          const title = document.createElement("span");
          title.className = "session-title";
          title.textContent = session.title || "未命名对话";
          const time = document.createElement("span");
          time.className = "session-time";
          time.textContent = formatTime(session.updatedAt);
          button.append(title, time);
          button.addEventListener("click", () => loadThread(session.threadId));
          root.appendChild(button);
        });
      }

      function rememberSession(id, title) {
        const existing = sessions.find((item) => item.threadId === id);
        const record = {
          threadId: id,
          title: title || (existing && existing.title) || "新对话",
          updatedAt: new Date().toISOString()
        };
        sessions = [record].concat(sessions.filter((item) => item.threadId !== id));
        saveSessions();
        renderSessions();
        byId("chatTitle").textContent = record.title;
      }

      function getHeaders(acceptJson) {
        const headers = { accept: acceptJson ? "application/json" : "text/event-stream" };
        const apiKey = byId("apiKey").value.trim();
        if (apiKey) headers["x-api-key"] = apiKey;
        return headers;
      }

      function setThread(id) {
        threadId = id || "";
        const label = threadId || "尚未创建会话";
        byId("threadLabel").textContent = label;
        byId("threadValue").textContent = threadId || "尚未创建";
        renderSessions();
      }

      function setRunState(running, label, tone) {
        isRunning = running;
        byId("conversation").classList.toggle("is-running", running);
        byId("messageInput").disabled = running;
        byId("statusText").textContent = label;
        byId("statusDot").className = "status-dot" + (tone ? " " + tone : "");
      }

      function scrollToBottom() {
        const messages = byId("messages");
        requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
      }

      function removeWelcome() {
        const welcome = byId("welcome");
        if (welcome) welcome.remove();
      }

      function addMessage(role, content, extraClass) {
        removeWelcome();
        const row = document.createElement("article");
        row.className = "message " + role + (extraClass ? " " + extraClass : "");
        if (role !== "user") {
          const avatar = document.createElement("div");
          avatar.className = "avatar";
          avatar.textContent = role === "assistant" ? "A" : "!";
          row.appendChild(avatar);
        }
        const body = document.createElement("div");
        body.className = "message-body";
        if (role !== "user") {
          const label = document.createElement("div");
          label.className = "message-label";
          label.textContent = role === "assistant" ? "Agent" : "系统";
          body.appendChild(label);
        }
        const text = document.createElement("div");
        text.className = "message-content";
        text.textContent = content;
        body.appendChild(text);
        row.appendChild(body);
        byId("messagesInner").appendChild(row);
        scrollToBottom();
        return text;
      }

      function createAssistantMessage() {
        activeAssistantContent = addMessage("assistant", "");
        activeAssistantContent.classList.add("typing");
        return activeAssistantContent;
      }

      function addActivity(title, detail, tone) {
        const root = byId("activity");
        const empty = root.querySelector(".activity-empty");
        if (empty) empty.remove();
        const item = document.createElement("div");
        item.className = "activity-item" + (tone ? " " + tone : "");
        const heading = document.createElement("div");
        heading.className = "activity-title";
        const name = document.createElement("span");
        name.textContent = title;
        const time = document.createElement("span");
        time.className = "activity-time";
        time.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        heading.append(name, time);
        item.appendChild(heading);
        if (detail) {
          const body = document.createElement("div");
          body.className = "activity-detail";
          body.textContent = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
          item.appendChild(body);
        }
        root.prepend(item);
      }

      function showApproval(record) {
        activeConfirmation = record;
        byId("approval").classList.add("visible");
        byId("approvalMeta").textContent = record.toolName + " · " + record.reason + " · 创建于 " + formatTime(record.createdAt);
        byId("approvalArgs").value = JSON.stringify(record.args, null, 2);
        const notice = document.createElement("div");
        notice.className = "approval-notice";
        notice.textContent = "Agent 请求执行高风险工具 " + record.toolName + "，需要你的确认。";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "查看审批详情";
        button.addEventListener("click", openInspector);
        notice.appendChild(document.createElement("br"));
        notice.appendChild(button);
        byId("messagesInner").appendChild(notice);
        addActivity("等待人工确认", { toolName: record.toolName, reason: record.reason }, "warning");
        setRunState(false, "等待确认", "waiting");
        openInspector();
        scrollToBottom();
      }

      function hideApproval() {
        activeConfirmation = null;
        byId("approval").classList.remove("visible");
      }

      function handleEvent(event) {
        if (event.threadId && !threadId) {
          setThread(event.threadId);
          const firstUser = sessions.find((item) => item.threadId === event.threadId);
          rememberSession(event.threadId, firstUser && firstUser.title);
        }

        switch (event.type) {
          case "token": {
            const target = activeAssistantContent || createAssistantMessage();
            target.textContent += event.data.content;
            scrollToBottom();
            break;
          }
          case "tool_call":
            addActivity("调用工具：" + event.data.toolName, { mode: event.data.mode, risk: event.data.risk, args: event.data.args }, "tool");
            break;
          case "tool_result":
            addActivity("工具完成：" + event.data.toolName, event.data.ok ? event.data.result : event.data.error, event.data.ok ? "success" : "error");
            break;
          case "state_update":
            addActivity("状态：" + event.data.status, event.data.node ? { node: event.data.node, detail: event.data.detail } : event.data.detail, "");
            break;
          case "need_human_confirm":
            showApproval(event.data);
            break;
          case "error":
            addMessage("system", event.data.message, "error");
            addActivity("执行失败", { code: event.data.code, message: event.data.message }, "error");
            setRunState(false, "执行失败", "failed");
            break;
          case "done":
            if (activeAssistantContent) activeAssistantContent.classList.remove("typing");
            activeAssistantContent = null;
            if (event.data.status === "waiting_human_confirm") setRunState(false, "等待确认", "waiting");
            else if (event.data.status === "failed") setRunState(false, "执行失败", "failed");
            else setRunState(false, "已完成", "");
            addActivity("任务结束", event.data.status, event.data.status === "completed" ? "success" : "warning");
            break;
        }
      }

      async function streamRequest(url, payload) {
        activeController = new AbortController();
        const headers = getHeaders(false);
        headers["content-type"] = "application/json";
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: activeController.signal });
        if (!response.ok) {
          let message = await response.text();
          try { message = JSON.parse(message).message || message; } catch { /* Keep raw server response. */ }
          throw new Error(message || "请求失败：" + response.status);
        }
        if (!response.body) throw new Error("当前浏览器不支持流式响应");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
            if (!dataLine) continue;
            handleEvent(JSON.parse(dataLine.slice(6)));
          }
        }
      }

      async function sendMessage() {
        if (isRunning) return;
        const input = byId("messageInput");
        const message = input.value.trim();
        if (!message) return;

        const firstMessage = !threadId;
        addMessage("user", message);
        input.value = "";
        resizeComposer();
        hideApproval();
        activeAssistantContent = null;
        setRunState(true, "Agent 正在执行", "running");
        addActivity("收到用户消息", message.length > 120 ? message.slice(0, 120) + "…" : message, "");

        const payload = { message, userId: byId("userId").value.trim() || "anonymous" };
        if (threadId) payload.threadId = threadId;
        if (byId("provider").value) payload.modelProvider = byId("provider").value;
        if (byId("model").value.trim()) payload.model = byId("model").value.trim();

        try {
          await streamRequest("/v1/chat/stream", payload);
          if (threadId) rememberSession(threadId, firstMessage ? message.slice(0, 32) : "");
        } catch (error) {
          if (error.name === "AbortError") {
            addActivity("已停止接收响应", "客户端中止了 SSE 连接", "warning");
            setRunState(false, "已停止", "");
          } else {
            addMessage("system", error.message || String(error), "error");
            addActivity("请求失败", error.message || String(error), "error");
            setRunState(false, "请求失败", "failed");
          }
        } finally {
          if (activeAssistantContent) activeAssistantContent.classList.remove("typing");
          activeAssistantContent = null;
          activeController = null;
        }
      }

      async function submitApproval(approved) {
        if (!activeConfirmation || isRunning) return;
        let argsOverride;
        try { argsOverride = JSON.parse(byId("approvalArgs").value); }
        catch {
          addActivity("审批参数无效", "工具参数必须是合法 JSON", "error");
          return;
        }
        const confirmation = activeConfirmation;
        const payload = {
          threadId: confirmation.threadId,
          userId: byId("userId").value.trim() || confirmation.userId || "anonymous",
          confirmationId: confirmation.confirmationId,
          approved,
          argsOverride
        };
        const reason = byId("approvalReason").value.trim();
        if (reason) payload.reason = reason;
        if (byId("provider").value) payload.modelProvider = byId("provider").value;
        if (byId("model").value.trim()) payload.model = byId("model").value.trim();

        byId("approve").disabled = true;
        byId("reject").disabled = true;
        setRunState(true, approved ? "继续执行" : "正在拒绝", "running");
        addActivity(approved ? "用户确认执行" : "用户拒绝执行", { confirmationId: confirmation.confirmationId, argsOverride }, approved ? "success" : "warning");
        activeAssistantContent = null;
        try {
          await streamRequest("/v1/chat/confirm/stream", payload);
          hideApproval();
          closeDrawers();
        } catch (error) {
          if (error.name !== "AbortError") {
            addMessage("system", error.message || String(error), "error");
            setRunState(false, "审批请求失败", "failed");
          }
        } finally {
          byId("approve").disabled = false;
          byId("reject").disabled = false;
          activeController = null;
        }
      }

      async function loadThread(id) {
        if (isRunning) return;
        closeDrawers();
        setThread(id);
        hideApproval();
        const root = byId("messagesInner");
        root.replaceChildren();
        setRunState(false, "加载会话", "running");
        try {
          const response = await fetch("/v1/threads/" + encodeURIComponent(id), { headers: getHeaders(true) });
          if (!response.ok) throw new Error(response.status === 404 ? "服务端没有找到该会话" : "加载会话失败");
          const data = await response.json();
          byId("userId").value = data.thread.userId;
          data.messages.forEach((message) => {
            if (message.role === "user" || message.role === "assistant") addMessage(message.role, message.content);
          });
          const session = sessions.find((item) => item.threadId === id);
          byId("chatTitle").textContent = (session && session.title) || "历史会话";
          if (data.thread.pendingConfirmation) showApproval(data.thread.pendingConfirmation);
          else setRunState(false, data.thread.status === "failed" ? "执行失败" : "已恢复", data.thread.status === "failed" ? "failed" : "");
        } catch (error) {
          addMessage("system", error.message || String(error), "error");
          setRunState(false, "加载失败", "failed");
        }
      }

      function startNewChat() {
        if (activeController) activeController.abort();
        setThread("");
        hideApproval();
        activeAssistantContent = null;
        byId("chatTitle").textContent = "新对话";
        byId("messagesInner").innerHTML = '<div id="welcome" class="welcome"><div class="welcome-mark">A</div><h1>今天需要 Agent 帮你完成什么？</h1><p>可以直接对话，也可以让 Agent 选择 Skill、调用工具并在高风险操作前等待你的确认。</p><div class="suggestions"><button class="suggestion" type="button" data-prompt="读取 sandbox 目录下的 README.md，并总结主要内容"><strong>分析工作区文件</strong><span>使用带沙盒限制的文件读取工具</span></button><button class="suggestion" type="button" data-prompt="请列出当前可用的技能，并说明各自适用场景"><strong>查看可用技能</strong><span>了解渐进加载的 Skill 能力</span></button><button class="suggestion" type="button" data-prompt="访问 https://api.github.com 并概括响应信息"><strong>调用 HTTP 工具</strong><span>观察工具参数、执行结果与审批</span></button><button class="suggestion" type="button" data-prompt="请制定一个分步骤执行的任务计划，并说明哪些步骤可以并行"><strong>规划复杂任务</strong><span>体验串行与并行执行决策</span></button></div></div>';
        bindSuggestions();
        byId("activity").innerHTML = '<div class="activity-empty">Agent 开始执行后，这里会显示状态变化和工具调用。</div>';
        setRunState(false, "就绪", "");
        closeDrawers();
        byId("messageInput").focus();
      }

      function resizeComposer() {
        const input = byId("messageInput");
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 180) + "px";
      }

      function openInspector() { document.body.classList.remove("show-sessions"); document.body.classList.add("show-inspector"); }
      function closeDrawers() { document.body.classList.remove("show-sessions", "show-inspector"); }
      function bindSuggestions() {
        document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => {
          byId("messageInput").value = button.dataset.prompt || "";
          resizeComposer();
          byId("messageInput").focus();
        }));
      }

      byId("send").addEventListener("click", sendMessage);
      byId("stop").addEventListener("click", () => activeController && activeController.abort());
      byId("newChat").addEventListener("click", startNewChat);
      byId("approve").addEventListener("click", () => submitApproval(true));
      byId("reject").addEventListener("click", () => submitApproval(false));
      byId("messageInput").addEventListener("input", resizeComposer);
      byId("messageInput").addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          sendMessage();
        }
      });
      byId("openSessions").addEventListener("click", () => { document.body.classList.remove("show-inspector"); document.body.classList.add("show-sessions"); });
      byId("openInspector").addEventListener("click", openInspector);
      byId("closeInspector").addEventListener("click", closeDrawers);
      byId("scrim").addEventListener("click", closeDrawers);

      renderSessions();
      bindSuggestions();
      byId("messageInput").focus();
    </script>
  </body>
</html>`;
