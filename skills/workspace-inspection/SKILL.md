---
name: workspace-inspection
description: 读取并分析配置的沙箱工作区中的文本文件。适用于文件摘要、配置审查和源码检查。
allowedTools: file_read
triggers:
  - workspace
  - sandbox
  - file
  - file_read
  - README
  - "文件"
  - "读取"
  - "工作区"
---

# 工作区检查

仅可将此 Skill 用于配置的沙箱目录内文件。

1. 确定最少且相关的相对文件路径集合。
2. 路径相互独立时，创建 `mode: parallel` 的 `file_read` 调用。
3. 后续文件选择依赖前一个文件内容时，使用 `mode: serial`，并先读取前置文件。
4. 仅根据文件工具返回的事实进行总结，并包含支持重要结论的相对路径。
