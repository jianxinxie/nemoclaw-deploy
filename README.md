# nemoclaw-deploy

`nemoclaw-deploy` 是一个 Node.js / TypeScript CLI，用于在已经部署好的 NemoClaw sandbox 中安全部署 OpenClaw agent。

它负责：

- 创建或确认 OpenClaw agent
- 安全上传 agent 初始化内容
- 安装 skills 目录下的所有 skill
- 配置 `channels.advbot`
- 应用 network policy 目录下的所有策略文件
- 合并写入 workspace `.env`
- 在 workspace 中安装依赖
- 按需触发 channel recover 和基础验证

它不负责安装 NemoClaw，也不负责创建 sandbox。

## 安装

```bash
npm install -g @adxie/nemoclaw-deploy
```

## 使用

交互式部署：

```bash
nemoclaw-deploy
```

配置文件部署：

```bash
nemoclaw-deploy deploy --config deploy.yaml
```

非交互部署：

```bash
nemoclaw-deploy deploy --config deploy.yaml --non-interactive
```

只查看计划：

```bash
nemoclaw-deploy deploy --config deploy.yaml --dry-run
```

生成配置模板：

```bash
nemoclaw-deploy init-config --output deploy.yaml
```

检查环境：

```bash
nemoclaw-deploy doctor
nemoclaw-deploy doctor --sandbox demo
```

## 配置格式

```yaml
sandboxName: demo
agentName: my-agent

workspace: ""

agentContent:
  enabled: true
  hostDir: ./agent-content
  conflictStrategy: ask

skill:
  enabled: true
  hostDir: ./skills

channel:
  enabled: true
  type: advbot
  accountId: default
  channelServerUrl: http://127.0.0.1:8086
  gatewayToken: ""
  gatewayUrl: ""

networkPolicy:
  enabled: true
  dir: ./policies

env:
  enabled: false
  targetFile: .env
  variables:
    NODE_ENV: production
  secrets:
    - name: API_TOKEN
      fromEnv: API_TOKEN

dependencies:
  enabled: false
  workingDir: ""
  commands:
    - npm install
  continueOnError: false

options:
  restart: true
```

`workspace` 为空时默认使用 `/sandbox/.openclaw/workspace-${agentName}`。

`skill.hostDir` 指向 skills 根目录。CLI 会安装该目录下所有包含 `SKILL.md` 的 skill 子目录；如果该目录本身包含 `SKILL.md`，也兼容作为单个 skill 安装。

`networkPolicy.dir` 指向 network policy 目录。CLI 会应用该目录下所有 `.yaml` / `.yml` 文件；旧配置中的 `networkPolicy.file` 仍兼容单文件路径。

`env.enabled=true` 时，CLI 会把 `variables` 和 `secrets` 合并写入 `${workspace}/${targetFile}`。`secrets[].fromEnv` 从本机环境变量读取，日志中不会打印 secret 值。不要把真实 secret 直接写进 `deploy.yaml`。

`dependencies.enabled=true` 时，CLI 会在 `dependencies.workingDir` 下执行 `commands`。`workingDir` 为空时默认是当前 agent workspace；相对路径会解析到 workspace 内。

Network policy 通过 NemoClaw live policy 写入，应用后不需要 recover。`options.restart=true` 只会在 channel 配置需要重新加载时触发后台 recover。

## 安全策略

- 所有外部命令通过统一 `runCommand` 执行。
- dry-run 模式不执行真实命令。
- gateway token 不会完整打印到日志。
- env secret 不会完整打印到日志，也不会写入本地配置文件。
- dashboard URL 中的 `#token=...` 不会拼入 gateway URL。
- agent-content 不会直接上传覆盖 workspace，而是先上传到 sandbox 临时目录，再由合并脚本按冲突策略处理。
- 非交互模式下 agent-content 冲突默认失败。

## 文档

- [ROADMAP](docs/ROADMAP.md)
- [v0.1.0](docs/releases/v0.1.0.md)
- [v0.2.0](docs/releases/v0.2.0.md)
- [v0.3.0](docs/releases/v0.3.0.md)
- [v1.0.0](docs/releases/v1.0.0.md)
