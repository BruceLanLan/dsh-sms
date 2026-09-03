# dsh-sms 后续开发规划

写于 2026-09-03，依据 `docs/REVIEW-2026-09-03.md`。每个里程碑按 T6 交接单格式：目标、背景事实、约束、带验证点的步骤、范围边界、完成定义。步骤按风险排序，最不确定的在前。

## 立即行动：把本次修复部署到本机

目标：本机 `dsh web` 加载的是当前仓库的构建，而不是 8 月 29 日的 vendor 副本。

背景事实：
- 当前 profile 以 `link:/Users/bruce/.dsh/vendor/dsh-sms-0.1.0` 挂载插件；`link:` 不安装插件依赖，这正是 8/29 故障的根因。现在产物已把依赖打包，改用 tarball 安装后不再有这个问题。
- `dsh web` 由 `~/.dsh/dsh-web-supervisor.zsh` 守护，会自动重启。
- 重启会中断正在进行的 DSH 会话，时机由用户定。

步骤：
1. `npm run build && npm pack` → 验证点：生成 `dsh-sms-0.1.0.tgz`，`tar tzf` 里有 `package/lib/index.js` 且 > 700 KB。
2. `dsh plugin --profile web add ./dsh-sms-0.1.0.tgz` → 验证点：`~/.dsh/profiles/web/package.json` 里 `dsh-sms` 不再是 `link:`。若失败：`dsh plugin --profile web remove dsh-sms` 后重加。
3. 重启 `dsh web` → 验证点：`web-supervisor.log` 出现 `dsh-sms: listener listening`（新日志行），设置页 Listener 显示 Listening。
4. 从授权号发 `/status` → 验证点：收到 "Active session…" 回复。

范围边界：不改 supervisor 脚本，不动其它插件。

完成定义：4 个验证点全部有实际输出。

## M1：配对体验与服务层可测性

目标：配对时浏览器能看到校验码并能取消；`DshSmsService` 有单元测试覆盖主要 RPC。

背景事实：
- `beginPairing` 目前 `await pairWithGoogle(...)`，RPC 阻塞到手机确认；客户端 `controller.refresh()` 与 `schedulePoll()` 在 `pendingAction` 非空时直接返回，所以 `pairing` 阶段的状态永远刷不到浏览器。
- `pairingTask` 字段已存在但从未赋值，说明最初就是按后台任务设计的。
- 完成配对时的 `settings.update(..., request.expectedRevision)` 用的是请求时的 revision；改成后台任务后，用户可能在等待期间保存号码，revision 会变。
- `index.ts` 没有测试，因为构造 `DshSmsService` 需要 cordis Context 加 11 个宿主服务。

约束：不改 RPC 接口形状（`MutationResult`/`SmsPluginState`），客户端无需升级即可兼容。

步骤：
1. **先建服务层测试夹具**：仿照 `tests/session-router.test.ts` 的假 Context，补 `settings`/`credentials`/`storageDomain`（内存实现）、假 `SmsSupervisor` 工厂、假 `pairWithGoogle`。→ 验证点：能 `new DshSmsService(ctx)`、走完 `Service.init`、`getState()` 返回 `phase: 'idle'`。这一步最不确定，做不成就说明要先在 `index.ts` 上开注入缝（把 `pairWithGoogle`、`createGmessagesConnection` 变成构造参数）。
2. `beginPairing` 改后台任务：立即把 `pairingOverride` 置为 `awaiting-cookies`，把 `pairWithGoogle` 的 promise 存进 `pairingTask`，RPC 返回当前状态；完成时用 `this.settingsDescriptor().revision` 做写入，失败按现有逻辑回滚凭据；`busy` 分支改为"pairingTask 未完成"。→ 验证点：测试里 `beginPairing` 在 `onVerification` 触发后就返回，`getState().pairing.phase === 'pairing'` 且带 emoji/numeric；确认后变 `paired`。
3. `cancelPairing` 在后台任务进行中可用 → 验证点：取消后 `pairingTask` 以 AbortError 结束，状态回 `idle`，凭据未写。
4. 设置页：`pairing` 阶段禁用"Save numbers"，避免并发写 revision → 验证点：`tests/ui.test.tsx` 新增用例。
5. `pairedAt` 持久化到 domain global，启动时读回 → 验证点：重启后 `getState().pairing.pairedAt` 不变。
6. 给 `createGmessagesConnection` 建假 `connect()` 夹具（注入 `onEvent`/`finished`），覆盖 `unpaired`/`accountChange` 推送和 `jar-dead` 真实路径；目前监督器测试用的是假连接，真实工厂的这条路径没有自动化覆盖。
7. README / README.zh / SECURITY 同步描述。

范围边界：不做多账号；不改 gmessages 版本。

完成定义：以上验证点全部通过；`npm run check` 通过；本机实际配对一次，浏览器看见校验码。

## M2：DSH 版本兼容矩阵

目标：明确插件支持的 DSH 版本区间，并让 CI 替代人肉验证。

背景事实：
- devDependencies 钉在 rc.6，本机 rc.8，npm `latest` 是 `0.1.1-rc.2`，`next` 是 `0.1.2-rc.1`。peer 范围 `<0.2.0` 把这些全放行了，但只有 rc.6 被 CI 验证。
- `@deepseek-ai/dsh-typert-generator` wanted 已是 rc.8。
- CI 里 `pnpm/action-setup` 是无用步骤。
- CI 改动按用户约定先征求同意。

步骤：
1. 本地用 `npm install --no-save @deepseek-ai/dsh@0.1.1-rc.2 …` 装一套 latest，跑 `npm run typecheck && npm test && DSH_BIN=… npm run test:profile` → 验证点：三项结果记录进 `docs/COMPAT.md`。若 typecheck 挂：列出破坏性变更，决定 peer 上界收紧到 `<0.1.1` 还是适配。
2. 同样对 rc.8 做一遍（本机已有二进制）。
3. **征得用户同意后**改 CI：matrix 增加一列 `dsh: [rc.6, rc.8, 0.1.1-rc.2]`（后两者 `continue-on-error`），删 pnpm 步骤。
4. 升 `dsh-typert-generator` 到 rc.8 → 验证点：`lib/typert.*` 产物 diff 为空或仅注释变化。

范围边界：不追 `next`/`alpha` 通道。

完成定义：`docs/COMPAT.md` 有三行真实结果；CI 绿。

## M3：使用体验

目标：短信这一侧在长任务中不"失联"，并支持图片入站。

背景事实：
- `responding()` 只在 turn 开始/结束各发一次 typing；Google 的 typing 指示器几十秒就过期。
- 用户在长 turn 中收不到任何中间反馈。
- gmessages 已提供 `downloadMedia`、`InboundAttachment`、`reportsDelivery`、`deliveryStateOf`。
- 没有入站限流；同一授权号短时间连发会串行排队。

步骤（各自独立，可挑着做）：
1. 进度反馈：turn 超过 N 秒（配置项，默认 30s）发一条 "Still working…"，之后每 M 秒刷新 typing → 验证点：假时钟测试。
2. 图片入站：附件 → `downloadMedia` → DSH attachment 随 prompt 提交 → 验证点：router 测试里附件出现在 `createUserMessage` 的 content 中；SECURITY 增加"媒体只落本地临时目录、turn 结束即删"。
3. 入站合并：同一会话 2 秒内多条文本合并成一个 prompt → 验证点：dedupe/router 测试。
4. RCS 送达回读：`send()` 后若 `reportsDelivery` 为真，把送达状态写进诊断日志 → 验证点：日志行。

范围边界：不做群聊、不做多设备、不做语音。

完成定义：每项有测试与一次真机验证记录。

## M4：发布 0.2.0

步骤：
1. `CHANGELOG.md`：本次评审修复 + M1–M3 内容。
2. 版本号 0.2.0（`session-dead` 语义变化和依赖打包算行为变更）。
3. `npm publish`（需要用户 npm 账号，Agent 做不了）→ 验证点：`npm view dsh-sms version`。
4. GitHub Release 附 tgz。

## 已知不做

- 多 Google 账号 / 多手机。
- 绕过 Google 登录检查或自动获取 cookie。
- 群聊路由。
