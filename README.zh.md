# dsh-sms

通过你的手机真实号码，把短信/RCS 接入 DeepSeek Harness：基于 Google Messages for Web。
配对一次手机、保存信任的号码，之后这些号码发来的 1:1 短信都会变成 DSH prompt，DSH 的最终回答再以短信发回去。

传输层基于 [gmessages](https://www.npmjs.com/package/gmessages)——一个对 Google Messages for Web 协议的 TypeScript 客户端实现，所有协议字段都对照 Google 官方 descriptor 验证过。

## 工作原理

```
对方手机 ──SMS/RCS──▶ 你的手机（Google Messages）
                          │ （messages.google.com 中继）
                          ▼
                    dsh-sms 监听器（本地 DSH Host）
                          │  入站短信 → DSH prompt
                          ▼
                   DeepSeek Harness 会话
                          │  最终回答 → SMS/RCS
                          ▼
                    dsh-sms 监听器 → 你的手机 → 对方手机
```

- 监听器运行在 DSH Host（你的 Mac）上，与 Google Messages 中继保持长连接。**这个连接就是会话的命脉**：只有持续运行，cookie/token 才会不断轮转、会话才能存活；闲置超过几小时会话就会失效。
- 只接受**来自授权号码的 1:1 会话**；群聊、纯媒体消息、你自己发出的消息一律忽略。
- DSH 回答先转成纯文本，再按字形边界分块（每块 ≤3500 字符，贴合短信长度限制）；代码块内容原样保留。
- DSH 运行期间会显示"正在输入"状态。

## 环境要求

- DeepSeek Harness `0.1.0-rc.6` 或兼容版本（已在本机 `0.1.0-rc.8` 验证）
- Node.js `^22.19 || >=24`
- 一个已登录 Google Messages 的 Google 账号（手机）
- 手机需要保持在线；配对时要在手机上确认配对码

## 安装

```sh
dsh plugin --profile web add dsh-sms
```

重启 `dsh web`，打开 **设置 → SMS**。

本地开发安装请用打包后的 tarball，不要以目录 link 方式安装。构建产物 `lib/index.js` 已把插件自身的运行时依赖（`gmessages`、`zod`）打包进去，tarball 只依赖 Host 已经提供的 DSH 包：

```sh
npm ci --legacy-peer-deps
npm run build
npm pack
dsh plugin --profile web add ./dsh-sms-*.tgz
```

## 三步配置

1. **授权号码**：输入你要接入的 E.164 号码（每行一个）并保存。
2. **配对手机**：在**无痕窗口**里登录 `messages.google.com`（Firefox/Safari 可以避开 Chrome 的设备绑定会话），导出 cookie（用开源 cookie 导出扩展，或 DevTools → Application → Cookies），粘贴进来，点击 **Start pairing**。手机会弹出带配对码的确认提示——在手机上批准即可。插件把生成的会话存入 DSH 凭据库，cookie 用完即弃。
3. **发短信**：用任意授权号码给你的手机号发一条短信，它会作为 DSH prompt 进来，最终回答以短信返回。

监听器状态（正在监听 / 重连中 / 失败）、当前 DSH 会话、断开/重试按钮都在同一个设置页上。

## 命令

普通文字按 DSH prompt 排队。想发送以 `/` 开头的普通 prompt，用 `//` 前缀，例如 `//review this route`。

| 命令 | 作用 |
|---|---|
| `/help` | 显示命令帮助。 |
| `/new` | 创建并选中一个新根会话。 |
| `/sessions [page]` | 列出同工作区根会话，每页 5 个。 |
| `/switch <index\|session-id>` | 按序号、完整 ID 或唯一前缀切换会话。 |
| `/status` | 显示当前会话及其状态。 |
| `/stop` 或 `/cancel` | 停止当前回合作废仍在排队的 prompt。 |
| `/approve <request-id>` | 批准一个与该短信回合关联的审批请求。 |
| `/deny <request-id>` | 拒绝关联的审批请求。 |
| `/answer <request-id> <选项或文字>` | 回答关联的问题；逗号分隔多选。 |

新会话使用 `dsh web` 的工作目录、默认 Agent Preset 和当前默认模型。有 prompt 排队或交互等待时禁止切换会话——先发 `/stop`。

## 安全

会话文档持有账号级 Google 凭据，只存放在 DSH 凭据库中。cookie 配对时用一次即丢弃。消息正文和手机号永不写日志。只有授权号码的 1:1 会话会被路由。完整边界见 [SECURITY.md](SECURITY.md)。

## 配置

以下配置仅 Host 侧生效，不出现在设置页：

| 选项 | 默认值 |
|---|---:|
| `interactionTimeoutMs` | `600000`（10 分钟） |
| `maxOutboundChars` | `3500` 字形 |
| `sessionsPerPage` | `5` |
| `dedupeEntries` | `1024` |
| `reconnectMinMs` | `1000` |
| `reconnectMaxMs` | `60000` |

在 web profile 的 `cordis.patch.yml` 里覆盖 bundle 行。DSH patch 覆盖会替换整行，所以要同时保留 `id` 和 `name`：

```yaml
- id: dsh-sms
  name: dsh-sms
  config:
    interactionTimeoutMs: 900000
    maxOutboundChars: 3000
```

## 故障排查

| 错误 | 处理 |
|---|---|
| `invalid-phone` | 输入 `+`、非零国家码数字、最多 15 位数字。 |
| `invalid-cookies` | 粘贴来自 `messages.google.com` 的 Netscape/JSON cookie 导出。 |
| `dbsc-session-refused` | 导出来自 Chrome 设备绑定会话；改用无痕窗口或 Firefox/Safari。 |
| `pairing-expired` | 重新开始，并在中继保留窗口内于手机上批准。 |
| `pairing-denied` | 手机没有批准配对请求。 |
| `session-dead` | 存储的会话不再能通过认证（中继拒绝了它的 cookie，或手机已解除配对）。监听器会停下而不是无限重连；断开后重新配对。 |
| `settings-conflict` | 另一个窗口改过设置；刷新重试。 |
| `credential-readonly` / `settings-readonly` | 移除更高优先级的只读 DSH 覆盖。 |

## 限制

- 每个插件实例一个 Google 账号/会话。
- 仅文本 1:1 会话。附件、反应、群聊、输入状态事件一律忽略（媒体不会转发给 DSH）。
- SMS 无法报告送达：发到中继即视为 `accepted`，短信线程没有已读回执（RCS 线程可能更多）。
- 会话必须持续连接才能轮转；长期闲置会失效并需要重新配对。
- Google 条款可能禁止自动化访问 Messages for Web；获取 cookie 导出是有意保留的人工步骤。

## 开发

```sh
npm ci --legacy-peer-deps
npm test
npm run build
npm pack --dry-run
# 有 dsh 可执行文件时：
DSH_BIN=/path/to/dsh npm run test:profile
```

测试覆盖：入站策略、号码匹配、Supervisor 重连退避与永久死亡处理、重放去重、配对错误分类、回合归属、交互失败关闭行为、分块、纯文本转换、设置页 UI。CI 会跑测试套件、打包产物检查，以及一次性的 DSH web profile 安装验证。`npm run audit:prod` 审计整棵依赖树，因为包本身已没有运行时依赖可单独审计。

评审记录与开发规划见 `docs/`：[`docs/REVIEW-2026-09-03.md`](docs/REVIEW-2026-09-03.md)、[`docs/ROADMAP.md`](docs/ROADMAP.md)。

## License

MIT
