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
        min-width: 0;
        min-height: 0;
      }

      .app > * { min-width: 0; min-height: 0; }

      .sidebar,
      .inspector {
        min-width: 0;
        background: var(--surface);
        z-index: 10;
      }

      .sidebar {
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
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
      .sessions {
        flex: 1 1 auto;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding: 0 9px 12px;
      }

      .session-row { position: relative; margin-bottom: 3px; }
      .session {
        display: block;
        width: 100%;
        padding: 10px 72px 10px 9px;
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
      .session-row.running .session-title::after { content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 7px; border-radius: 50%; background: var(--accent); vertical-align: 1px; animation: pulse 1.2s ease-in-out infinite; }
      .session-actions { position: absolute; top: 50%; right: 7px; display: flex; gap: 2px; opacity: 0; transform: translateY(-50%); transition: opacity 120ms ease; }
      .session-row:hover .session-actions, .session-row:focus-within .session-actions { opacity: 1; }
      .session-action { padding: 3px 4px; border: 0; color: var(--muted); background: transparent; font-size: 11px; }
      .session-action:hover { color: var(--accent-dark); text-decoration: underline; }
      .session-action.delete:hover { color: var(--danger); }
      .sessions-empty { padding: 18px 10px; color: var(--muted); font-size: 12px; line-height: 1.6; text-align: center; }

      .sidebar-footer {
        padding: 13px 16px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
        line-height: 1.5;
      }

      .conversation { display: flex; min-width: 0; min-height: 0; overflow: hidden; flex-direction: column; background: var(--canvas); }
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
      .suggestion:last-child:nth-child(odd) { grid-column: 1 / -1; }

      .message { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 11px; margin: 0 0 26px; }
      .message.user { grid-template-columns: minmax(0, 1fr); justify-items: end; }
      .avatar { width: 30px; height: 30px; border-radius: 5px; font-size: 12px; }
      .message-body { min-width: 0; max-width: 100%; }
      .message.user .message-body { width: fit-content; max-width: min(620px, 82%); }
      .message-label { margin-bottom: 7px; color: var(--muted); font-size: 11px; font-weight: 650; }
      .message-content { width: 100%; font-size: 14px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; user-select: text; }
      .message.user .message-content { width: fit-content; max-width: 100%; padding: 10px 14px; border-radius: 6px; color: #fff; background: #27302b; }
      .message.assistant .message-content { white-space: normal; }
      .message.assistant .message-content > :first-child { margin-top: 0; }
      .message.assistant .message-content > :last-child { margin-bottom: 0; }
      .message.assistant .message-content p { margin: 0 0 12px; }
      .message.assistant .message-content h1, .message.assistant .message-content h2, .message.assistant .message-content h3, .message.assistant .message-content h4 { margin: 20px 0 9px; line-height: 1.35; letter-spacing: 0; }
      .message.assistant .message-content h1 { font-size: 20px; }
      .message.assistant .message-content h2 { font-size: 18px; }
      .message.assistant .message-content h3 { font-size: 16px; }
      .message.assistant .message-content h4 { font-size: 14px; }
      .message.assistant .message-content ul, .message.assistant .message-content ol { margin: 8px 0 14px; padding-left: 24px; }
      .message.assistant .message-content li { margin: 4px 0; }
      .message.assistant .message-content blockquote { margin: 12px 0; padding: 2px 0 2px 12px; border-left: 3px solid var(--line-strong); color: var(--muted); }
      .message.assistant .message-content code { padding: 2px 5px; border-radius: 3px; background: var(--surface-muted); font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .message.assistant .message-content pre { margin: 12px 0; padding: 13px 14px; overflow-x: auto; border: 1px solid var(--line); border-radius: 5px; background: #18201c; color: #edf3ef; }
      .message.assistant .message-content pre code { padding: 0; color: inherit; background: transparent; white-space: pre; }
      .message.assistant .message-content a { color: var(--accent-dark); text-decoration-thickness: 1px; text-underline-offset: 2px; }
      .message.assistant .message-content table { display: block; width: max-content; max-width: 100%; margin: 12px 0; overflow-x: auto; border-collapse: collapse; }
      .message.assistant .message-content th, .message.assistant .message-content td { padding: 7px 9px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
      .message.assistant .message-content th { background: var(--surface-muted); font-weight: 700; }
      .message.assistant .message-content hr { margin: 18px 0; border: 0; border-top: 1px solid var(--line); }
      .message-actions { display: flex; align-items: center; min-height: 24px; gap: 8px; margin-top: 4px; opacity: 0; transition: opacity 120ms ease; }
      .message.assistant.is-loading .message-actions,
      .message.assistant.empty-output .message-actions { display: none; }
      .message.user .message-actions { justify-content: flex-end; }
      .message:hover .message-actions, .message:focus-within .message-actions { opacity: 1; }
      .message-action { padding: 2px 0; border: 0; color: var(--muted); background: transparent; font-size: 11px; }
      .message-action:hover { color: var(--accent-dark); text-decoration: underline; }
      .message.error .message-content { padding: 10px 12px; border-left: 3px solid var(--danger); color: var(--danger); background: var(--danger-soft); }
      .typing::after { content: ""; display: inline-block; width: 7px; height: 15px; margin-left: 3px; vertical-align: -2px; background: var(--accent); animation: blink 0.9s steps(1) infinite; }
      @keyframes blink { 50% { opacity: 0; } }
      .message-content.loading { display: flex; align-items: center; width: 54px; min-height: 28px; gap: 5px; }
      .message-content.loading::before, .message-content.loading::after { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: loading-dot 1.2s ease-in-out infinite; }
      .message-content.loading::after { animation-delay: 0.3s; }
      .message-content.loading span.loading-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: loading-dot 1.2s 0.15s ease-in-out infinite; }
      @keyframes loading-dot { 0%, 60%, 100% { opacity: 0.28; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
      @keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

      .approval-notice { margin: -8px 0 24px 43px; padding: 12px 14px; border: 1px solid #eccb99; border-radius: 6px; background: var(--warning-soft); color: #714a13; font-size: 13px; line-height: 1.5; }
      .approval-notice button { margin-top: 9px; border: 0; padding: 0; color: var(--warning); background: transparent; font-size: 12px; font-weight: 700; }

      .composer-wrap { flex: 0 0 auto; min-width: 0; padding: 12px 20px 20px; background: linear-gradient(to bottom, rgba(245,247,245,0), var(--canvas) 20%); }
      .composer { width: min(820px, 100%); margin: 0 auto; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface); box-shadow: 0 8px 28px rgba(32, 50, 41, 0.07); }
      .composer textarea { display: block; width: 100%; max-width: 100%; min-height: 54px; max-height: 180px; padding: 15px 16px 8px; overflow-y: auto; resize: none; border: 0; outline: 0; color: var(--ink); background: transparent; line-height: 1.5; }
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
        .suggestion:last-child:nth-child(odd) { grid-column: auto; }
        .composer-wrap { padding: 10px 10px 12px; }
        .composer-hint { display: none; }
        .message.user .message-body { max-width: 90%; }
        .session-actions, .message-actions { opacity: 1; }
        .status-line span { display: none; }
      }

      /* At compact desktop widths the permanent session column can squeeze
         the composer. Keep the conversation full width and make sessions a
         drawer; its own list remains independently scrollable. */
      @media (max-width: 860px) and (min-width: 721px) {
        .app { grid-template-columns: minmax(0, 1fr); }
        .sidebar { position: fixed; top: 0; left: 0; bottom: 0; width: min(280px, 88vw); transform: translateX(-105%); box-shadow: var(--shadow); transition: transform 180ms ease; z-index: 30; }
        body.show-sessions .sidebar { transform: translateX(0); }
        body.show-sessions .scrim { display: block; }
        .mobile-controls { display: flex; }
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
        <div class="sidebar-footer">会话列表和自定义标题保存在当前浏览器。会话状态、消息、记忆摘要与任务断点持久化在 Redis。</div>
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
              <p>像描述真实任务一样提出需求，Agent 会自行选择 Skill、安排步骤并调用工具。</p>
              <div class="suggestions">
                <button class="suggestion" type="button" data-prompt="请让 workspace-inspection 帮我阅读 README.md，并整理出项目的主要用途和安全限制"><strong>检查项目说明</strong><span>指定工作区检查能力完成任务</span></button>
                <button class="suggestion" type="button" data-prompt="帮我阅读 README.md，用三点总结这个项目的主要内容"><strong>快速了解项目</strong><span>Agent 根据需求自动选择合适能力</span></button>
                <button class="suggestion" type="button" data-prompt="先阅读 README.md，了解项目的文件访问限制；然后访问 https://jsonplaceholder.typicode.com/todos/1，核对该公开 API 请求是否符合这些限制"><strong>核对内外资料</strong><span>后一项工作基于前一项的结论</span></button>
                <button class="suggestion" type="button" data-prompt="我正在整理两份互不依赖的资料：README.md 和 https://jsonplaceholder.typicode.com/todos/1。请同时收集它们的内容，最后统一汇总"><strong>同步收集资料</strong><span>独立的信息收集任务可以同时推进</span></button>
                <button class="suggestion" type="button" data-prompt="请综合分析 README.md 与 https://jsonplaceholder.typicode.com/todos/1 的内容，说明项目文档和公开 API 数据各自的用途，并自行安排最合适的执行顺序"><strong>完成综合调研</strong><span>Agent 根据实际依赖自行安排执行步骤</span></button>
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
            <div class="field"><label for="modelPreset">对话模型</label><select id="modelPreset" disabled><option value="">加载已配置模型...</option></select></div>
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

    <script src="/assets/marked.umd.js"></script>
    <script src="/assets/purify.min.js"></script>
    <script>
      const byId = (id) => document.getElementById(id);
      const storageKey = "web-agent-framework:sessions";
      let threadId = "";
      let activeConfirmation = null;
      let approvalSubmitting = false;
      let isRunning = false;
      let viewId = crypto.randomUUID();
      let loadingThreadId = "";
      const runs = new Map();
      const draftRuns = new Map();
      let sessions = readSessions();
      let configuredModels = [];

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
          const row = document.createElement("div");
          const sessionRun = runs.get(session.threadId);
          row.className = "session-row" + (sessionRun?.running ? " running" : "");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "session" + (session.threadId === threadId ? " active" : "");
          button.title = session.title || "未命名对话";
          const title = document.createElement("span");
          title.className = "session-title";
          title.textContent = session.title || "未命名对话";
          const time = document.createElement("span");
          time.className = "session-time";
          time.textContent = formatTime(session.updatedAt);
          button.append(title, time);
          button.addEventListener("click", () => loadThread(session.threadId));

          const actions = document.createElement("div");
          actions.className = "session-actions";
          const rename = document.createElement("button");
          rename.type = "button";
          rename.className = "session-action";
          rename.textContent = "编辑";
          rename.title = "编辑会话标题";
          rename.addEventListener("click", () => renameSession(session.threadId));
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "session-action delete";
          remove.textContent = "删除";
          remove.title = "从最近会话中删除";
          remove.addEventListener("click", () => deleteSession(session.threadId));
          actions.append(rename, remove);
          row.append(button, actions);
          root.appendChild(row);
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
        if (threadId === id) byId("chatTitle").textContent = record.title;
      }

      function forgetSession(id) {
        sessions = sessions.filter((session) => session.threadId !== id);
        saveSessions();
        renderSessions();
      }

      function renameSession(id) {
        const session = sessions.find((item) => item.threadId === id);
        if (!session) return;
        const nextTitle = window.prompt("编辑会话标题", session.title || "未命名对话");
        if (nextTitle === null) return;
        const normalized = nextTitle.trim().slice(0, 60);
        if (!normalized) return;
        session.title = normalized;
        session.updatedAt = new Date().toISOString();
        saveSessions();
        renderSessions();
        if (threadId === id) byId("chatTitle").textContent = normalized;
      }

      function deleteSession(id) {
        const session = sessions.find((item) => item.threadId === id);
        if (!session) return;
        if (!window.confirm("确定从最近会话中删除“" + (session.title || "未命名对话") + "”吗？")) return;
        forgetSession(id);
        if (threadId === id) startNewChat();
      }

      function getHeaders(acceptJson) {
        const headers = { accept: acceptJson ? "application/json" : "text/event-stream" };
        const apiKey = byId("apiKey").value.trim();
        if (apiKey) headers["x-api-key"] = apiKey;
        return headers;
      }

      function getModelSelection() {
        const selectedId = byId("modelPreset").value;
        const selected = configuredModels.find((model) => model.id === selectedId);
        return selected ? { modelProvider: selected.provider, model: selected.model } : {};
      }

      async function loadConfiguredModels() {
        const select = byId("modelPreset");
        try {
          const response = await fetch("/v1/models", { headers: getHeaders(true) });
          if (!response.ok) throw new Error("无法加载模型列表");
          const payload = await response.json();
          configuredModels = Array.isArray(payload.models) ? payload.models : [];
          select.replaceChildren();
          configuredModels.forEach((model) => {
            const option = document.createElement("option");
            option.value = model.id;
            option.textContent = model.label + " (" + model.model + ")";
            select.appendChild(option);
          });
          if (!configuredModels.length) throw new Error("服务端未配置可用模型");
          select.value = payload.defaultModelId || configuredModels[0].id;
          select.disabled = false;
        } catch (error) {
          select.replaceChildren();
          const option = document.createElement("option");
          option.textContent = "模型列表加载失败";
          select.appendChild(option);
          addActivity("模型列表加载失败", error.message || String(error), "warning");
        }
      }

      function setThread(id) {
        threadId = id || "";
        const label = threadId || "尚未创建会话";
        byId("threadLabel").textContent = label;
        byId("threadValue").textContent = threadId || "尚未创建";
        renderSessions();
      }

      function currentRun() {
        if (threadId) return runs.get(threadId);
        return draftRuns.get(viewId);
      }

      function runIsVisible(run) {
        return run.threadId
          ? run.threadId === threadId && loadingThreadId !== threadId
          : !threadId && run.viewId === viewId;
      }

      function bindRunThread(run, id) {
        if (!id || run.threadId === id) return;
        const ownsCurrentDraft = !threadId && run.viewId === viewId;
        run.threadId = id;
        draftRuns.delete(run.viewId);
        runs.set(id, run);
        rememberSession(id, run.title);
        if (ownsCurrentDraft) setThread(id);
      }

      function createRun(title) {
        return {
          threadId: threadId || "",
          viewId,
          title,
          running: true,
          waiting: false,
          status: "running",
          markdown: "",
          assistantContent: null,
          confirmation: null,
          activities: [],
          controller: new AbortController()
        };
      }

      function syncRunState(run) {
        if (!run) {
          setRunState(false, "就绪", "");
        } else if (run.waiting) {
          setRunState(false, "等待确认", "waiting");
        } else if (run.running) {
          setRunState(true, "Agent 正在执行", "running");
        } else if (run.status === "failed") {
          setRunState(false, "执行失败", "failed");
        } else {
          setRunState(false, "已完成", "");
        }
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

      async function copyText(value, button) {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const fallback = document.createElement("textarea");
          fallback.value = value;
          fallback.style.position = "fixed";
          fallback.style.opacity = "0";
          document.body.appendChild(fallback);
          fallback.select();
          document.execCommand("copy");
          fallback.remove();
        }
        const original = button.textContent;
        button.textContent = "已复制";
        window.setTimeout(() => { button.textContent = original; }, 1200);
      }

      function editUserMessage(value) {
        if (isRunning) {
          addActivity("暂时无法编辑", "请等待当前任务结束后再编辑并重新发送。", "warning");
          return;
        }
        const input = byId("messageInput");
        input.value = value;
        resizeComposer();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }

      function messageSource(text, role) {
        return role === "assistant"
          ? text.dataset.rawMarkdown || ""
          : text.textContent || "";
      }

      function renderAssistantMarkdown(text) {
        const source = text.dataset.rawMarkdown || "";
        if (!window.marked || !window.DOMPurify) {
          text.textContent = source;
          return;
        }
        const parsed = window.marked.parse(source, {
          async: false,
          breaks: true,
          gfm: true
        });
        text.innerHTML = window.DOMPurify.sanitize(parsed, {
          ALLOWED_TAGS: [
            "a", "blockquote", "br", "code", "del", "em", "h1", "h2",
            "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre",
            "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"
          ],
          ALLOWED_ATTR: ["class", "href", "title"]
        });
        text.querySelectorAll("a").forEach((link) => {
          link.target = "_blank";
          link.rel = "noopener noreferrer nofollow";
        });
      }

      function appendAssistantToken(run, token) {
        run.markdown += token;
        if (!runIsVisible(run)) return;
        const text = run.assistantContent || createAssistantMessage(run);
        if (run.markdown.trim()) {
          const row = text.closest(".message");
          row?.classList.remove("is-loading", "empty-output");
        }
        text.classList.remove("loading");
        text.classList.add("typing");
        text.dataset.rawMarkdown = run.markdown;
        if (text.dataset.renderPending === "true") return;
        text.dataset.renderPending = "true";
        requestAnimationFrame(() => {
          delete text.dataset.renderPending;
          renderAssistantMarkdown(text);
          scrollToBottom();
        });
      }

      function appendMessageActions(body, text, role) {
        if (role !== "user" && role !== "assistant") return;
        const actions = document.createElement("div");
        actions.className = "message-actions";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "message-action";
        copy.textContent = "复制";
        copy.title = "复制消息内容";
        copy.addEventListener("click", () => copyText(messageSource(text, role), copy));
        actions.appendChild(copy);
        if (role === "user") {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "message-action";
          edit.textContent = "编辑";
          edit.title = "载入输入框并重新发送";
          edit.addEventListener("click", () => editUserMessage(text.textContent || ""));
          actions.appendChild(edit);
        }
        body.appendChild(actions);
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
        if (role === "assistant") {
          text.dataset.rawMarkdown = content;
          renderAssistantMarkdown(text);
        } else {
          text.textContent = content;
        }
        body.appendChild(text);
        appendMessageActions(body, text, role);
        row.appendChild(body);
        byId("messagesInner").appendChild(row);
        scrollToBottom();
        return text;
      }

      function createAssistantMessage(run) {
        const text = addMessage("assistant", run.markdown || "");
        run.assistantContent = text;
        const row = text.closest(".message");
        if (run.markdown) {
          text.classList.add("typing");
          row?.classList.remove("is-loading", "empty-output");
        } else {
          row?.classList.add("is-loading");
          text.classList.add("loading");
          const dot = document.createElement("span");
          dot.className = "loading-dot";
          text.appendChild(dot);
        }
        return text;
      }

      function appendActivityElement(root, activity) {
        const empty = root.querySelector(".activity-empty");
        if (empty) empty.remove();
        const item = document.createElement("div");
        item.className = "activity-item" + (activity.tone ? " " + activity.tone : "");
        const heading = document.createElement("div");
        heading.className = "activity-title";
        const name = document.createElement("span");
        name.textContent = activity.title;
        const time = document.createElement("span");
        time.className = "activity-time";
        time.textContent = activity.time;
        heading.append(name, time);
        item.appendChild(heading);
        if (activity.detail) {
          const body = document.createElement("div");
          body.className = "activity-detail";
          body.textContent = typeof activity.detail === "string"
            ? activity.detail
            : JSON.stringify(activity.detail, null, 2);
          item.appendChild(body);
        }
        root.appendChild(item);
      }

      function renderActivities(run) {
        const root = byId("activity");
        root.replaceChildren();
        const activities = run?.activities || [];
        if (activities.length === 0) {
          const empty = document.createElement("div");
          empty.className = "activity-empty";
          empty.textContent = "该会话的执行活动会显示在这里。";
          root.appendChild(empty);
          return;
        }
        activities.forEach((activity) => appendActivityElement(root, activity));
      }

      function addActivity(title, detail, tone, run = currentRun()) {
        const activity = {
          title,
          detail,
          tone,
          time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        };
        if (run) {
          run.activities.unshift(activity);
          if (!runIsVisible(run)) return;
        }
        renderActivities(run);
      }

      function showApproval(record, run) {
        const method = record.args && record.args.method ? record.args.method : "";
        const target = record.args && (record.args.url || record.args.path) ? (record.args.url || record.args.path) : "未提供目标";
        if (run) {
          run.confirmation = record;
          run.waiting = true;
          run.running = false;
          run.status = "waiting_human_confirm";
          addActivity("等待人工确认", { toolName: record.toolName, target, args: record.args }, "warning", run);
          renderSessions();
          if (!runIsVisible(run)) return;
        }
        activeConfirmation = record;
        byId("approval").classList.add("visible");
        // Each approval is independent. Never carry the previous approval
        // note into the next queued tool confirmation.
        byId("approvalReason").value = "";
        byId("approvalMeta").textContent = record.toolName + " · " + (method ? method + " " : "") + target + " · 创建于 " + formatTime(record.createdAt);
        byId("approvalArgs").value = JSON.stringify(record.args, null, 2);
        const notice = document.createElement("div");
        notice.className = "approval-notice";
        notice.textContent = "Agent 请求执行 " + record.toolName + "：" + (method ? method + " " : "") + target + "，需要你的确认。";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "查看审批详情";
        button.addEventListener("click", openInspector);
        notice.appendChild(document.createElement("br"));
        notice.appendChild(button);
        byId("messagesInner").appendChild(notice);
        if (!run) addActivity("等待人工确认", { toolName: record.toolName, target, args: record.args }, "warning");
        setRunState(false, "等待确认", "waiting");
        openInspector();
        scrollToBottom();
      }

      function hideApproval() {
        activeConfirmation = null;
        byId("approval").classList.remove("visible");
        byId("approvalReason").value = "";
      }

      function handleEvent(event, run) {
        if (event.threadId) bindRunThread(run, event.threadId);
        const visible = runIsVisible(run);

        switch (event.type) {
          case "token": {
            appendAssistantToken(run, event.data.content);
            break;
          }
          case "tool_call":
            addActivity("调用工具：" + event.data.toolName, { mode: event.data.mode, risk: event.data.risk, args: event.data.args }, "tool", run);
            break;
          case "tool_result":
            addActivity("工具完成：" + event.data.toolName, event.data.ok ? event.data.result : event.data.error, event.data.ok ? "success" : "error", run);
            break;
          case "state_update":
            addActivity("状态：" + event.data.status, event.data.node ? { node: event.data.node, detail: event.data.detail } : event.data.detail, "", run);
            break;
          case "need_human_confirm":
            showApproval(event.data, run);
            break;
          case "error":
            run.status = "failed";
            if (visible) {
              const detailText = formatErrorDetails(event.data.details);
              addMessage("system", event.data.message + (detailText ? "\n" + detailText : ""), "error");
              setRunState(false, "执行失败", "failed");
            }
            addActivity("执行失败", { code: event.data.code, message: event.data.message, details: event.data.details }, "error", run);
            break;
          case "done":
            run.status = event.data.status;
            run.waiting = event.data.status === "waiting_human_confirm";
            run.running = false;
            if (run.assistantContent) {
              if (run.waiting && !run.markdown) {
                run.assistantContent.closest(".message")?.remove();
                run.assistantContent = null;
              } else {
                const row = run.assistantContent.closest(".message");
                row?.classList.remove("is-loading");
                row?.classList.toggle("empty-output", !run.markdown.trim());
                renderAssistantMarkdown(run.assistantContent);
                run.assistantContent.classList.remove("typing", "loading");
              }
            }
            if (visible) {
              syncRunState(run);
            }
            addActivity("任务结束", event.data.status, event.data.status === "completed" ? "success" : "warning", run);
            renderSessions();
            break;
        }
      }

      async function streamRequest(url, payload, run) {
        run.controller = new AbortController();
        const headers = getHeaders(false);
        headers["content-type"] = "application/json";
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: run.controller.signal });
        if (!response.ok) {
          let message = await response.text();
          try {
            const errorPayload = JSON.parse(message);
            message = (errorPayload.message || message) + (formatErrorDetails(errorPayload.details) ? "\n" + formatErrorDetails(errorPayload.details) : "");
          } catch { /* Keep raw server response. */ }
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
            handleEvent(JSON.parse(dataLine.slice(6)), run);
          }
        }
      }

      function formatErrorDetails(details) {
        if (!Array.isArray(details)) return "";
        return details.slice(0, 3).map((issue) => {
          const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join(".") : "请求";
          return path + "：" + (issue.message || "参数无效");
        }).join("\n");
      }

      async function sendMessage() {
        if (currentRun()?.running) return;
        const input = byId("messageInput");
        const message = input.value.trim();
        if (!message) return;

        const firstMessage = !threadId;
        addMessage("user", message);
        const run = createRun(firstMessage ? message.slice(0, 32) : undefined);
        if (run.threadId) runs.set(run.threadId, run);
        else draftRuns.set(run.viewId, run);
        createAssistantMessage(run);
        input.value = "";
        resizeComposer();
        hideApproval();
        setRunState(true, "Agent 正在执行", "running");
        addActivity("收到用户消息", message.length > 120 ? message.slice(0, 120) + "…" : message, "");
        renderSessions();

        const payload = { message, userId: byId("userId").value.trim() || "anonymous" };
        if (threadId) payload.threadId = threadId;
        Object.assign(payload, getModelSelection());

        try {
          await streamRequest("/v1/chat/stream", payload, run);
        } catch (error) {
          if (error.name === "AbortError") {
            if (runIsVisible(run)) {
              addActivity("已停止接收响应", "服务端任务可能仍在后台执行，可稍后重新打开会话查看。", "warning");
              setRunState(false, "后台执行中", "running");
            }
          } else {
            run.running = false;
            run.status = "failed";
            if (runIsVisible(run)) {
              addMessage("system", error.message || String(error), "error");
              addActivity("请求失败", error.message || String(error), "error");
              setRunState(false, "请求失败", "failed");
            }
          }
        } finally {
          run.controller = null;
          renderSessions();
        }
      }

      async function submitApproval(approved) {
        if (!activeConfirmation || isRunning || approvalSubmitting) return;
        let argsOverride;
        try { argsOverride = JSON.parse(byId("approvalArgs").value); }
        catch {
          addActivity("审批参数无效", "工具参数必须是合法 JSON", "error");
          return;
        }
        approvalSubmitting = true;
        const confirmation = activeConfirmation;
        const run = runs.get(confirmation.threadId) || createRun();
        run.threadId = confirmation.threadId;
        run.running = true;
        run.waiting = false;
        run.status = "running";
        run.confirmation = null;
        runs.set(run.threadId, run);
        if (!run.assistantContent && runIsVisible(run)) createAssistantMessage(run);
        const payload = {
          threadId: confirmation.threadId,
          userId: byId("userId").value.trim() || confirmation.userId || "anonymous",
          confirmationId: confirmation.confirmationId,
          approved,
          argsOverride
        };
        const reason = byId("approvalReason").value.trim();
        if (reason) payload.reason = reason;

        byId("approve").disabled = true;
        byId("reject").disabled = true;
        setRunState(true, approved ? "继续执行" : "正在拒绝", "running");
        addActivity(approved ? "用户确认执行" : "用户拒绝执行", { confirmationId: confirmation.confirmationId, argsOverride }, approved ? "success" : "warning");
        try {
          await streamRequest("/v1/chat/confirm/stream", payload, run);
          // A resume may immediately emit the next queued approval. Do not let
          // cleanup for the previous item hide that newly activated record.
          if (activeConfirmation?.confirmationId === confirmation.confirmationId) {
            hideApproval();
            closeDrawers();
          }
        } catch (error) {
          if (error.name !== "AbortError") {
            const message = error.message || String(error);
            if (
              /Thread is not waiting for human confirmation|Confirmation id mismatch|already being processed/i.test(
                message
              )
            ) {
              // The checkpoint was already resumed elsewhere or the browser
              // submitted an old approval. Do not present this as a model/tool
              // failure and do not leave a stale approval panel visible.
              run.running = false;
              run.status = "completed";
              hideApproval();
              closeDrawers();
              setRunState(false, "审批已处理", "");
              addActivity("审批状态已更新", "该审批已经被处理或已失效。", "warning", run);
            } else {
              run.running = false;
              run.status = "failed";
              addMessage("system", message, "error");
              setRunState(false, "审批请求失败", "failed");
            }
          }
        } finally {
          approvalSubmitting = false;
          byId("approve").disabled = false;
          byId("reject").disabled = false;
          run.controller = null;
          renderSessions();
        }
      }

      async function loadThread(id) {
        viewId = crypto.randomUUID();
        loadingThreadId = id;
        closeDrawers();
        setThread(id);
        hideApproval();
        const root = byId("messagesInner");
        root.replaceChildren();
        const run = runs.get(id);
        if (run) run.assistantContent = null;
        renderActivities(run);
        setRunState(true, "加载会话", "running");
        try {
          const response = await fetch("/v1/threads/" + encodeURIComponent(id), { headers: getHeaders(true) });
          if (threadId !== id || loadingThreadId !== id) return;
          if (response.status === 404) {
            // Browser session metadata outlives the in-memory development
            // backend after a server restart. Remove only this stale entry.
            forgetSession(id);
            startNewChat();
            addActivity("已移除过期会话", "该会话不存在于当前服务端持久化后端。", "warning");
            return;
          }
          if (!response.ok) throw new Error("加载会话失败");
          const data = await response.json();
          if (threadId !== id || loadingThreadId !== id) return;
          byId("userId").value = data.thread.userId;
          data.messages.forEach((message) => {
            if (message.role === "user") {
              addMessage("user", message.content);
            } else if (message.role === "assistant") {
              addMessage(
                message.metadata?.systemError ? "system" : "assistant",
                message.content,
                message.metadata?.systemError ? "error" : ""
              );
            }
          });
          const session = sessions.find((item) => item.threadId === id);
          byId("chatTitle").textContent = (session && session.title) || "历史会话";
          loadingThreadId = "";
          if (run?.running) {
            createAssistantMessage(run);
            syncRunState(run);
          } else if (data.thread.pendingConfirmation) {
            showApproval(data.thread.pendingConfirmation, run);
          } else if (data.thread.status === "running") {
            const restoredRun = run || createRun(session?.title);
            restoredRun.threadId = id;
            restoredRun.running = true;
            runs.set(id, restoredRun);
            createAssistantMessage(restoredRun);
            syncRunState(restoredRun);
          } else {
            setRunState(false, data.thread.status === "failed" ? "执行失败" : "已恢复", data.thread.status === "failed" ? "failed" : "");
          }
          renderActivities(runs.get(id));
          renderSessions();
        } catch (error) {
          if (threadId !== id) return;
          loadingThreadId = "";
          addMessage("system", error.message || String(error), "error");
          setRunState(false, "加载失败", "failed");
        }
      }

      function startNewChat() {
        viewId = crypto.randomUUID();
        loadingThreadId = "";
        setThread("");
        hideApproval();
        byId("chatTitle").textContent = "新对话";
        byId("messagesInner").innerHTML = '<div id="welcome" class="welcome"><div class="welcome-mark">A</div><h1>今天需要 Agent 帮你完成什么？</h1><p>像描述真实任务一样提出需求，Agent 会自行选择 Skill、安排步骤并调用工具。</p><div class="suggestions"><button class="suggestion" type="button" data-prompt="请让 workspace-inspection 帮我阅读 README.md，并整理出项目的主要用途和安全限制"><strong>检查项目说明</strong><span>指定工作区检查能力完成任务</span></button><button class="suggestion" type="button" data-prompt="帮我阅读 README.md，用三点总结这个项目的主要内容"><strong>快速了解项目</strong><span>Agent 根据需求自动选择合适能力</span></button><button class="suggestion" type="button" data-prompt="先阅读 README.md，了解项目的文件访问限制；然后访问 https://jsonplaceholder.typicode.com/todos/1，核对该公开 API 请求是否符合这些限制"><strong>核对内外资料</strong><span>后一项工作基于前一项的结论</span></button><button class="suggestion" type="button" data-prompt="我正在整理两份互不依赖的资料：README.md 和 https://jsonplaceholder.typicode.com/todos/1。请同时收集它们的内容，最后统一汇总"><strong>同步收集资料</strong><span>独立的信息收集任务可以同时推进</span></button><button class="suggestion" type="button" data-prompt="请综合分析 README.md 与 https://jsonplaceholder.typicode.com/todos/1 的内容，说明项目文档和公开 API 数据各自的用途，并自行安排最合适的执行顺序"><strong>完成综合调研</strong><span>Agent 根据实际依赖自行安排执行步骤</span></button></div></div>';
        bindSuggestions();
        renderActivities();
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
      byId("stop").addEventListener("click", () => currentRun()?.controller?.abort());
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
      void loadConfiguredModels();
      byId("messageInput").focus();
    </script>
  </body>
</html>`;
