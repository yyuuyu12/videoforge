# 文件归属与存储规则

| 路径 | 类型 | 是否提交 | 说明 |
|---|---|---:|---|
| `server/src/` | 后端源代码 | 是 | API、流水线、provider 和 worker |
| `dashboard/src/` | 前端源代码 | 是 | 页面、组件、样式和 API 类型 |
| `server/templates/` | 确定性脚本 | 是 | 音频、字幕等可复用模板 |
| `skills/` | 方法论快照 | 是 | 产品 prompt 的真源；从 F:\Projects\claude-skills 同步，改源码库后同步进来一起提交 |
| `*.md`、`docs/` | 项目文档 | 是 | 设计、操作、状态和长期记忆 |
| `config.example.json` | 非敏感配置样例 | 是 | 可复制为本地配置 |
| `settings.local.json`、`config.json` | 敏感/本地配置 | 否 | 只保留在运行机器 |
| `data.db` | 运行时数据库 | 否 | 不作为迁移或备份提交 |
| `workspaces/` | 作品与媒体产物 | 否 | 体积大、含用户素材 |
| `output/`、`dist/` | 构建/导出产物 | 否 | 可随时重新生成 |
| `*.log`、`*.tsbuildinfo` | 临时诊断文件 | 否 | 出问题时单独归档或提供 |

## 共享预览依赖

`workspaces/` 默认仍是运行态目录；唯一提交例外是 `workspaces/package.json` 与 `workspaces/package-lock.json`，它们锁定所有新作品共用的 React/Vite/TypeScript 运行时。`workspaces/node_modules/`、每个作品的 `presentation/dist/`、媒体和其他运行产物均不提交。

## 命名建议

- 稳定文档使用大写英文文件名，内容可使用中文。
- 测试报告放 `docs/reports/`，使用 `FULL-FLOW-TEST-YYYY-MM-DD.md` 格式。
- 不把密钥、个人素材、数据库快照或完整运行日志写入长期记忆。
