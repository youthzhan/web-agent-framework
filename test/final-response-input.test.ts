import { describe, expect, it } from "vitest";
import {
  buildFinalResponseInput,
  buildReadmeInspectionResponse,
  buildReadmeHttpRestrictionComparisonResponse,
  buildSimpleTechnicalResponse,
  buildSingleHttpInspectionResponse
} from "../src/agent/workflow.js";

describe("final response input", () => {
  it("removes duplicate current input and bounds HTTP data for the final model", () => {
    const input = buildFinalResponseInput({
      userMessage: "访问 API 并总结",
      skillResults: [
        {
          skillName: "web-research",
          output: "tool summary",
          toolResults: [
            {
              status: 200,
              ok: true,
              headers: { "x-noise": "not needed by the model" },
              body: "x".repeat(200),
              truncated: false
            }
          ]
        }
      ],
      longTermMemorySummary: "",
      recentHistory: [
        { role: "assistant", content: "Earlier reply" },
        { role: "user", content: "访问 API 并总结" }
      ],
      historyLimit: 4,
      toolResultMaxChars: 80
    });

    expect(input.recentHistory).toEqual([
      { role: "assistant", content: "Earlier reply" }
    ]);
    expect(input.skillResults?.[0]?.toolResults[0]).toMatchObject({
      status: 200,
      ok: true,
      truncated: true
    });
    expect(JSON.stringify(input)).not.toContain("x-noise");
  });

  it("skips the final model for one public HTTP inspection without rules", () => {
    const response = buildSingleHttpInspectionResponse({
      message:
        "访问 https://jsonplaceholder.typicode.com/todos/1，核对该公开 API 请求是否符合这些限制",
      preparedSkills: [
        {
          skill: { name: "web-research" },
          toolPlan: {
            calls: [
              {
                toolName: "http_request",
                args: { url: "https://jsonplaceholder.typicode.com/todos/1" }
              }
            ]
          }
        }
      ],
      skillResults: [
        {
          skillName: "web-research",
          output: "",
          toolResults: [
            {
              status: 200,
              ok: true,
              body: '{"id":1,"title":"test"}'
            }
          ]
        }
      ]
    } as never);

    expect(response).toContain("HTTP 状态：`200 OK`");
    expect(response).toContain("本轮消息未提供具体限制项");
  });

  it("bounds direct-chat history and durable memory independently", () => {
    const input = buildFinalResponseInput({
      userMessage: "JavaScript 有哪些类型？",
      skillResults: [],
      longTermMemorySummary: "m".repeat(200),
      recentHistory: [
        { role: "user", content: "old".repeat(50) },
        { role: "assistant", content: "recent".repeat(50) }
      ],
      historyLimit: 2,
      historyMaxChars: 120,
      longTermMemoryMaxChars: 80,
      toolResultMaxChars: 1_000
    });

    expect(input.recentHistory).toHaveLength(1);
    expect(input.recentHistory?.[0]?.content.length).toBeLessThanOrEqual(120);
    expect(input.longTermMemorySummary?.length).toBeLessThanOrEqual(80);
  });

  it("extracts README purpose and sandbox restrictions without a final model call", () => {
    const response = buildReadmeInspectionResponse({
      message:
        "请让 workspace-inspection 帮我阅读 README.md，并整理出项目的主要用途和安全限制",
      preparedSkills: [
        {
          skill: { name: "workspace-inspection" },
          toolPlan: {
            calls: [
              {
                toolName: "file_read",
                args: { path: "README.md" }
              }
            ]
          }
        }
      ],
      skillResults: [
        {
          skillName: "workspace-inspection",
          output: "",
          toolResults: [
            {
              path: "README.md",
              content: [
                "# Agent 沙箱",
                "",
                "此目录是唯一暴露给 file_read 工具的本地文件系统区域。",
                "",
                "## 安全限制",
                "",
                "绝对路径以及逃逸出此目录的路径都会被拒绝。"
              ].join("\n")
            }
          ]
        }
      ]
    } as never);

    expect(response).toContain("### 主要用途");
    expect(response).toContain("唯一暴露给 file_read");
    expect(response).toContain("### 安全限制");
    expect(response).toContain("绝对路径以及逃逸出此目录的路径都会被拒绝");
  });

  it("answers a simple JavaScript types question without the model", () => {
    const response = buildSimpleTechnicalResponse("JavaScript 有哪些数据类型？");

    expect(response).toContain("`string`");
    expect(response).toContain("`bigint`");
    expect(response).toContain("typeof null");
    expect(buildSimpleTechnicalResponse("解释 JS 类型系统的设计原理")).toBeUndefined();
  });

  it("compares README file restrictions with one public HTTP request locally", () => {
    const response = buildReadmeHttpRestrictionComparisonResponse({
      message:
        "先阅读 README.md，了解项目的文件访问限制；然后访问 https://jsonplaceholder.typicode.com/todos/1，核对该公开 API 请求是否符合这些限制",
      preparedSkills: [
        {
          skill: { name: "workspace-inspection" },
          toolPlan: {
            calls: [
              { toolName: "file_read", args: { path: "README.md" } }
            ]
          }
        },
        {
          skill: { name: "web-research" },
          toolPlan: {
            calls: [
              {
                toolName: "http_request",
                args: {
                  url: "https://jsonplaceholder.typicode.com/todos/1",
                  method: "GET"
                }
              }
            ]
          }
        }
      ],
      skillResults: [
        {
          skillName: "workspace-inspection",
          output: "",
          toolResults: [
            {
              path: "README.md",
              content:
                "# Agent 沙箱\n\n绝对路径以及逃逸出此目录的路径都会被拒绝。"
            }
          ]
        },
        {
          skillName: "web-research",
          output: "",
          toolResults: [{ status: 200, ok: true, body: "{}" }]
        }
      ]
    } as never);

    expect(response).toContain("不违反 README 描述的文件访问限制");
    expect(response).toContain("HTTP 状态：`200 OK`");
  });
});
