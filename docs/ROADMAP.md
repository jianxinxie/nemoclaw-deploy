# nemoclaw-deploy Roadmap

本项目目标是提供一个安全、可发布的 Node.js / TypeScript CLI，用于在已经存在的 NemoClaw sandbox 中部署 OpenClaw agent。

## 版本规划

### v0.1.0 - MVP

目标：完成 AGENTS.md 中定义的核心部署链路，并通过本地构建、打包和 CLI smoke test。

- npm CLI 包结构
- `deploy`、`doctor`、`init-config` 命令
- YAML 配置文件读取与模板输出
- 交互式补全缺失字段
- 非交互模式严格失败
- dry-run 计划输出与命令预览
- 统一 `runCommand` 外部命令执行
- sandbox 预检查、agent 创建、agent-content 安全合并
- skills 目录批量安装
- gateway token 自动获取和脱敏输出
- dashboard URL 到 gateway URL 推导
- advbot channel 配置与 patch fallback
- network policy 目录批量应用
- recover 与基础验证

### v0.2.0 - 体验增强

目标：提升可观测性、可恢复性和部署前诊断体验。

- 更完整的 dry-run 资源校验报告
- 部署步骤进度事件和结构化日志
- 更细粒度的错误码
- 可选 JSON 输出
- 交互式配置向导增强
- agent-content 冲突预览

### v0.3.0 - 自动化集成

目标：让 CLI 更适合 CI/CD 与团队标准化部署。

- CI 模式报告
- 配置 schema 文档生成
- 多环境配置约定
- 批量部署多个 agent
- 可扩展 channel provider 接口

### v1.0.0 - 稳定版

目标：稳定 API、命令行为和发布流程。

- 完整测试矩阵
- 兼容性策略
- 语义化版本发布规范
- 端到端真实 NemoClaw 环境验证清单

## 当前完成定义

v0.1.0 完成后，以下命令应可运行：

```bash
npm install
npm run build
npm pack
npm install -g ./your-scope-nemoclaw-deploy-0.1.0.tgz
nemoclaw-deploy --help
nemoclaw-deploy doctor
nemoclaw-deploy init-config --output deploy.yaml
nemoclaw-deploy deploy --config deploy.yaml --dry-run
```

真实 NemoClaw 环境中，`nemoclaw-deploy deploy --config deploy.yaml` 应能完成 agent 创建、内容上传、skills 目录批量安装、advbot channel 配置、network policy 目录批量应用和基础验证。
