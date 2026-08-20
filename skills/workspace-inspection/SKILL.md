---
name: workspace-inspection
description: Read and analyze text files in the configured sandbox workspace. Use for file summaries, configuration reviews, and source inspection.
allowedTools: file_read
triggers:
  - workspace
  - sandbox
  - file
  - file_read
  - README
  - "\u6587\u4ef6"
  - "\u8bfb\u53d6"
  - "\u5de5\u4f5c\u533a"
---

# Workspace inspection

Use this skill only for files inside the configured sandbox directory.

1. Identify the smallest set of relevant relative file paths.
2. For independent paths, create `file_read` calls with `mode: parallel`.
3. When a later file choice depends on the content of an earlier file, choose `mode: serial` and read the prerequisite first.
4. Summarize only facts returned by the file tools. Include the relative paths that support important conclusions.
