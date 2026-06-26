# AGENTS.md

## 项目目标

实现一个 Node.js / TypeScript CLI 工具：`nemoclaw-deploy`。

该工具用于在已经部署好的 NemoClaw sandbox 中，安全完成 OpenClaw agent 部署，包括：

1. 创建 OpenClaw agent。
2. 上传 agent 初始化内容。
3. 安装 skill。
4. 配置 `channels.advbot`。
5. 应用 network policy。
6. 做基础验证。

本工具不负责安装 NemoClaw，也不负责创建 sandbox。

---

## 最终使用方式

用户安装：

```bash
npm install -g @your-scope/nemoclaw-deploy
```

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

---

## 技术要求

使用：

```text
Node.js >= 20
TypeScript
commander
@inquirer/prompts
execa
yaml
zod
fs-extra
picocolors
```

项目必须发布为 npm CLI 包。

`package.json` 中需要包含：

```json
{
  "type": "module",
  "bin": {
    "nemoclaw-deploy": "./bin/nemoclaw-deploy.js"
  },
  "files": [
    "bin",
    "dist",
    "templates",
    "README.md"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "prepack": "npm run build"
  },
  "engines": {
    "node": ">=20"
  }
}
```

`bin/nemoclaw-deploy.js`：

```js
#!/usr/bin/env node

import '../dist/index.js';
```

---

## 目录结构

```text
nemoclaw-deploy/
  package.json
  tsconfig.json
  README.md
  AGENTS.md

  bin/
    nemoclaw-deploy.js

  src/
    index.ts

    commands/
      deploy.ts
      doctor.ts
      init-config.ts

    core/
      context.ts
      precheck.ts
      create-agent.ts
      upload-agent-content.ts
      install-skill.ts
      configure-channel.ts
      apply-policy.ts
      verify.ts

    utils/
      run.ts
      logger.ts
      validators.ts
      mask.ts
      yaml.ts
      fs.ts

  templates/
    deploy.yaml
    agent-content/
      AGENTS.md
      USER.md
      SOUL.md
      IDENTITY.md
      MEMORY.md
    policies/
      advbot-channel.yaml
```

---

## 只需要实现的命令

### 1. 默认命令

```bash
nemoclaw-deploy
```

等价于：

```bash
nemoclaw-deploy deploy
```

默认进入交互式部署。

---

### 2. deploy

```bash
nemoclaw-deploy deploy
```

支持：

```bash
nemoclaw-deploy deploy --config deploy.yaml
nemoclaw-deploy deploy --config deploy.yaml --non-interactive
nemoclaw-deploy deploy --config deploy.yaml --dry-run
```

参数：

```text
--config <file>        指定 deploy.yaml
--non-interactive      禁用交互，缺少必要字段时直接失败
--dry-run              只打印计划，不执行命令
```

---

### 3. doctor

```bash
nemoclaw-deploy doctor
```

检查：

1. Node.js 版本。
2. 是否存在 `nemoclaw` 命令。
3. `nemoclaw --version` 是否可执行。

支持：

```bash
nemoclaw-deploy doctor --sandbox demo
```

如果传入 sandbox，则额外执行：

```bash
nemoclaw demo status --json
```

---

### 4. init-config

```bash
nemoclaw-deploy init-config
```

输出 deploy.yaml 模板。

也支持：

```bash
nemoclaw-deploy init-config --output deploy.yaml
```

---

## deploy.yaml 格式

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
  hostDir: ./skills/example

channel:
  enabled: true
  type: advbot
  accountId: default
  channelServerUrl: http://127.0.0.1:8086
  gatewayToken: ""
  gatewayUrl: ""

networkPolicy:
  enabled: true
  file: ./policies/advbot-channel.yaml

options:
  restart: true
```

字段说明：

1. `sandboxName` 必填。
2. `agentName` 必填。
3. `workspace` 为空时，默认使用：

```text
/sandbox/.openclaw/workspace-${agentName}
```

4. `agentContent.enabled=true` 表示上传 agent 初始化内容。
5. `agentContent.conflictStrategy` 控制遇到同名文件时如何处理。
6. `skill.enabled=true` 表示安装 skill。
7. `channel.gatewayToken` 为空时自动获取。
8. `channel.gatewayUrl` 为空时自动从 dashboard URL 推导。
9. `networkPolicy.enabled=true` 表示应用网络策略。
10. `options.restart=true` 表示配置完成后执行 recover。

---

## 交互式输入规则

如果没有配置文件，或者配置文件缺少必要字段，则交互询问。

交互顺序：

```text
请输入 sandbox 名称：
请输入 agent 名称：
请输入 workspace，默认 /sandbox/.openclaw/workspace-${agentName}：

是否上传 agent 初始化内容？Y/n
请输入 agent-content 主机目录：
如果 workspace 中已有同名文件，如何处理？
  ask / skip / backup / overwrite / fail

是否安装 skill？Y/n
请输入 skill 主机目录：

是否配置 advbot channel？Y/n
请输入 channelServerUrl：

是否应用 network policy？Y/n
请输入 network policy 文件路径：

展示部署计划，询问是否继续。
```

注意：

`agentContent.enabled` 必须来自配置文件、CLI 参数或交互结果，不能在程序中固定写死。

---

## 上下文对象

实现统一上下文：

```ts
export interface DeployContext {
  sandboxName: string;
  agentName: string;
  workspace: string;

  agentContent: {
    enabled: boolean;
    hostDir?: string;
    conflictStrategy: 'ask' | 'skip' | 'backup' | 'overwrite' | 'fail';
  };

  skill: {
    enabled: boolean;
    hostDir?: string;
  };

  channel: {
    enabled: boolean;
    type: 'advbot';
    accountId: string;
    channelServerUrl: string;
    gatewayToken?: string;
    gatewayUrl?: string;
  };

  networkPolicy: {
    enabled: boolean;
    file?: string;
  };

  options: {
    restart: boolean;
    nonInteractive: boolean;
    dryRun: boolean;
  };
}
```

默认值：

```text
workspace = /sandbox/.openclaw/workspace-${agentName}
agentContent.enabled = true
agentContent.conflictStrategy = interactive ? ask : fail
skill.enabled = true
channel.enabled = true
channel.type = advbot
channel.accountId = default
networkPolicy.enabled = true
options.restart = true
```

---

## 外部命令执行规则

所有命令都必须通过统一函数执行。

实现：

```ts
export async function runCommand(
  command: string,
  args: string[],
  options?: {
    dryRun?: boolean;
    sensitive?: boolean;
    env?: Record<string, string>;
  }
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>
```

要求：

1. 使用 `execa`。
2. 默认注入环境变量：

```text
NO_COLOR=1
TERM=xterm-256color
```

3. `dryRun=true` 时只打印命令，不执行。
4. token 必须脱敏。
5. 命令失败时抛出明确错误。
6. 不要在日志中打印完整 gateway token。
7. 如果命令参数里包含 token，日志里替换成 `******`。

---

## 部署流程

### 1. 预检查

执行：

```bash
nemoclaw --version
```

检查 sandbox：

```bash
nemoclaw <sandboxName> status --json
```

失败时停止部署，并提示：

```text
sandbox 不可用，请先确认 sandbox 已创建并运行。
可尝试执行：nemoclaw <sandboxName> recover
```

---

### 2. 创建 agent

执行：

```bash
nemoclaw <sandboxName> agents add <agentName> \
  --workspace <workspace> \
  --non-interactive \
  --json
```

如果 agent 已存在，不要失败。

处理逻辑：

1. 先尝试创建。
2. 如果失败，执行：

```bash
nemoclaw <sandboxName> agents list --json
```

3. 如果列表中已经存在该 agent，继续后续步骤。
4. 如果不存在，则失败。

---

### 3. 上传 agent 初始化内容

如果：

```text
agentContent.enabled=true
```

则上传 agent 内容。

不要直接上传到 workspace。

错误示例：

```bash
nemoclaw <sandboxName> upload <agentContent.hostDir>/ <workspace>/
```

不要这样做，因为可能覆盖已有 `AGENTS.md`、`USER.md`、`SOUL.md`、`IDENTITY.md`、`MEMORY.md`。

正确流程：

1. 校验 `agentContent.hostDir` 是主机真实目录。
2. 校验目录非空。
3. 上传到 sandbox 临时目录：

```bash
nemoclaw <sandboxName> upload \
  <agentContent.hostDir>/ \
  /tmp/nemoclaw-deploy/<agentName>/agent-content/
```

4. 上传合并脚本：

```bash
nemoclaw <sandboxName> upload \
  <local-merge-script> \
  /tmp/nemoclaw-deploy/<agentName>/merge-agent-content.mjs
```

5. 执行合并脚本：

```bash
nemoclaw <sandboxName> exec -- \
  env WORKSPACE='<workspace>' \
      SOURCE_DIR='/tmp/nemoclaw-deploy/<agentName>/agent-content' \
      CONFLICT_STRATEGY='<strategy>' \
      node /tmp/nemoclaw-deploy/<agentName>/merge-agent-content.mjs
```

合并策略：

```text
ask
  交互模式下发现冲突时询问用户。
  注意：ask 应该在主程序里提前处理，sandbox 内脚本不做交互。

skip
  目标文件已存在时跳过。

backup
  目标文件已存在时，先备份为 .bak.<timestamp>，再覆盖。

overwrite
  直接覆盖。

fail
  只要发现同名文件就失败。
```

交互模式默认：`ask`。

非交互模式默认：`fail`。

如果策略是 `ask`，主程序应先检查冲突文件并让用户选择最终策略：`skip`、`backup`、`overwrite` 或 `fail`，不要让 sandbox 内脚本交互。

---

### 4. 安装 skill

如果：

```text
skill.enabled=true
```

则执行：

```bash
nemoclaw <sandboxName> skill install <skill.hostDir>
```

要求：

1. `skill.hostDir` 必须存在。
2. `skill.hostDir/SKILL.md` 必须存在。
3. 不要手动复制 skill 到 `.openclaw/skills`。

---

### 5. 获取 gatewayToken

如果：

```text
channel.enabled=true
```

并且：

```text
channel.gatewayToken 为空
```

则执行：

```bash
nemoclaw <sandboxName> gateway-token --quiet
```

规则：

1. stdout trim 后作为 token。
2. 获取失败时，交互模式允许用户手动输入。
3. 非交互模式直接失败。
4. 不要用 `config get gateway.auth.token` 获取 token。
5. 不要打印完整 token。

脱敏规则：

```ts
export function maskSecret(value?: string): string {
  if (!value) return '';
  if (value.length <= 8) return '******';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
```

---

### 6. 获取 gatewayUrl

如果：

```text
channel.enabled=true
```

并且：

```text
channel.gatewayUrl 为空
```

则执行：

```bash
nemoclaw <sandboxName> dashboard-url --quiet
```

从返回的 dashboard URL 推导 gateway URL。

推导规则：

1. 对返回值执行 `trim()`。
2. 使用 `new URL(dashboardUrl)` 解析。
3. 如果协议是 `http:`，gatewayUrl 使用 `ws:`。
4. 如果协议是 `https:`，gatewayUrl 使用 `wss:`。
5. 使用相同的 host。
6. 不要保留 URL path。
7. 不要保留 query。
8. 不要保留 hash。
9. 如果 dashboard URL 中包含 `#token=...`，必须丢弃。
10. 最终格式示例：

```text
http://127.0.0.1:18791/#token=xxx
```

转换为：

```text
ws://127.0.0.1:18791
```

示例实现：

```ts
export function dashboardUrlToGatewayUrl(input: string): string {
  const url = new URL(input.trim());

  if (url.protocol === 'http:') {
    return `ws://${url.host}`;
  }

  if (url.protocol === 'https:') {
    return `wss://${url.host}`;
  }

  throw new Error(`Unsupported dashboard URL protocol: ${url.protocol}`);
}
```

如果自动获取失败：

1. 交互模式允许用户手动输入。
2. 非交互模式直接失败。

---

### 7. 配置 advbot channel

如果：

```text
channel.enabled=true
```

则写入 OpenClaw 配置。

目标配置：

```json
{
  "channels": {
    "advbot": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "accountId": "default",
          "channelServerUrl": "http://127.0.0.1:8086",
          "gatewayToken": "real-token",
          "gatewayUrl": "ws://127.0.0.1:18791"
        }
      }
    }
  }
}
```

优先尝试：

```bash
nemoclaw <sandboxName> config set \
  --key channels.advbot \
  --value '<json>' \
  --restart
```

如果失败，使用安全 patch 脚本方式。

patch 脚本流程：

1. 生成本地临时脚本 `patch-advbot-channel.mjs`。
2. 上传：

```bash
nemoclaw <sandboxName> upload \
  <local-patch-script> \
  /tmp/nemoclaw-deploy/<agentName>/patch-advbot-channel.mjs
```

3. 执行：

```bash
nemoclaw <sandboxName> exec -- \
  env ACCOUNT_ID='<accountId>' \
      CHANNEL_SERVER_URL='<channelServerUrl>' \
      GATEWAY_TOKEN='<gatewayToken>' \
      GATEWAY_URL='<gatewayUrl>' \
      node /tmp/nemoclaw-deploy/<agentName>/patch-advbot-channel.mjs
```

patch 脚本内容：

```js
import fs from 'node:fs';

const configPath = '/sandbox/.openclaw/openclaw.json';

const accountId = process.env.ACCOUNT_ID || 'default';
const channelServerUrl = process.env.CHANNEL_SERVER_URL;
const gatewayToken = process.env.GATEWAY_TOKEN;
const gatewayUrl = process.env.GATEWAY_URL;

if (!channelServerUrl) throw new Error('CHANNEL_SERVER_URL is required');
if (!gatewayToken) throw new Error('GATEWAY_TOKEN is required');
if (!gatewayUrl) throw new Error('GATEWAY_URL is required');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

config.channels ??= {};
config.channels.advbot ??= {};
config.channels.advbot.enabled = true;
config.channels.advbot.accounts ??= {};

config.channels.advbot.accounts[accountId] = {
  enabled: true,
  accountId,
  channelServerUrl,
  gatewayToken,
  gatewayUrl
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
```

注意：

1. 日志里不要打印完整 `gatewayToken`。
2. `channelServerUrl` 不允许带尖括号。
3. `gatewayUrl` 不允许带 token fragment。
4. `gatewayUrl` 必须是 `ws://` 或 `wss://`。

---

### 8. 应用 network policy

如果：

```text
networkPolicy.enabled=true
```

则执行：

```bash
nemoclaw <sandboxName> policy-add --from-file <networkPolicy.file> --yes
```

要求：

1. 文件必须存在。
2. 文件必须是 `.yaml` 或 `.yml`。
3. 不自动修改用户提供的 policy 文件。
4. 应用失败时输出错误原因。

---

### 9. recover

如果：

```text
options.restart=true
```

在 channel 配置或 policy 应用后执行：

```bash
nemoclaw <sandboxName> recover
```

如果 recover 失败，不要隐藏错误。

---

### 10. 验证

执行：

```bash
nemoclaw <sandboxName> agents list --json
```

确认 agent 存在。

执行：

```bash
nemoclaw <sandboxName> status --json
```

确认 sandbox 状态可读取。

如果启用了 channel，确认：

```text
gatewayToken 已获取
gatewayUrl 已获取
channelServerUrl 已填写
```

如果启用了 network policy，确认 policy 命令执行成功。

最后输出部署摘要。

摘要中 token 必须脱敏。

---

## 安全要求

1. 不打印完整 gateway token。
2. 不把 gateway token 写到本地配置文件。
3. 不把 dashboard URL 的 `#token=...` 拼到 gatewayUrl。
4. 不直接覆盖 workspace 中已有文件。
5. 非交互模式下遇到 agent-content 文件冲突默认失败。
6. 所有外部命令通过统一 `runCommand` 执行。
7. 所有用户输入都要校验。
8. 临时脚本执行完成后尽量清理。
9. `dry-run` 模式不能执行真实命令。
10. 错误信息要明确，不要吞掉命令失败原因。

---

## 输入校验

### sandboxName

```regex
^[a-zA-Z0-9._-]+$
```

### agentName

```regex
^[a-z][a-z0-9_-]{0,31}$
```

### channelServerUrl

必须是：

```text
http://...
https://...
```

如果用户输入：

```text
<http://127.0.0.1:8086>
```

应该自动去掉首尾尖括号，或提示用户修正。

### gatewayUrl

必须是：

```text
ws://...
wss://...
```

不能包含：

```text
#token=
```

### skill.hostDir

必须存在，且包含：

```text
SKILL.md
```

### agentContent.hostDir

必须存在，且目录非空。

### networkPolicy.file

必须存在，且后缀为：

```text
.yaml
.yml
```

---

## 部署计划输出

真正执行前必须输出计划：

```text
部署计划：

Sandbox: demo
Agent: my-agent
Workspace: /sandbox/.openclaw/workspace-my-agent

Agent Content: enabled
Agent Content Dir: ./agent-content
Conflict Strategy: ask

Skill: enabled
Skill Dir: ./skills/example

Channel: advbot/default
Channel Server URL: http://127.0.0.1:8086
Gateway URL: auto from dashboard-url
Gateway Token: auto from gateway-token

Network Policy: enabled
Policy File: ./policies/advbot-channel.yaml

Restart / Recover: enabled
```

交互模式下询问：

```text
是否继续？Y/n
```

非交互模式下直接执行。

---

## 部署完成输出

示例：

```text
部署完成：

Sandbox: demo
Agent: my-agent
Workspace: /sandbox/.openclaw/workspace-my-agent

Agent Content: applied
Skill: installed
Channel: advbot/default configured
Channel Server URL: http://127.0.0.1:8086
Gateway URL: ws://127.0.0.1:18791
Gateway Token: 628f3b...5265
Network Policy: applied

验证命令：
nemoclaw-deploy doctor --sandbox demo
```

---

## 模板文件

### templates/deploy.yaml

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
  hostDir: ./skills/example

channel:
  enabled: true
  type: advbot
  accountId: default
  channelServerUrl: http://127.0.0.1:8086
  gatewayToken: ""
  gatewayUrl: ""

networkPolicy:
  enabled: true
  file: ./policies/advbot-channel.yaml

options:
  restart: true
```

### templates/policies/advbot-channel.yaml

```yaml
preset:
  name: advbot-channel
  description: "Allow OpenClaw advbot plugin to access channel server"

network_policies:
  advbot-channel:
    name: advbot-channel
    endpoints:
      - host: 127.0.0.1
        port: 8086
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
          - allow: { method: PUT, path: "/**" }
          - allow: { method: DELETE, path: "/**" }
    binaries:
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
      - { path: /usr/bin/curl }
      - { path: /usr/local/bin/openclaw }
```

---

## 实现完成标准

以下命令必须可用：

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

真实环境中：

```bash
nemoclaw-deploy deploy --config deploy.yaml
```

应该能完成：

```text
创建 agent
安全上传 agent-content
安装 skill
自动获取 gatewayToken
自动从 dashboard-url 推导 gatewayUrl
配置 advbot channel
应用 network policy
完成基础验证
```
