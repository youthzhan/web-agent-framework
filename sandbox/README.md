# Agent 沙箱

此目录是唯一暴露给 `file_read` 工具的本地文件系统区域。测试
`workspace-inspection` Skill 时，请将 UTF-8 文本文件放入此处。

绝对路径以及逃逸出此目录的路径都会被拒绝。
