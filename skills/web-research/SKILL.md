---
name: web-research
description: Retrieve and compare public HTTP(S) resources through the allow-listed HTTP tool. Use when the user explicitly asks for current external information.
allowedTools: http_request
triggers:
  - http
  - https
  - URL
  - API
  - "\u7f51\u7edc"
  - "\u7f51\u9875"
  - "\u7f51\u7ad9"
  - "\u5916\u90e8"
  - "\u6700\u65b0\u4fe1\u606f"
---

# Web research

The `http_request` tool performs an external network action and requires human approval before execution.

1. Use only URLs needed to answer the request and prefer public HTTPS endpoints.
2. Use `mode: parallel` only for independent GET requests to different resources.
3. Use `mode: serial` when a later request needs an identifier, URL, or decision from an earlier response.
4. Keep request headers minimal and never include credentials, tokens, or user secrets.
5. Report HTTP status and facts from the returned response. Do not infer content that the tool did not return.
