const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshOrb', {
  move(x, y, canDock) {
    return ipcRenderer.invoke('orb:move', { x, y, canDock: canDock !== false })
  },
  clamp(canDock) {
    return ipcRenderer.invoke('orb:clamp', canDock !== false)
  },
  unsnap() {
    return ipcRenderer.invoke('orb:unsnap')
  },
  setExpanded(expanded) {
    return ipcRenderer.invoke('orb:expand', Boolean(expanded))
  },
  /**
   * 独立版新增：把面板尺寸写回窗口层。
   * 真机上由 Electron 的 resized 事件自动驱动；此通道供无显示器环境测试用。
   */
  setPanelSize(width, height) {
    return ipcRenderer.invoke('orb:resize', Number(width) || 0, Number(height) || 0)
  },
  /**
   * 发一条用户消息。
   *
   * `attachments`（P2-4 新增，可选）是图片附件数组，每项形如：
   *   { name, mimeType, data }   // data 是 **base64（不含 data: 前缀）**
   *
   * ⚠️ 为什么不在这里做字段白名单：与 `conversationAction` 同一条教训 ——
   *    白名单会**静默丢字段**（`password` 被丢过一次）。这里的 attachments
   *    由渲染层构造，host 与主进程各自做长度/类型校验。
   *
   * ⚠️ 传空数组时**不传这个 key**，保持与旧 host 的二进制兼容语义：
   *    老版本 host 只认 `{type:'prompt', text}`，多一个 null 字段不影响它，
   *    但少走一个分支更干净。
   */
  send(text, attachments) {
    const payload = { type: 'prompt', text: String(text ?? '') }
    if (Array.isArray(attachments) && attachments.length > 0) {
      payload.attachments = attachments
    }
    ipcRenderer.send('orb:prompt', payload)
  },
  answerQuestion(id, answers) {
    ipcRenderer.send('orb:question-answer', { id, answers })
  },
  cancelQuestion(id) {
    ipcRenderer.send('orb:question-cancel', id)
  },
  requestHistory() {
    ipcRenderer.send('orb:history')
  },
  openSession(id) {
    ipcRenderer.send('orb:open', id)
  },
  /**
   * 独立版新增：对话级操作（重命名 / 删除 / 锁定 / 设强锁密码）。
   * 菜单项不硬编码在渲染层，由渲染层把 action id + 载荷交给 host，
   * host 决定能不能做、回不回包。
   *
   * ⚠️ 载荷**原样透传**，preload 不做字段白名单。
   *    上一版按「只转发已知字段」写，结果加 `history.set-password` 时
   *    `password` 被静默丢掉 —— host 收到空密码，回一句「密码不能为空」，
   *    用户看到的是「设了密码但没生效」。凡是「静默丢字段」都是同一族病。
   */
  conversationAction(action, payload) {
    ipcRenderer.send('orb:conversation-action', { action, payload: payload ?? {} })
  },
  newSession() {
    ipcRenderer.send('orb:new')
  },
  setPermission(preset) {
    ipcRenderer.send('orb:permission', preset)
  },
  stop() {
    ipcRenderer.send('orb:stop')
  },
  copy(text) {
    ipcRenderer.send('orb:copy', text)
  },
  openMenu() {
    return ipcRenderer.invoke('orb:menu')
  },
  /**
   * 独立版新增：渲染层 DOM 右键菜单需要临时关掉球态的鼠标穿透。
   *
   * 背景：右键菜单原本走 Electron 原生 `Menu.popup()`，但
   *   1. 原生菜单是 OS 级窗口，z-index 管不到，transparent 窗口下锚点易错位；
   *   2. 球态设了 `setIgnoreMouseEvents(true, { forward: true })`，
   *      原生 `context-menu` 事件不保证触发 —— 表现为「右键球没反应」。
   * 所以改为渲染层 DOM 菜单，由它在 `open()` / `close()` 里如实上报开关。
   *
   * ⚠️ 只报「开着/关着」，**不要**自己传 forward 或做延时恢复 ——
   * 2026-10-07 实测那套「延时 220ms 无条件恢复穿透」会把球弄成死的：
   * 面板已经展开时还恢复穿透，用户看到的就是「亮着但点不动的球」。
   * 恢复时机与「是否该穿透」的判断都在主进程，那里才知道展开态。
   */
  setMenuHold(holding) {
    ipcRenderer.send('orb:menu-hold', holding === true)
  },
  /**
   * 可编辑区（输入框）右键时弹原生编辑菜单。
   *
   * Electron **默认不弹**浏览器原生右键菜单，所以「让给浏览器」等于
   * 「右键完全没反应」，用户没法复制粘贴 —— P0-4 实测踩过。
   * 这里显式用编辑角色弹一个，让复制/粘贴真的能用。
   */
  popupEditMenu() {
    ipcRenderer.send('orb:edit-menu')
  },
  /** 换头像。helper 侧 `applyAvatar` 自带 `isSafePresetSrc` 校验。 */
  setAvatar(src) {
    ipcRenderer.send('orb:avatar-set', src)
  },
  /**
   * 取头像预设清单。渲染层的「更换显示样式」要用它弹 DOM 菜单 ——
   * **清单只在 helper 侧有一份**（`AVATAR_PRESETS`），渲染层不复制，
   * 免得以后加预设要改两个地方。
   */
  listAvatars() {
    return ipcRenderer.invoke('orb:avatars')
  },
  /** 打开旧后端 Web UI。地址（legacyHttp）由 host 推给 helper，球侧不存。 */
  openLegacyWeb() {
    ipcRenderer.send('orb:open-legacy-web')
  },
  /**旧后端地址的当前值，给「API 配置」页判断能不能打开 Web UI。 */
  legacyStatus() {
    return ipcRenderer.invoke('orb:legacy-status')
  },
  /**
   * 「设置」抽屉的读写（2026-10-19 重组：模型/密钥 + 微信合成一条通道）。
   *
   * 读回 `{ ok, model, providerLabel, baseUrl, apiKey, configPath, authPath,
   *        contextBudgetTokens, wechat: { file, enabled, botToken, baseUrl, description } }`
   * 或 `{ ok: false, error }`；
   * 写盘只认 `{ model, baseUrl, apiKey, contextBudgetTokens, reasoningEffort, wechat }` ——
   * 缺键 = 用户没动，`contextBudgetTokens: null` / `reasoningEffort: null` = 清掉回出厂，
   * 微信改完 host 会**立刻重启桥**（旧长轮询攥着旧 token，不重启等于没改）。
   * 渲染层不做文件 IO，也不缓存 key。
   */
  apiConfigGet() {
    return ipcRenderer.invoke('orb:api-config-get')
  },
  apiConfigSet(patch) {
    const wechat = patch?.wechat && typeof patch.wechat === 'object' ? patch.wechat : undefined
    return ipcRenderer.invoke('orb:api-config-set', {
      model: typeof patch?.model === 'string' ? patch.model : undefined,
      baseUrl: typeof patch?.baseUrl === 'string' ? patch.baseUrl : undefined,
      apiKey: typeof patch?.apiKey === 'string' ? patch.apiKey : undefined,
      contextBudgetTokens: patch?.contextBudgetTokens === null
        ? null
        : Number.isInteger(patch?.contextBudgetTokens) ? patch.contextBudgetTokens : undefined,
      // 推理（思考）档位：`null` = 清掉这个键回出厂 max；字符串交给宿主再校验一次
      //（宿主持有 `EFFORT_VALUES`，这里只做类型闸门，不重复写一份合法值清单）。
      reasoningEffort: patch?.reasoningEffort === null
        ? null
        : typeof patch?.reasoningEffort === 'string' && patch.reasoningEffort !== ''
          ? patch.reasoningEffort
          : undefined,
      wechat: wechat
        ? {
            enabled: typeof wechat.enabled === 'boolean' ? wechat.enabled : undefined,
            botToken: typeof wechat.botToken === 'string' ? wechat.botToken : undefined,
            baseUrl: typeof wechat.baseUrl === 'string' ? wechat.baseUrl : undefined,
          }
        : undefined,
    })
  },
  /**
   * B 站扫码登录（2026-10-21）。
   *
   * 登录只走扫码：`biliLoginStart()` 拿回 `{ ok, qrcodeKey, url, svg, expiresAt }`，
   * 渲染层把 `svg` 直接塞进容器的 innerHTML，然后每 2 秒 `biliLoginPoll(key)`。
   * `state` ∈ `waiting|scanned|confirmed|expired`，`confirmed` 时宿主已把 cookie 落盘。
   *
   * 口令（SESSDATA 等）**永不回渲染层** —— `biliStatus()` 只给 uname/avatar/expiresAt。
   */
  biliStatus(opts) {
    return ipcRenderer.invoke('orb:bili-status', {
      verify: opts?.verify === true,
    })
  },
  biliLoginStart() {
    return ipcRenderer.invoke('orb:bili-login-start')
  },
  biliLoginPoll(qrcodeKey) {
    return ipcRenderer.invoke('orb:bili-login-poll', String(qrcodeKey ?? ''))
  },
  biliLogout() {
    return ipcRenderer.invoke('orb:bili-logout')
  },
  /**
   * 「看过的视频」账本（本地记录，只读；清空要用户自己点）。
   * 与 `bili_watch` 工具、`bili_history` 工具读的是同一份 `data/bili-history.json`。
   */
  biliHistory(opts) {
    return ipcRenderer.invoke('orb:bili-history', { limit: Number(opts?.limit) || 50 })
  },
  biliHistoryClear() {
    return ipcRenderer.invoke('orb:bili-history-clear')
  },
  /** 删掉账本里的一条（只删本地这条，B 站的观看/点赞记录不动）。 */
  biliHistoryDelete(payload) {
    return ipcRenderer.invoke('orb:bili-history-delete', {
      bvid: String(payload?.bvid ?? ''),
      cid: Number(payload?.cid) || 0,
    })
  },
  /**
   * 对一条视频做动作：`action` ∈ `like` / `coin` / `fav`。
   * ★ 这些会**真的改动用户账号**（赞会进他的动态），所以只由用户点按钮触发。
   * 不需要挂网页：B 站这批接口是普通 POST，cookie 里带着 bili_jct 就够。
   */
  biliAct(payload) {
    return ipcRenderer.invoke('orb:bili-act', {
      bvid: String(payload?.bvid ?? ''),
      cid: Number(payload?.cid) || 0,
      action: String(payload?.action ?? ''),
      count: payload?.count === 2 ? 2 : 1,
    })
  },
  /** 让她写「我为什么喜欢 / 想对作者说的话」（短文案，关思考）。 */
  biliCompose(payload) {
    return ipcRenderer.invoke('orb:bili-compose', {
      bvid: String(payload?.bvid ?? ''),
      cid: Number(payload?.cid) || 0,
    })
  },
  /**
   * 补写这条视频的「概览」（她看完之后自己写的一句「这视频大概讲了什么」）。
   * `force:true` = 已有也重写（用户点了「让她重写」）。
   */
  biliSummary(payload) {
    return ipcRenderer.invoke('orb:bili-summary', {
      bvid: String(payload?.bvid ?? ''),
      cid: Number(payload?.cid) || 0,
      force: payload?.force === true,
    })
  },
  biliNoteSave(payload) {
    return ipcRenderer.invoke('orb:bili-note-save', {
      bvid: String(payload?.bvid ?? ''),
      cid: Number(payload?.cid) || 0,
      reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
      comment: typeof payload?.comment === 'string' ? payload.comment : undefined,
    })
  },
  /** ★ 公开发言：评论会署用户的账号出现在评论区。只能在用户点「发送」时调用。 */
  biliCommentSend(payload) {
    return ipcRenderer.invoke('orb:bili-comment-send', {
      bvid: String(payload?.bvid ?? ''),
      cid: Number(payload?.cid) || 0,
      text: String(payload?.text ?? ''),
    })
  },
  /**
   * 主题与背景（用户 m02033）。
   * 主题真源是主进程的 `nativeTheme.themeSource`（改了所有窗口一起翻），
   * 背景图真源是 `helper/assets/backgrounds/` + `logs/window-state.json`。
   * 渲染层只发意图、只收快照。
   */
  themeGet() {
    return ipcRenderer.invoke('orb:theme-get')
  },
  themeSet(mode) {
    return ipcRenderer.invoke('orb:theme-set', String(mode ?? 'auto'))
  },
  onTheme(callback) {
    ipcRenderer.on('orb:theme', (_event, payload) => callback(payload ?? null))
  },
  backgroundsGet() {
    return ipcRenderer.invoke('orb:bg-get')
  },
  backgroundsImport(slot) {
    return ipcRenderer.invoke('orb:bg-import', String(slot ?? ''))
  },
  backgroundsClear(slot) {
    return ipcRenderer.invoke('orb:bg-clear', String(slot ?? ''))
  },
  backgroundsUpdate(patch) {
    return ipcRenderer.invoke('orb:bg-update', {
      slot: String(patch?.slot ?? ''),
      fit: typeof patch?.fit === 'string' ? patch.fit : undefined,
      scrim: patch?.scrim === undefined ? undefined : Number(patch.scrim),
    })
  },
  openBackgroundsFolder() {
    ipcRenderer.send('orb:bg-open-folder')
  },
  onBackgrounds(callback) {
    ipcRenderer.on('orb:backgrounds', (_event, payload) => callback(payload ?? null))
  },
  /**
   * 环形菜单（独立窗口）：打开/关闭/点击回传。
   * x, y 是球心在**球窗口视口内**的坐标（`getBoundingClientRect` 那一套），
   * 不是屏幕坐标 —— 主进程负责加上窗口位置，再夹进显示器工作区。
   * items 是菜单项清单 `[{ id, label }]`，源头只有 shell.js 的 `ringItems()` 一处。
   */
  ringOpen(x, y, items) {
    ipcRenderer.send(
      'orb:ring-open',
      Number(x) || 0,
      Number(y) || 0,
      Array.isArray(items) ? items.map((item) => ({ id: String(item?.id ?? ''), label: String(item?.label ?? '') })) : [],
    )
  },
  ringClose() {
    ipcRenderer.send('orb:ring-close')
  },
  onRingAction(callback) {
    ipcRenderer.on('orb:ring-action', (_event, id) => callback(String(id ?? '')))
  },
  /**
   * 环菜单开/关状态广播（主进程发）。
   * 菜单也会因为「光标离开环带」自己关掉，只靠渲染层记账必然漂移，
   * 而左右键互斥判断（用户 m00827 §2）依赖这个状态准不准。
   */
  onRingState(callback) {
    ipcRenderer.on('orb:ring-state', (_event, open) => callback(open === true))
  },
  /**
   * 隐藏悬浮球（2026-10-08 用户要求「加一个隐藏球体」）。
   *
   * ★ 为什么单独开一条信道而不是复用某个现成的 invoke：
   *   隐藏是**主进程的状态**（窗口 hide + 穿透收口 + 关环菜单），球侧没有任何
   *   需要参与的逻辑。开一条单向 send 最贴切 —— 球侧发完就完了，不等待结果。
   *   反向的「显示」不需要球侧发起：球已经藏了，它自己发不出消息，
   *   只能从托盘/原生菜单那条路回来（那两条都在主进程里）。
   */
  hideBall() {
    ipcRenderer.send('orb:ball-hide')
  },
  /** 面板毛玻璃透明度（环形菜单外侧圆环拖动 → 主进程落盘 → 这里推回渲染层）。 */
  onPanelOpacity(callback) {
    ipcRenderer.on('orb:panel-opacity', (_event, value) => callback(Number(value)))
  },
  openExternal(url) {
    ipcRenderer.send('orb:open-external', url)
  },
  tccStatus() {
    return ipcRenderer.invoke('orb:tcc-status')
  },
  openTcc(right) {
    return ipcRenderer.invoke('orb:tcc-open', right)
  },
  onBlock(callback) {
    ipcRenderer.on('orb:block', (_event, block) => callback(block))
  },
  onBlockDrop(callback) {
    ipcRenderer.on('orb:block-drop', (_event, key) => callback(key))
  },
  /**
   * 历史回放里的「图片 ×N」占位被点开 → 向 host 要那一张原图（P2-4 补）。
   *
   * ⚠️ 只传**块 key**（`<convId>|u:ui-msg-N`），不传文件路径：host 自己按 key
   *    去会话目录里取。渲染层因此拿不到任意读文件的权力。
   */
  requestImages(key) {
    ipcRenderer.send('orb:image-request', String(key ?? ''))
  },
  /** 原图下行：`{ key, images:[{mimeType,dataURL}], skipped }`。 */
  onImages(callback) {
    ipcRenderer.on('orb:image-data', (_event, payload) => callback(payload))
  },
  onTurn(callback) {
    ipcRenderer.on('orb:turn', (_event, turn) => callback(turn))
  },
  onStatus(callback) {
    ipcRenderer.on('orb:status', (_event, text) => callback(text))
  },
  onSession(callback) {
    ipcRenderer.on('orb:session', (_event, sessionId) => callback(sessionId))
  },
  onQuestion(callback) {
    ipcRenderer.on('orb:question', (_event, question) => callback(question))
  },
  onQuestionClear(callback) {
    ipcRenderer.on('orb:question-clear', (_event, id) => callback(id))
  },
  onQuestionError(callback) {
    ipcRenderer.on('orb:question-error', (_event, payload) => callback(payload))
  },
  onHistory(callback) {
    ipcRenderer.on('orb:history', (_event, items) => callback(items))
  },
  /**
   * 记忆中心（P0-7「我们的回忆」）下行。
   *
   * host 的五类消息（impression / impression-history / impression-at /
   * impression-result / memory:archive-result）**合并成一个回调**，
   * 球侧靠 `payload.type` 分派。
   *
   * 为什么不拆成五个 `on*`：那是同一条 socket 通道上的同一个方向，
   * 拆开只会让 preload 和球侧都多出五份几乎一样的样板。
   * 上行仍然是一个 `impression(payload)` —— 由主进程按 action 分发。
   */
  onImpression(callback) {
    ipcRenderer.on('orb:impression', (_event, payload) => callback(payload))
  },
  /** 记忆中心上行：action ∈ get / refresh / history-get / at-get / schedule / archive-now。 */
  impression(payload) {
    ipcRenderer.send('orb:impression', payload ?? {})
  },
  /**
   * 对话级操作（重命名/删除/锁定）的结果回执。
   *
   * ⚠️ host 从一开始就在发这条（`src/main.mjs` 的 `conversation-action-result`），
   * 但 preload 一直没暴露它→ 球侧收不到，失败时**完全静默**：
   * 用户点了没反应，又看不到任何提示，只能以为功能坏了。
   * 这就是「改名无法生效」难查的原因之一 ——
   * 真实故障（blur 抢跑）在球侧，主机根本没收到请求，日志里当然一片空白。
   */
  onConversationAction(callback) {
    ipcRenderer.on('orb:conversation-action-result', (_event, result) => callback(result))
  },
  onPermission(callback) {
    ipcRenderer.on('orb:permission', (_event, preset) => callback(preset))
  },
  /**
   * 对话隐私锁（对话加密_落地方案.md）—— 锁定态变更下行。
   *
   * payload: `{ state:'locked'|'unlocked', kind:'soft'|'strong',
   *             convId, attemptsLeft, hasAgreement }`
   *
   * ⚠️ 这条**必须单独暴露**，不能并进 `onConversationAction`：
   *    后者只在用户主动点菜单后回一次包，而锁是**host 主动推**的
   *    （超时锁到点自己就推一条，用户什么都没点）——
   *    唯一的「进锁」入口如果是「某个动作的回执」，超时锁就永远收不到。
   */
  onLock(callback) {
    ipcRenderer.on('orb:lock', (_event, payload) => callback(payload))
  },
  /** 解锁尝试的结果：对不对、还剩几轮、鲸鱼娘说什么。 */
  onLockFeedback(callback) {
    ipcRenderer.on('orb:lock-feedback', (_event, payload) => callback(payload))
  },
  /** 「有没有暗号」的状态标记（用户可在对话里取消暗号，方案 §4.4）。 */
  onSoftAgreement(callback) {
    ipcRenderer.on('orb:soft-agreement', (_event, payload) => callback(payload))
  },
  /**
   * 交出一次解锁尝试（暗号**或**密码原文）。
   *
   * ⚠️ `input` 是敏感原文：只走内存、交给 host 比对，
   *    球侧不存、不写 localStorage、不拼进任何日志。
   */
  unlock(input, convId) {
    ipcRenderer.send('orb:lock-action', { kind: 'unlock', input: String(input ?? ''), convId: convId ?? '' })
  },
  /** 手动上锁（软锁，立刻遮罩全部历史）。 */
  lockNow() {
    ipcRenderer.send('orb:lock-action', { kind: 'lock-now' })
  },
  /**
   * 情绪 GIF 装饰层（P1-5）下行。
   *
   * payload: `{ mood, src, opacity, speed }` —— `src` 已由主进程过
   * `PRESET_SRC` 校验（相对 assets/ 的 GIF 路径，不是 URL、不能带 `..`），
   * 渲染层可以直接塞进 `<img>.src`。
   *
   * ⚠️ 用的是**专用类型 `deco` 而不是 `avatar`** —— `avatar` 在球侧落到
   * `#ball-gif`（球的脸 + 拖窗口把手），挂情绪等于「她一开口就把球脸换掉」，
   * 还会踩「球的视觉不许改」这条铁律。两者是不同图层，别混。
   */
  onDeco(callback) {
    ipcRenderer.on('orb:deco', (_event, payload) => callback(payload))
  },
  onReset(callback) {
    ipcRenderer.on('orb:reset', () => callback())
  },
  onAvatar(callback) {
    ipcRenderer.on('orb:avatar', (_event, src) => callback(src))
  },
  onAttach(callback) {
    ipcRenderer.on('orb:attach', (_event, text) => callback(text))
  },
  onAppearance(callback) {
    ipcRenderer.on('orb:appearance', (_event, appearance) => callback(appearance))
  },
})
