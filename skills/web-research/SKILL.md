---
name: web-research
description: 通过已加入白名单的 HTTP 工具获取并比较公开 HTTP(S) 资源。适用于用户明确要求当前外部信息的场景。
allowedTools: http_request
triggers:
  - http
  - https
  - URL
  - API
  - "网络"
  - "网页"
  - "网站"
  - "外部"
  - "最新信息"
---

# 网络检索

`http_request` 工具会执行外部网络操作，执行前必须获得人工审批。

1. 仅使用回答请求所需的 URL，并优先使用公开 HTTPS 端点。
2. 仅对不同资源的相互独立 GET 请求使用 `mode: parallel`。
3. 后续请求依赖前一响应中的标识符、URL 或决策时，使用 `mode: serial`。
4. 请求头应保持最小化，绝不包含凭据、令牌或用户密钥。
5. 报告 HTTP 状态和响应返回的事实，不要推断工具未返回的内容。
