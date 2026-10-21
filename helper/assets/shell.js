import { renderMarkdown } from './markdown.js'
import {
  processLabel, reasoningSummary, processTitle, toolTitle, toolLabels, classifyTool, deriveSummary,
  formatToolBody, terminalCardModel, terminalFailed, readCardModel,
  searchCardModel, webCardModel, diffCardModel, diffTotals, diffLines,
  usageLabels, tokenUsageTotal, formatTokenCount,
} from './transcript-model.js'
import { upgradeCodeBlocks } from './highlight.js'
import { createContextMenu } from './context-menu.js'
import { createResizeHandles } from './resize-handles.js'
import { createImpressionPanel } from './impression-panel.js'
import { createApiConfigPanel } from './api-config.js'
import { createThemePanel } from './theme-panel.js'
import { createBiliHistoryPanel } from './bili-history-panel.js'
import { createBackgrounds } from './backgrounds.js'
import {
  icon, THINK, CHEVRON_DOWN, CHEVRON_UP, SEARCH, GLOBE, BROWSE, EDIT, CODE, API, SPARKLE, COPY, CHECK, COMPACT, stateSpinner,
} from './icons.js'
import {
  MAX_ATTACHMENTS, isImageFile, pickImageFiles, prepareAttachment, formatBytes,
} from './image-attach.js'

const api = window.dshOrb
const COLLAPSE_MS = 180
const ANIMATION_MS = 300
const DOCK_HOVER_DELAY_MS = 800
const DOCK_DRAG_OFF_PX = 24
const COMPOSER_MIN_PX = 72
const COMPOSER_LINE_PX = 20
const COMPOSER_MAX_PX = COMPOSER_MIN_PX + COMPOSER_LINE_PX * 3
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access']

const zh = {
  title: '桌面 agent',
  stop: '停止',
  fresh: '新建',
  history: '历史',
  historyEmpty: '还没有 Computer Use 对话。',
  untitled: '未命名对话',
  menuAppearance: '更换显示样式（头像）',
  menuHistory: '历史对话',
  menuImpression: '我们的回忆',
  menuLegacyWeb: '打开旧后端界面',
  // 环菜单专用：把球藏起来（用户 2026-10-08「需要加一个隐藏球体」）。
  // 只藏在环菜单里 —— 藏起来之后想回来，走托盘那项（球已经没了，它自己发不出消息）。
  menuHideBall: '隐藏悬浮球',
  menuApiConfig: '设置',
  menuTheme: '主题',
  // 「看过的视频」：取代环菜单里那个早已跑不通的「打开旧后端界面」。
  menuBiliHistory: '看过的视频',
  biliHistoryClose: '关闭',
  biliHistoryEmpty: '还没在 B 站看过视频。把链接发给她，她看完就会记在这里。',
  biliHistoryRefresh: '刷新',
  biliHistoryClear: '清空记录',
  biliHistoryClearConfirm: '清空她的 B 站浏览记录？只删本地这份账本，B 站那边的历史不受影响。',
  // 顶部大标题与「共 N 条…」那行已在 2026-10-21 深夜按用户意见删掉：
  // 「我喜欢的」「我看过的」两个板块标题改用原来那个大标题的格式。
  biliHistoryInfoOnly: '只看了元信息，没取画面',
  biliSummaryEmpty: '（还没写概览）',
  // ── 上下两块（2026-10-21 重排）──
  biliLikedTitle: '我喜欢的',
  biliWatchedTitle: '我看过的',
  biliLikedEmpty: '还没有喜欢的。看见喜欢的就点个赞，它会挪到这儿。',
  biliWatchedEmpty: '还没在 B 站看过视频。把链接发给她，她看完就会记在这里。',
  biliMoreOlder: '更早的 {n} 条',
  biliLikedHint: '点开看她为什么喜欢',
  // ── 每条下面的动作（真的会发 B 站接口）──
  biliActLike: '赞',
  biliActLiked: '已赞',
  biliActCoin: '投币',
  biliActCoined: '已投',
  biliActFav: '收藏',
  biliActFaved: '已藏',
  biliActFailed: '这个动作没成功',
  // ── 二级面板：概览 / 我喜欢的理由 / 想对作者说的话 ──
  biliNoteSummaryLabel: '这段视频讲了什么',
  biliNoteSummaryWrite: '让她写概览',
  biliNoteSummaryRewrite: '重写概览',
  biliNoteSummaryComposing: '她在写概览…',
  biliNoteSummaryDone: '概览写好了',
  biliNoteSummaryFailed: '她没写出来',
  biliNoteOpenBili: '在 B 站看原片',
  biliNoteReasonLabel: '我喜欢的理由',
  biliNoteCommentLabel: '我想对视频作者说的话',
  biliNoteSend: '发送',
  biliNoteSent: '已发送',
  biliNoteRegen: '让她重写',
  biliNoteCancel: '返回',
  biliNoteSending: '正在发送…',
  biliNoteSendConfirm: '把这段话发到 B 站评论区？会用你的账号署名，发出去就删不掉了。',
  biliNoteSendFailed: '没发出去',
  biliNoteComposing: '她正在想为什么喜欢…',
  biliNoteComposeFailed: '她想不出来，待会儿再试',
  biliNoteEmpty: '（她还没写）',
  biliNoteEmptyComment: '先说点什么吧',
  themeTitle: '主题',
  themeClose: '关闭',
  themeMode: '外观',
  themeModeAuto: '跟随系统',
  themeModeLight: '浅色',
  themeModeDark: '深色',
  themeBg: '页面背景',
  themeBgHint: '三个页面各一张图；窗口拉伸不会让图片变形（铺满=裁掉多余边缘，完整=留边，原比例=不缩放）。',
  themeSlotChat: '对话页',
  themeSlotHistory: '历史对话',
  themeSlotRecall: '我们的回忆',
  themeNoImage: '未设置',
  themeImport: '导入图片',
  themeClear: '清除',
  themeFitLabel: '适配方式',
  themeFitCover: '铺满',
  themeFitContain: '完整',
  themeFitAuto: '原比例',
  themeScrim: '蒙层浓度',
  themeOpenFolder: '打开图片文件夹',
  themeLoading: '读取中…',
  themeLoadFailed: '读取失败：',
  themeBusy: '处理中…',
  themeImported: '已导入。',
  themeCleared: '已清除。',
  themeFailed: '失败：',
  apiNoEndpoint: '还没连上本机宿主，稍等一下再打开。',
  apiTitle: '设置',
  apiGroupModel: '模型与密钥',
  apiProvider: '服务商',
  apiModel: '模型',
  apiBaseUrl: '接口地址',
  apiKey: 'API Key',
  apiPaths: '写入位置',
  apiSave: '保存',
  apiReload: '重新读取',
  apiClose: '关闭',
  apiShowKey: '显示',
  apiHideKey: '隐藏',
  apiLoading: '读取中…',
  apiLoadFailed: '读取失败：',
  apiSaving: '保存中…',
  apiSaved: '已保存。',
  apiSaveFailed: '保存失败：',
  apiNoChange: '没有改动。',
  apiEffectiveNote: '模型、密钥、压缩阈值存完下一轮就生效，不用重启；微信改完会立刻重启桥。',
  apiOff: '关',
  apiOn: '开',
  apiContextLimit: '压缩阈值（token）',
  apiContextLimitHint: '留空 = 出厂 24 000',
  // 思考（推理）档位。写 config.json 的 reasoningEffort，llm.mjs 每轮从 settings 读 ⇒ 下一轮生效。
  apiReasoningEffort: '推理等级（思考）',
  apiReasoningEffortHint: '默认 max：想得最久。关掉思考选「关」。',
  apiEffortOff: '关（不思考）',
  apiEffortMinimal: '最低',
  apiEffortLow: '低',
  apiEffortMedium: '中',
  apiEffortHigh: '高（High，同 DSH 缺省）',
  apiEffortXhigh: '很高',
  apiEffortUltra: '极高',
  apiEffortMax: '最高（max，缺省）',
  apiGroupWechat: '微信',
  apiWechatEnabled: '微信桥',
  apiWechatToken: '微信 bot token',
  apiWechatBaseUrl: '微信接口地址',
  // ── B 站扫码登录（2026-10-21）──
  apiGroupBili: 'B 站',
  apiBiliLogin: '扫码登录',
  apiBiliRelogin: '重新扫码',
  apiBiliLogout: '退出登录',
  apiBiliNotLoggedIn: '未登录（没有登录态时，取帧只能拿到 480P）',
  apiBiliStarting: '正在获取二维码…',
  apiBiliWaitScan: '用 B 站手机客户端扫码',
  apiBiliScanned: '已扫码，请在手机上点确认',
  apiBiliConfirmed: '已登录，取帧可拿原生分辨率',
  apiBiliExpired: '二维码已过期，点「扫码登录」重来',
  apiBiliFailed: '扫码失败：',
  apiBiliExpires: '有效期至',
  apiBiliUnknownUser: '（B 站账号）',
  menuRename: '重命名',
  menuRenamePrompt: '给这段对话起个新名字',
  menuDelete: '删除',
  menuLock: '锁定这段对话',
  menuUnlock: '解锁',
  // ── 对话隐私锁（对话加密_落地方案.md §4.3 / §5）──────────────────
  lockTitleSoft: '离开太久，先对个暗号',
  lockTitleStrong: '这段对话锁着，输密码才能开',
  lockEyebrowSoft: '隐私锁',
  lockEyebrowStrong: '强锁',
  lockPlaceholderSoft: '我们约好的那个词…',
  lockPlaceholderStrong: '输入密码',
  lockSubmit: '解锁',
  lockClose: '关闭',
  lockRowLabel: '已锁定的对话',
  lockDetailSoft: '你有一阵子没回来了，所以我先把历史盖上了 —— 免得谁路过都看得到。',
  lockDetailStrong: '这段对话挂了强锁，得先过一道密码。',
  lockDetailNoAgreement: '这段历史被遮住了，但咱们还没约过暗号，所以暂时没有能对的词。',
  lockHintAgreement: '连续 5 次没对上，我会自己给你解开 —— 但会念你一句。',
  lockHintStrong: '输错 5 次会冷却 15 分钟。密码忘了可以走下面的「导出对话」自救。',
  lockHintNoAgreement: '想以后能锁能解，跟我说一句「我们约个暗号」就行。',
  lockAttemptsLeft: (n) => `还剩 ${n} 次机会`,
  lockExport: '导出这段对话（忘记密码时的出路）',
  lockExportDone: '已导出到工作区。',
  lockExportFailed: '导出失败：',
  // 强锁「第一次设密码」卡（方案 §5 的知情告知，只讲一次）
  lockSetupTitle: '给强锁定个密码',
  lockSetupDetail: '这段对话还没设过强锁密码。定一个吧 —— 定了我就把它锁上。',
  lockSetupPlaceholder: '新密码（记牢，忘了要走导出）',
  lockSetupSubmit: '定好并上锁',
  lockSetupHint: '强锁防的是偷看屏幕的人，挡不住铁了心翻文件的人。',
  lockSetupWarn: '密码忘了，UI 上就进不去这段对话了 —— 但内容还在磁盘上，可以用「导出对话」自救。这句话只说这一次。',
  lockSetupSaving: '正在记下…',
  lockSetFailed: '没能设成：',
  lockNeedPassword: '要先给强锁定个密码，再回来上锁 —— 否则这把锁没有钥匙，你自己也进不去。',
  menuDeleteConfirm: (title) => `删除「${title}」？该会话的消息将被永久删除，不可恢复。`,
  unknownError: '未知错误',
  placeholder: '向桌面 agent 发送消息…',
  accessReadOnly: '仅可查看',
  accessWrite: '工作区内修改',
  accessFull: '完全权限',
  cancel: '放弃',
  skip: '跳过',
  next: '下一题',
  submit: '提交',
  prev: '上一题',
  recommended: '推荐',
  custom: '输入你的答案',
  incomplete: '请先完成这道问题。',
  unanswered: '请选择一个选项或填写自定义答案。',
  think: '思考',
  running: '运行中',
  stopped: '已停止',
  failed: '失败',
  tooLong: '最多 8000 个字符，已保留输入。',
  truncated: '已截断',
  chipDismiss: '移除',
  tccTitle: '使用桌面 agent 需要两项 Mac 权限',
  tccAppHint: '在列表里打开 {name}。',
  tccScreenName: '屏幕录制',
  tccScreenReason: '让 agent 看见当前窗口。',
  tccScreenPath: '系统设置 → 隐私与安全性 → 屏幕录制',
  tccScreenOpen: '打开「屏幕录制」设置',
  tccAccessibilityName: '辅助功能',
  tccAccessibilityReason: '让 agent 点击和输入。',
  tccAccessibilityPath: '系统设置 → 隐私与安全性 → 辅助功能',
  tccAccessibilityOpen: '打开「辅助功能」设置',
  tccStatusMissing: '未开启',
  tccStatusGranted: '已开启',
  tccStatusNeedsRelaunch: '已开启，请退出后重开',
  tccFooter: '打开开关后，请完全退出 {name} 再打开。只关主窗口无效。插件不能替你重启官方应用。',
  tccLater: '稍后',
  tccDismiss: '关闭',
  // ── 记忆中心（P0-7「我们的回忆」）──────────────────────────────────
  // 词条名去掉 impression 前缀：面板模块内部直接用 `t('impressionTitle')`。
  impressionTitle: '她眼中的你',
  impressionClose: '关闭',
  impressionLoading: '正在读…',
  impressionMissing: '还没有印象文件。点下面的「现在重新总结一次」，她会自己写一份。',
  impressionEmpty: '印象文件已建好、内容还是空的。点「现在重新总结一次」让她写第一份。',
  impressionUpdated: '最后更新于',
  impressionNext: '下次约在',
  impressionOff: '已关闭自动总结',
  impressionStale: '这一版她自己也还没看到 —— 归档后会进她的上下文。',
  impressionRefresh: '现在重新总结一次',
  impressionRefreshing: '已触发，等她写完…',
  impressionRefreshDisabled: '先在上面把频率打开',
  impressionTriggered: '已触发。她这轮不用你管，写完会自动刷新。',
  impressionFailed: '没能完成：',
  impressionSchedule: '总结频率',
  impressionHistory: '历史版本',
  impressionHistoryEmpty: '还没有历史版本。',
  impressionHistoryFailed: '读不到历史：',
  impressionVersion: '这一版',
  impressionVersionLoading: '正在读…',
  impressionVersionFailed: '读不到这一版：',
  impressionBack: '收起',
}
const en = {
  title: 'Desktop agent',
  stop: 'Stop',
  fresh: 'New',
  history: 'History',
  historyEmpty: 'No Computer Use chats yet.',
  untitled: 'Untitled',
  menuAppearance: 'Change appearance (avatar)',
  menuHistory: 'Conversation history',
  menuImpression: 'Our memories',
  menuLegacyWeb: 'Open legacy web UI',
  menuHideBall: 'Hide floating ball',
  menuApiConfig: 'Settings',
  menuTheme: 'Theme',
  menuBiliHistory: 'Videos she watched',
  biliHistoryClose: 'Close',
  biliHistoryEmpty: 'She has not watched anything on Bilibili yet. Send her a link and it will show up here.',
  biliHistoryRefresh: 'Refresh',
  biliHistoryClear: 'Clear',
  biliHistoryClearConfirm: 'Clear her Bilibili watch log? This only deletes the local log; your Bilibili history is untouched.',
  // The top title and the "N videos" line were removed (user, 2026-10-21):
  // the two block titles now use the former title's format.
  biliHistoryInfoOnly: 'metadata only, no frames',
  biliSummaryEmpty: '(no summary yet)',
  biliLikedTitle: 'Ones I liked',
  biliWatchedTitle: 'Ones I watched',
  biliLikedEmpty: 'Nothing liked yet. Hit the like button under a video and it moves up here.',
  biliWatchedEmpty: 'She has not watched anything on Bilibili yet. Send her a link and it will show up here.',
  biliMoreOlder: '{n} earlier',
  biliLikedHint: 'tap to see why she liked it',
  biliActLike: 'Like',
  biliActLiked: 'Liked',
  biliActCoin: 'Coin',
  biliActCoined: 'Coined',
  biliActFav: 'Save',
  biliActFaved: 'Saved',
  biliActFailed: 'That did not go through',
  biliNoteReasonLabel: 'Why I liked it',
  biliNoteCommentLabel: 'What I want to say to the creator',
  // ── 二级面板：概览 / 喜欢的理由 / 想对作者说的话 ──
  biliNoteSummaryLabel: 'What this video is about',
  biliNoteSummaryWrite: 'Have her write a summary',
  biliNoteSummaryRewrite: 'Rewrite summary',
  biliNoteSummaryComposing: 'She is writing the summary…',
  biliNoteSummaryDone: 'Summary written',
  biliNoteSummaryFailed: 'She could not write it',
  biliNoteOpenBili: 'Open on Bilibili',
  biliNoteSend: 'Send',
  biliNoteSent: 'Sent',
  biliNoteRegen: 'Rewrite',
  biliNoteCancel: 'Back',
  biliNoteSending: 'Sending…',
  biliNoteSendConfirm: 'Post this to the Bilibili comment section? It will carry your account name and cannot be deleted from here.',
  biliNoteSendFailed: 'Could not send',
  biliNoteComposing: 'She is thinking about why she liked it…',
  biliNoteComposeFailed: 'She could not come up with anything, try again later',
  biliNoteEmpty: '(nothing written yet)',
  biliNoteEmptyComment: 'Say something first',
  themeTitle: 'Theme',
  themeClose: 'Close',
  themeMode: 'Appearance',
  themeModeAuto: 'System',
  themeModeLight: 'Light',
  themeModeDark: 'Dark',
  themeBg: 'Page backgrounds',
  themeBgHint: 'One image per page. Resizing the window never distorts the picture (Cover crops the excess, Contain keeps a margin, Original never scales).',
  themeSlotChat: 'Chat',
  themeSlotHistory: 'History',
  themeSlotRecall: 'Our memories',
  themeNoImage: 'Not set',
  themeImport: 'Import image',
  themeClear: 'Clear',
  themeFitLabel: 'Fit',
  themeFitCover: 'Cover',
  themeFitContain: 'Contain',
  themeFitAuto: 'Original',
  themeScrim: 'Scrim',
  themeOpenFolder: 'Open image folder',
  themeLoading: 'Loading…',
  themeLoadFailed: 'Load failed: ',
  themeBusy: 'Working…',
  themeImported: 'Imported.',
  themeCleared: 'Cleared.',
  themeFailed: 'Failed: ',
  apiNoEndpoint: 'Not connected to the local host yet — try again in a moment.',
  apiTitle: 'Settings',
  apiGroupModel: 'Model & key',
  apiProvider: 'Provider',
  apiModel: 'Model',
  apiBaseUrl: 'Base URL',
  apiKey: 'API key',
  apiPaths: 'Files written',
  apiSave: 'Save',
  apiReload: 'Reload',
  apiClose: 'Close',
  apiShowKey: 'Show',
  apiHideKey: 'Hide',
  apiLoading: 'Loading…',
  apiLoadFailed: 'Load failed: ',
  apiSaving: 'Saving…',
  apiSaved: 'Saved.',
  apiSaveFailed: 'Save failed: ',
  apiNoChange: 'Nothing changed.',
  apiEffectiveNote: 'Model, key and compaction budget apply on the next turn — no restart. The WeChat change restarts the bridge right away.',
  apiOff: 'Off',
  apiOn: 'On',
  apiContextLimit: 'Compaction budget (tokens)',
  apiContextLimitHint: 'Empty = factory default 24 000',
  apiReasoningEffort: 'Reasoning effort (thinking)',
  apiReasoningEffortHint: 'Default max. Pick "Off" to disable thinking.',
  apiEffortOff: 'Off (no thinking)',
  apiEffortMinimal: 'Minimal',
  apiEffortLow: 'Low',
  apiEffortMedium: 'Medium',
  apiEffortHigh: 'High (DSH default)',
  apiEffortXhigh: 'Extra high',
  apiEffortUltra: 'Ultra',
  apiEffortMax: 'Max (default)',
  apiGroupWechat: 'WeChat',
  apiWechatEnabled: 'Bridge',
  apiWechatToken: 'WeChat bot token',
  apiWechatBaseUrl: 'WeChat API base URL',
  // ── Bilibili QR login (2026-10-21) ──
  apiGroupBili: 'Bilibili',
  apiBiliLogin: 'Sign in with QR',
  apiBiliRelogin: 'Scan again',
  apiBiliLogout: 'Sign out',
  apiBiliNotLoggedIn: 'Not signed in (frames fall back to 480p)',
  apiBiliStarting: 'Requesting a QR code…',
  apiBiliWaitScan: 'Scan with the Bilibili mobile app',
  apiBiliScanned: 'Scanned — confirm on your phone',
  apiBiliConfirmed: 'Signed in — native-resolution frames available',
  apiBiliExpired: 'QR code expired — tap “Sign in with QR” again',
  apiBiliFailed: 'Sign-in failed: ',
  apiBiliExpires: 'valid until',
  apiBiliUnknownUser: '(Bilibili account)',
  menuRename: 'Rename',
  menuRenamePrompt: 'Give this chat a new name',
  menuDelete: 'Delete',
  menuLock: 'Lock this chat',
  menuUnlock: 'Unlock',
  // ── Privacy lock ──────────────────────────────────────────────────
  lockTitleSoft: 'Away for a while — say the word first',
  lockTitleStrong: 'This chat is locked — password to open',
  lockEyebrowSoft: 'Privacy lock',
  lockEyebrowStrong: 'Strong lock',
  lockPlaceholderSoft: 'The word we agreed on…',
  lockPlaceholderStrong: 'Enter password',
  lockSubmit: 'Unlock',
  lockClose: 'Close',
  lockRowLabel: 'Locked conversation',
  lockDetailSoft: 'You were gone a while, so I covered the history — in case someone wandered by.',
  lockDetailStrong: 'This chat is strongly locked. It needs a password.',
  lockDetailNoAgreement: 'This history is covered, but we never agreed on a word — so there is nothing to match against yet.',
  lockHintAgreement: 'Miss 5 times and I will let you in myself — with a word of reproach.',
  lockHintStrong: 'Five wrong tries triggers a 15-minute cooldown. Forgot it? Use “Export this chat” below to rescue it.',
  lockHintNoAgreement: 'Say “let us agree on a word” if you want lock-and-unlock later.',
  lockAttemptsLeft: (n) => `${n} ${n === 1 ? 'try' : 'tries'} left`,
  lockExport: 'Export this chat (the way out if you forgot the password)',
  lockExportDone: 'Exported to the workspace.',
  lockExportFailed: 'Export failed: ',
  lockSetupTitle: 'Set a password for the strong lock',
  lockSetupDetail: 'This chat has no strong-lock password yet. Set one and I will lock it.',
  lockSetupPlaceholder: 'New password (remember it — forgetting means the export route)',
  lockSetupSubmit: 'Set and lock',
  lockSetupHint: 'A strong lock stops people glancing at your screen — not someone determined to dig through files.',
  lockSetupWarn: 'If you forget it, the UI cannot open this chat any more — but the content stays on disk and “Export this chat” can rescue it. Said once, and once only.',
  lockSetupSaving: 'Noting it down…',
  lockSetFailed: 'Could not set it: ',
  lockNeedPassword: 'Set a strong-lock password first, then come back to lock — otherwise the lock has no key and you cannot get in either.',
  menuDeleteConfirm: (title) => `Delete “${title}”? Its messages will be permanently removed. This cannot be undone.`,
  unknownError: 'Unknown error',
  placeholder: 'Ask the desktop agent…',
  accessReadOnly: 'Read Only',
  accessWrite: 'Workspace Write',
  accessFull: 'Full access',
  cancel: 'Dismiss',
  skip: 'Skip',
  next: 'Next',
  submit: 'Submit',
  prev: 'Previous question',
  recommended: 'Recommended',
  custom: 'Type your answer',
  incomplete: 'Please complete this question first.',
  unanswered: 'Please select an option or enter a custom answer.',
  think: 'Think',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  tooLong: 'Limit is 8000 characters. The text was kept.',
  truncated: 'truncated',
  chipDismiss: 'Remove',
  tccTitle: 'Desktop agent needs two Mac permissions',
  tccAppHint: 'In the list, turn on {name}.',
  tccScreenName: 'Screen Recording',
  tccScreenReason: 'Lets the agent see the current window.',
  tccScreenPath: 'System Settings → Privacy & Security → Screen Recording',
  tccScreenOpen: 'Open Screen Recording settings',
  tccAccessibilityName: 'Accessibility',
  tccAccessibilityReason: 'Lets the agent click and type.',
  tccAccessibilityPath: 'System Settings → Privacy & Security → Accessibility',
  tccAccessibilityOpen: 'Open Accessibility settings',
  tccStatusMissing: 'Off',
  tccStatusGranted: 'On',
  tccStatusNeedsRelaunch: 'On — quit and reopen',
  tccFooter: 'After the switches are on, quit {name} completely and open it again. Closing the main window does not quit. This plugin cannot restart the official app.',
  tccLater: 'Later',
  tccDismiss: 'Dismiss',
  impressionTitle: 'How she sees you',
  impressionClose: 'Close',
  impressionLoading: 'Loading…',
  impressionMissing: 'No impression file yet. Hit “Summarise again” below and she will write one.',
  impressionEmpty: 'The file is there but still empty. Hit “Summarise again” to write the first one.',
  impressionUpdated: 'Last updated',
  impressionNext: 'Next around',
  impressionOff: 'Automatic summaries are off',
  impressionStale: 'She has not seen this version yet — archiving puts it into her context.',
  impressionRefresh: 'Summarise again now',
  impressionRefreshing: 'Triggered, waiting for her…',
  impressionRefreshDisabled: 'Turn the frequency back on first',
  impressionTriggered: 'Triggered. She handles this round herself; it refreshes when she is done.',
  impressionFailed: 'Could not finish: ',
  impressionSchedule: 'Frequency',
  impressionHistory: 'Past versions',
  impressionHistoryEmpty: 'No past versions yet.',
  impressionHistoryFailed: 'Could not read history: ',
  impressionVersion: 'Version',
  impressionVersionLoading: 'Loading…',
  impressionVersionFailed: 'Could not read this version: ',
  impressionBack: 'Collapse',
}

const PROMPT_LIMIT = 8000
// The UI language mirrors the main window's, delivered on the appearance
// message; until it arrives the page follows the system like the web client.
let messages = (navigator.language || '').toLowerCase().startsWith('zh') ? zh : en
let chatLabels = toolLabels(messages === zh)
let usageText = usageLabels(messages === zh)

/** Switch the page dictionary; refreshers re-render from the new one. */
function applyLocale(locale) {
  if (locale !== 'zh' && locale !== 'en') return
  const next = locale === 'zh' ? zh : en
  if (next === messages) return
  messages = next
  chatLabels = toolLabels(messages === zh)
  usageText = usageLabels(messages === zh)
  document.documentElement.lang = locale
}

function applyColorScheme(dark) {
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  // Theme sheets key dark overrides on body[data-ds-dark-theme], as in Harness.
  document.body.toggleAttribute('data-ds-dark-theme', dark)
}

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
applyColorScheme(colorScheme.matches)
colorScheme.addEventListener('change', () => applyColorScheme(colorScheme.matches))

function promptText(prompt) {
  return (prompt.innerText ?? prompt.textContent ?? '').replaceAll('\u00a0', ' ')
}

function composeSend(instruction, selection) {
  if (selection === '') return instruction
  const joiner = '\n\n'
  const room = PROMPT_LIMIT - instruction.length - joiner.length
  if (room <= 0) return instruction
  const mark = `\n${messages.truncated}`
  let body = selection
  if (body.length > room) {
    const kept = Math.max(0, room - mark.length)
    body = kept === 0 ? mark.slice(0, room) : `${selection.slice(0, kept)}${mark}`
  }
  return `${instruction}${joiner}${body}`
}

function insertPlainText(prompt, text) {
  if (text === '') return
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return
  prompt.append(text)
}

function editableTarget(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement
  if (element == null || typeof element.closest !== 'function') return false
  return element.closest('input, textarea, [contenteditable="true"]') !== null
}

function isComposing(event) {
  return event.isComposing === true || event.keyCode === 229
}

function parseRecommendedLabel(label) {
  return RECOMMENDED_SUFFIX.test(label)
    ? { label: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { label, recommended: false }
}

function emptyDrafts(questions) {
  return questions.map(() => ({ selected: [], custom: '', skipped: false }))
}

function draftAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== ''
}

function draftCompleted(draft) {
  return draftAnswered(draft) || draft.skipped
}

function buildAnswer(questions, drafts) {
  return {
    answers: questions.map((item, index) => {
      const value = drafts[index]
      if (value.skipped) return { id: item.id, selected: [] }
      const custom = value.custom.trim()
      return {
        id: item.id,
        selected: custom === '' || item.multiSelect === true ? value.selected : [],
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

function permissionText(preset) {
  if (preset === 'read-only') return messages.accessReadOnly
  if (preset === 'workspace-write') return messages.accessWrite
  return messages.accessFull
}

/**
 * ★ 装配整个 UI —— **全文件只许调用一次**。
 *
 * ⚠️ 2026-10-07 用户实测三个现象，根因全是这里被调了两次
 *   （`main()` / `api.onImpression(…)` / `main()`）：
 *
 *   1. 「点重命名后菜单不消失」—— `createContextMenu()` 产出两个实例，
 *      两个都在 document 上 `bind()` 了右键。用户点「重命名」时
 *      **实例 A 关闭并进入编辑态，实例 B 的菜单仍留在屏幕上**，
 *      盖在输入框上。他看到的「✓ 点不动、像是取消了」就是这么来的。
 *   2. 「输入框里右键弹不出菜单」—— 同理，可编辑区的分支也跑了两遍，
 *      两个原生 `Menu.popup()` 抢同一个鼠标事件，结果互相打断。
 *   3. 缩放手柄也会被建**两套**（16 条），命中判定互相打架。
 *
 * 这个 bug 特别隐蔽的地方：`main()` 内部全是 `querySelector` +
 * `addEventListener`，跑两遍**不报错**、界面也「看起来正常」，
 * 只是每个交互都被执行两次。探针也抓不到 —— 探针是从产品文件里
 * **抽函数**测的，从来没有把 `main()` 整体跑过一遍。
 *
 * **教训：装配型函数必须有「只跑一次」的防护，且要有一条探针盯着。**
 * 下面这行守卫就是那道防线。
 */
function main() {
  if (main._done === true) {
    console.warn('[shell] main() 已装配过，忽略重复调用')
    return
  }
  main._done = true
  document.documentElement.lang = messages === zh ? 'zh' : 'en'
  const stop = document.querySelector('#stop')
  const newConversation = document.querySelector('#new-conversation')
  const historyButton = document.querySelector('#history')
  const permissionRoot = document.querySelector('#permission')
  const permissionButton = document.querySelector('#permission-button')
  const permissionLabel = document.querySelector('#permission-label')
  const permissionMenu = document.querySelector('#permission-menu')
  const ball = document.querySelector('#ball')
  const dockTab = document.querySelector('#dock-tab')
  const panel = document.querySelector('#panel')
  const transcript = document.querySelector('#transcript')
  const questionRoot = document.querySelector('#question')
  const questionEyebrow = document.querySelector('#question-eyebrow')
  const questionTitle = document.querySelector('#question-title')
  const questionDetail = document.querySelector('#question-detail')
  const questionOptions = document.querySelector('#question-options')
  const questionCustom = document.querySelector('#question-custom')
  const questionError = document.querySelector('#question-error')
  const questionPager = document.querySelector('#question-pager')
  const questionProgress = document.querySelector('#question-progress')
  const questionPrev = document.querySelector('#question-prev')
  const questionNextNav = document.querySelector('#question-next-nav')
  const questionSkip = document.querySelector('#question-skip')
  const questionContinue = document.querySelector('#question-continue')
  const questionCancel = document.querySelector('#question-cancel')
  const historyList = document.querySelector('#history-list')
  // 对话隐私锁（对话加密_落地方案.md）
  const lockGate = document.querySelector('#lock-gate')
  const lockCard = lockGate?.querySelector('.lock-card') ?? null
  const lockEyebrow = document.querySelector('#lock-eyebrow')
  const lockTitle = document.querySelector('#lock-title')
  const lockDetail = document.querySelector('#lock-detail')
  const lockInput = document.querySelector('#lock-input')
  const lockSubmit = document.querySelector('#lock-submit')
  const lockFeedback = document.querySelector('#lock-feedback')
  const lockHint = document.querySelector('#lock-hint')
  const lockClose = document.querySelector('#lock-close')
  const lockExport = document.querySelector('#lock-export')
  const status = document.querySelector('#status')
  const prompt = document.querySelector('#prompt')
  const composer = document.querySelector('#composer')
  const attachStrip = document.querySelector('#attach-strip')
  const dropHint = document.querySelector('#drop-hint')
  const deco = document.querySelector('#deco')

  /**
   * 情绪装饰 GIF（P1-5）。
   *
   * host 侧从她的回复里剥掉 `(mood:xxx)` 标记后，把「该显示哪个情绪」经
   * `orb:deco` 推过来（`src/mood.mjs` 的 `assetFor()`）。球侧只管渲染。
   *
   * ⚠️ 这是**独立图层**，不是球的 `#ball-gif` —— 后者是球的脸兼拖窗把手，
   *   挂情绪等于「她一开口就把球脸换掉」，还踩「球的视觉不许改」这条铁律。
   *   host 侧也是**专用类型 `deco` 而不是 `avatar`**，就是为了不串到球脸上。
   *
   * ⚠️ 为什么以前「她永远只有一张脸」而日志一条异常都没有：
   *   host 侧日志明明写着「已推送」，但 `helper/lib/main.js` 的
   *   `dispatchRecord` 里**根本没有 `deco` 分支** —— 记录走完匹配全落空，
   *   静默丢弃。凡是「静默丢弃型」的协议缺失，症状都长这样。
   *
   * 落点/图层按 `deco-plan/CONFIG.md`（用户已确认）：左下角、输入框左侧、
   * z-index 0（文字在上）。CSS 那边 `pointer-events: none` 是硬要求。
   */
  let decoMood = ''
  function applyDeco(payload) {
    if (pageClosed() || deco === null) return
    const src = typeof payload?.src === 'string' ? payload.src : ''
    // src 已由主进程过 PRESET_SRC 校验；这里再挡一层 `..`，
    // 免得哪条链路绕过主进程就把页面当资源目录读。
    if (src === '' || src.includes('..')) return
    const mood = typeof payload?.mood === 'string' && payload.mood !== '' ? payload.mood : 'idle'
    const opacity = Number(payload?.opacity)
    deco.style.opacity = String(Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0.65)
    if (src === deco.getAttribute('src')) {
      // 同一个情绪重复推（thinking 是回合驱动的临时态，会反复推同一个 src）——
      // 换 src 会让 GIF 从头播，重复赋值就是卡帧。相同则只更新透明度。
      deco.hidden = false
      return
    }
    decoMood = mood
    // data-mood 是「当前情绪」的唯一可查询入口：CONFIG 待办里的
    // 「状态联动」「透明度滑块」以及探针都靠它，别只留一个 JS 变量。
    deco.dataset.mood = mood
    deco.src = src
    deco.hidden = false
  }

  /**
   * 频率菜单的一次性回调中转。
   *
   * `contextMenu` 的 `onAction` 在**构造时**就固定了，`open()` 没法逐次覆盖
   * —— 而记忆中心的频率菜单是「按需打开、每次的回调不同」。
   * 用这个变量做单次中转：`openPicker` 写入，`handleMenuAction` 取走并清空。
   */
  let pendingSchedulePick = null

  /**
   * 「看过的视频」抽屉（2026-10-21）。
   *
   * 由来：环菜单原来有一项「打开旧后端界面」，旧后端 10-19 被整体剥离后它点不出任何东西
   * （只会弹一句「还没有旧后端地址」）。用户要求把这一项改造成「她在 B 站看过什么」。
   *
   * 数据只有一处真源：`<ORB_DATA>/bili-history.json`，由宿主侧记录、也由 `bili_history`
   * 工具读 —— 抽屉与工具看到的是同一份账，不存在两套口径。
   *
   * ⚠️ 必须声明在其它三个抽屉**之前**：它们的 `setExclusiveOpen` 里都要关掉本面板，
   *   而 `setHistoryOpen` 在初始化阶段就可能被调用；`const` 声明前访问是 TDZ 抛错，
   *   `?.` 救不了（与 `impressionPanel` 那段注释同一个坑）。
   */
  const biliHistoryPanel = createBiliHistoryPanel({
    translate: (key) => messages[key] ?? key,
    onToggle: () => syncQuestion(),
    setExclusiveOpen: (who) => {
      if (who === 'bili-history') {
        setHistoryOpen(false)
        impressionPanel?.setOpen(false)
        apiConfigPanel?.setOpen(false)
        themePanel?.setOpen(false)
      }
    },
    fetchHistory: () => (typeof api.biliHistory === 'function' ? api.biliHistory({ limit: 50 }) : Promise.resolve(null)),
    clearHistory: () => (typeof api.biliHistoryClear === 'function' ? api.biliHistoryClear() : Promise.resolve(null)),
    openExternal: (url) => { if (typeof api.openExternal === 'function') api.openExternal(url) },
    // 赞/币/藏：真的发 B 站接口（用登录 cookie + bili_jct），不挂网页。
    act: (payload) => (typeof api.biliAct === 'function' ? api.biliAct(payload) : Promise.resolve(null)),
    // 让她写「我为什么喜欢 / 想对作者说的话」
    compose: (payload) => (typeof api.biliCompose === 'function' ? api.biliCompose(payload) : Promise.resolve(null)),
    // 补写/重写「概览」（老条目没有画面时用元信息写，弱一点但不编）
    summaryWrite: (payload) => (typeof api.biliSummary === 'function' ? api.biliSummary(payload) : Promise.resolve(null)),
    noteSave: (payload) => (typeof api.biliNoteSave === 'function' ? api.biliNoteSave(payload) : Promise.resolve(null)),
    // ★ 公开发言：只有用户点「发送」并二次确认后才会走到这儿
    commentSend: (payload) => (typeof api.biliCommentSend === 'function' ? api.biliCommentSend(payload) : Promise.resolve(null)),
  })

  /**
   * 记忆中心面板（P0-7「我们的回忆」）。
   *
   * 与历史面板**互斥**：两个都是占满面板内容区的抽屉，同开时下层那份露不出来
   * （`#impression` 和 `#history-list` 都是绝对定位的兄弟节点）。
   * 双向互斥都在这里收口：
   *   - 反向（关历史 → 关记忆）写在 `setHistoryOpen` 里 ——
   *     那五处关闭点分散在别的方法中，逐个补一句迟早漏一处；
   *   - 正向（关记忆 → 关历史）走下面这个回调。
   *
   * ⚠️ 必须声明在 `applyStaticText()` **之前**：`setHistoryOpen` 会读
   *   `impressionPanel`，而它有一处在初始化阶段就被调用 ——
   *   `const` 声明前访问是 TDZ 抛错，`?.` 救不了。
   */
  const impressionPanel = createImpressionPanel({
    send: (action, extra) => api.impression?.({ action, ...(extra ?? {}) }),
    isZh: () => messages === zh,
    translate: (key) => messages[key] ?? key,
    // 记忆中心也是占满内容区的抽屉，开合要重新算「谁是当前视图」
    // （`#transcript` 显隐、提问卡片、情绪 GIF 都归 `syncQuestion` 收口）。
    //
    // ⚠️ 用箭头函数包一层而不是直接传`syncQuestion`：面板可能在
    //   `historyOpen` 初始化（TDZ）之前被打开，直接传会读到未初始化的绑定。
    onToggle: () => syncQuestion(),
    // 频率菜单复用右键菜单那套（自绘）。原生 <select> 的弹出列表是
    // OS 绘制的非客户区，暗色主题下会「选项浅色字落在白色弹出底上」——
    // 用户截图里是「一片空白，只有 hover 才看得见」。
    //
    // ⚠️ contextMenu 的 `onAction` 是**构造时**定的，`open()` 不能覆盖它。
    //   所以用 pendingSchedulePick 做一次性中转：开菜单前记下回调，
    //   命中 `impression.schedule` 时取走并清空。
    openPicker: (spec) => {
      pendingSchedulePick = typeof spec.onPick === 'function' ? spec.onPick : null
      contextMenu.open({
        x: spec.x,
        y: spec.y,
        // 前缀是必须的：球级菜单的 id 命名空间和对话级不同，
        // 混在一起会让 handleMenuAction 走错分支。
        items: spec.items.map((item) => ({ ...item, id: `impression.schedule.${item.id}` })),
      })
    },
    setExclusiveOpen: (who) => {
      if (who === 'impression') {
        setHistoryOpen(false)
        apiConfigPanel?.setOpen(false)
        themePanel?.setOpen(false)
        biliHistoryPanel?.setOpen(false)
      }
    },
  })

  /** host → 球的记忆中心消息。五类合并成一个回调，按 `type` 分派。 */
  api.onImpression?.((payload) => impressionPanel.onPayload(payload))

  /**
   * API 配置抽屉（待办 P2-1「独立的 API 配置界面」）。
   *
   * 形态与记忆中心一致：占满内容区、与其它抽屉互斥、从球菜单/环菜单进入。
   * 读盘与写盘**全在 helper 主进程**（`orb:api-config-get` / `-set`）：
   * 渲染层只负责呈现与收集输入，不碰旧后端的配置文件 ——
   * 那条链路要「先备份再写、路径错了要报错」，放在只管画的地方迟早出错。
   */
  const apiConfigPanel = createApiConfigPanel({
    translate: (key) => messages[key] ?? key,
    onToggle: () => syncQuestion(),
    setExclusiveOpen: (who) => {
      if (who === 'api-config') {
        setHistoryOpen(false)
        impressionPanel?.setOpen(false)
        themePanel?.setOpen(false)
        biliHistoryPanel?.setOpen(false)
      }
    },
    get: () => (typeof api.apiConfigGet === 'function' ? api.apiConfigGet() : Promise.resolve(null)),
    save: (patch) => (typeof api.apiConfigSet === 'function' ? api.apiConfigSet(patch) : Promise.resolve(null)),
    legacyStatus: () => (typeof api.legacyStatus === 'function' ? api.legacyStatus() : Promise.resolve(null)),
    // B 站扫码：三个动作 + 一次联网复核。都走 preload 白名单里的同名方法
    // （漏白名单的后果是渲染层拿到 undefined，面板上表现为按钮点了没反应）。
    biliStart: () => (typeof api.biliLoginStart === 'function' ? api.biliLoginStart() : Promise.resolve(null)),
    biliPoll: (key) => (typeof api.biliLoginPoll === 'function' ? api.biliLoginPoll(key) : Promise.resolve(null)),
    biliLogout: () => (typeof api.biliLogout === 'function' ? api.biliLogout() : Promise.resolve(null)),
    biliStatus: (opts) => (typeof api.biliStatus === 'function' ? api.biliStatus(opts) : Promise.resolve(null)),
  })

  /**
   * 背景层（用户 m02033：对话页 / 历史对话 / 我们的回忆各一张背景图）。
   *
   * ★ 它**不是第二个窗口**，而是面板内的一层 DOM —— 理由写在
   *   `backgrounds.js` 与 `floating.html` 的注释里（图片不变形靠的是
   *   cover/contain/auto 三种适配方式，从来不是靠窗口层数）。
   * ★ 真源在主进程（`orb:bg-*` + `logs/window-state.json`），本层只画快照。
   */
  const backgrounds = createBackgrounds()

  /**
   * 主题抽屉（用户 m02033：「环形菜单中需要额外加入一个主题菜单，
   * 其不仅提供了黑白两色的主题切换，还支持自定义分别导入前文三个页面的背景」）。
   *
   * 与「API 配置」同构：占满内容区、与其它抽屉互斥、从球菜单/环菜单进入。
   * 黑白切换的真源是主进程的 `nativeTheme.themeSource`（所有窗口一起翻），
   * 三张背景图的真源是 `helper/assets/backgrounds/`。
   */
  const themePanel = createThemePanel({
    translate: (key) => messages[key] ?? key,
    onToggle: () => syncQuestion(),
    setExclusiveOpen: (who) => {
      if (who === 'theme') {
        setHistoryOpen(false)
        impressionPanel?.setOpen(false)
        apiConfigPanel?.setOpen(false)
        biliHistoryPanel?.setOpen(false)
      }
    },
    getTheme: () => (typeof api.themeGet === 'function' ? api.themeGet() : Promise.resolve(null)),
    setTheme: (mode) => (typeof api.themeSet === 'function' ? api.themeSet(mode) : Promise.resolve(null)),
    getBackgrounds: () => (typeof api.backgroundsGet === 'function' ? api.backgroundsGet() : Promise.resolve(null)),
    importBackground: (slot) => (typeof api.backgroundsImport === 'function' ? api.backgroundsImport(slot) : Promise.resolve(null)),
    clearBackground: (slot) => (typeof api.backgroundsClear === 'function' ? api.backgroundsClear(slot) : Promise.resolve(null)),
    updateBackground: (patch) => (typeof api.backgroundsUpdate === 'function' ? api.backgroundsUpdate(patch) : Promise.resolve(null)),
    openFolder: () => { if (typeof api.openBackgroundsFolder === 'function') api.openBackgroundsFolder() },
  })

  applyStaticText()

  let expanded = false
  let pinned = false
  let running = false
  let attachedSelection = ''
  let tccGateVisible = false
  let processGroup
  let processClock
  let dragging = false
  let collapsing = false
  let skipClick = false
  let skipDockCommit = false
  let suppressExpand = false
  /** 环菜单是否开着（主进程 `orb:ring-state` 广播 + 本侧打开/关闭时即时更新）。 */
  let ringOpen = false
  let docked
  let dockHoverArmed = true
  let dockPointerInside = false
  let dockHoverTimer
  let collapseTimer
  let collapseFrame
  let pointer
  let lastOrigin
  let permission = 'danger-full-access'
  let permissionOpen = false
  let historyOpen = false
  let pending
  let sessionId = ''
  let avatarSrc = 'orb-idle.gif'
  let historyItems = []
  const blocks = new Map()
  // Last message per block key: the locale refresh re-renders from it.
  const blockData = new Map()
  let lastTccStatus
  /**
   * 当前展开方向 `{horizontal, vertical}`，由 `applyDirection` 维护。
   * 缩放手柄靠它判断「哪几条边远离球、可以拖」（resize-handles.js 的 freeEdges）。
   * 初值取安全默认：面板在球的左上 → 自由边是下（s）和右（e）。
   */
  let expandDirection = { horizontal: 'left', vertical: 'up' }

  /**
   * Re-apply every static label. Called at startup and on locale changes;
   * dynamic regions (permission, history, question, TCC gate, transcript) are
   * refreshed separately from their stored state.
   */
  function applyStaticText() {
    document.querySelector('#page-title').textContent = messages.title
    const stopButton = document.querySelector('#stop')
    stopButton.setAttribute('aria-label', messages.stop)
    stopButton.title = messages.stop
    const newConversationButton = document.querySelector('#new-conversation')
    newConversationButton.setAttribute('aria-label', messages.fresh)
    newConversationButton.title = messages.fresh
    const historyToggle = document.querySelector('#history')
    historyToggle.setAttribute('aria-label', messages.history)
    historyToggle.title = messages.history
    document.querySelector('#input-label').textContent = messages.placeholder
    prompt.dataset.placeholder = messages.placeholder
    questionCancel.textContent = messages.cancel
    questionSkip.textContent = messages.skip
    questionPrev.setAttribute('aria-label', messages.prev)
    questionNextNav.setAttribute('aria-label', messages.next)
    questionPrev.textContent = '‹'
    questionNextNav.textContent = '›'
    const chipDismiss = document.querySelector('#selection-chip-dismiss')
    chipDismiss.setAttribute('aria-label', messages.chipDismiss)
    chipDismiss.title = messages.chipDismiss
    document.querySelector('#tcc-screen-name').textContent = messages.tccScreenName
    document.querySelector('#tcc-screen-reason').textContent = messages.tccScreenReason
    document.querySelector('#tcc-screen-path').textContent = messages.tccScreenPath
    document.querySelector('#tcc-screen-open').textContent = messages.tccScreenOpen
    document.querySelector('#tcc-accessibility-name').textContent = messages.tccAccessibilityName
    document.querySelector('#tcc-accessibility-reason').textContent = messages.tccAccessibilityReason
    document.querySelector('#tcc-accessibility-path').textContent = messages.tccAccessibilityPath
    document.querySelector('#tcc-accessibility-open').textContent = messages.tccAccessibilityOpen
    document.querySelector('#tcc-title').textContent = messages.tccTitle
    document.querySelector('#tcc-later').textContent = messages.tccLater
    const tccClose = document.querySelector('#tcc-dismiss')
    tccClose.setAttribute('aria-label', messages.tccDismiss)
    tccClose.title = messages.tccDismiss
    for (const option of permissionMenu.querySelectorAll('button')) {
      option.textContent = permissionText(option.dataset.preset)
    }
  }

  /** Re-render every text surface after the dictionary switched. */
  function refreshAllText() {
    applyStaticText()
    // 三个占满内容区的抽屉各自把静态文案刷一遍（此前它们只在构造时取过文案，
    // 切语言时抽屉里的标题/按钮会一直是旧语种 —— 顺手补上）。
    impressionPanel?.setLocale?.()
    apiConfigPanel?.setLocale?.()
    themePanel?.setLocale?.()
    biliHistoryPanel?.setLocale?.()
    renderPermission()
    renderHistory()
    if (pending !== undefined) renderQuestion()
    if (tccGateVisible && lastTccStatus) showTccGate(lastTccStatus)
    refreshProcessLabel(processGroup)
    refreshTranscriptLocale()
  }

  /** Locale-dependent labels inside the transcript, from the stored messages. */
  function refreshTranscriptLocale() {
    for (const [key, node] of blocks) {
      const block = blockData.get(key)
      if (block === undefined) continue
      if (block.kind === 'user') continue
      if (block.kind === 'reasoning') {
        node.querySelector('.think-title').textContent = messages.think
        node.querySelector('.visually-hidden').textContent = block.running ? messages.running : ''
      } else if (block.kind === 'tool') {
        updateToolNode(node, block)
      } else {
        updateAssistantNode(node, block)
      }
    }
    refreshProcessLabel(processGroup)
  }

  function pageClosed() {
    return globalThis.document?.body == null
  }

  function freezeGif(gif) {
    const still = () => {
      if (gif.dataset.mode !== 'still' || gif.naturalWidth === 0) return
      const canvas = document.createElement('canvas')
      canvas.width = gif.naturalWidth
      canvas.height = gif.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null) return
      context.drawImage(gif, 0, 0)
      try {
        gif.src = canvas.toDataURL()
      } catch {
        // The GIF already reset to its first frame.
      }
    }
    if (gif.complete && gif.naturalWidth > 0) still()
    else gif.addEventListener('load', still, { once: true })
  }

  function asking() {
    return pending !== undefined
  }

  function syncGif() {
    if (pageClosed()) return
    const gif = document.querySelector('#ball-gif')
    const play = expanded || running || asking() || tccGateVisible || attachedSelection !== ''
    if (play) {
      if (gif.dataset.mode !== 'play') {
        gif.dataset.mode = 'play'
        gif.src = avatarSrc
      }
      return
    }
    if (gif.dataset.mode === 'still') return
    gif.dataset.mode = 'still'
    gif.src = avatarSrc
    freezeGif(gif)
  }

  function setRunning(next, interrupted = false) {
    running = next
    if (pageClosed()) return
    document.body.classList.toggle('running', running)
    stop.hidden = !expanded || !running
    syncGif()
    if (next) {
      const group = ensureProcess()
      if (!group.live) {
        group.live = true
        group.startedAt = Date.now()
        group.elapsedMs = undefined
        setProcessOpen(group, true)
        refreshProcessLabel(group)
        startProcessClock()
      }
      return
    }
    if (interrupted) {
      for (const node of blocks.values()) {
        if (node.dataset.kind === 'tool' && node.dataset.state === 'running') {
          node.dataset.state = 'stopped'
          const summary = node.querySelector('.tool-summary')
          summary?.classList.add('tool-stopped-summary')
        }
      }
    }
    if (processGroup) {
      stopProcessClock()
      freezeProcess(processGroup)
      setProcessOpen(processGroup, false)
      refreshProcessLabel(processGroup)
    }
  }

  function applyDirection(state) {
    document.body.classList.toggle('expand-left', state.horizontal === 'left')
    document.body.classList.toggle('expand-right', state.horizontal === 'right')
    document.body.classList.toggle('expand-up', state.vertical === 'up')
    document.body.classList.toggle('expand-down', state.vertical === 'down')
    // 方向决定「哪几条边能拖」（resize-handles.js 的 freeEdges），
    // 方向一变就得重算哪几个手柄该露出来。
    expandDirection = { horizontal: state.horizontal, vertical: state.vertical }
    resizeHandles?.refresh()
  }

  function clearDockHoverTimer() {
    if (dockHoverTimer === undefined) return
    clearTimeout(dockHoverTimer)
    dockHoverTimer = undefined
  }

  function applyDocked(side) {
    const next = side === 'left' || side === 'right' ? side : undefined
    const becameDocked = docked === undefined && next !== undefined
    docked = next
    document.body.classList.toggle('docked', next !== undefined)
    document.body.classList.toggle('docked-left', next === 'left')
    document.body.classList.toggle('docked-right', next === 'right')
    clearDockHoverTimer()
    if (next === undefined) {
      dockTab.hidden = true
      dockHoverArmed = true
      return
    }
    if (becameDocked) {
      dockHoverArmed = false
      dockHoverTimer = setTimeout(() => {
        dockHoverTimer = undefined
        dockHoverArmed = true
        if (dockPointerInside) void unsnapDocked()
      }, DOCK_HOVER_DELAY_MS)
    }
    dockTab.hidden = false
  }

  function applyDockedFrom(result) {
    if (result == null) return
    applyDocked(result.docked)
  }

  async function moveBall(x, y) {
    applyDockedFrom(await api.move(x, y, !(running || asking())))
  }

  async function clampBall() {
    applyDockedFrom(await api.clamp(!(running || asking())))
  }

  async function unsnapDocked() {
    if (docked === undefined) return
    suppressExpand = true
    if (dragging) skipDockCommit = true
    applyDocked(undefined)
    applyDockedFrom(await api.unsnap())
  }

  async function setExpanded(next, force = false) {
    if (pageClosed()) return
    if (collapseTimer !== undefined) {
      clearTimeout(collapseTimer)
      collapseTimer = undefined
    }
    if (collapseFrame !== undefined) {
      clearTimeout(collapseFrame)
      collapseFrame = undefined
    }
    if (next) {
      // 展开面板 = 收掉环菜单（左右键互斥的另一半）。不 await：ringClose 只让主进程 hide，
      // 面板展开必须紧接着走。
      if (typeof api.ringClose === 'function') api.ringClose()
      ringOpen = false
      const state = await api.setExpanded(true)
      applyDocked(undefined)
      applyDirection(state)
      panel.hidden = false
      expanded = true
      document.body.classList.add('expanded')
      stop.hidden = !running
      syncGif()
      // 手柄只在展开态存在。收起态窗口只有球那么大，
      // 手柄要是还吃事件，球就拖不动、点不开了。
      resizeHandles?.refresh()
      return
    }
    if (!force && (pinned || running || asking())) return
    expanded = false
    // ★ 面板一收，抽屉必须跟着复位到「默认只显示对话流」。
    //   用户 m01036：从环菜单进了「我们的回忆」，收起面板后再点球，面板还停在回忆页 ——
    //   因为整条收起路径从来没关过任何抽屉（#panel.hidden 只是把面板藏了，
    //   里面的 #impression 仍是显示态）。放在收起的那一刻清，重开就是默认视图。
    resetDrawers()
    document.body.classList.remove('expanded')
    // 收起前立刻收掉手柄，不能等动画结束 —— 收起是立刻发生的
    resizeHandles?.refresh()
    if (docked !== undefined) dockTab.hidden = false
    stop.hidden = true
    syncGif()
    if (force) {
      panel.hidden = true
      await api.setExpanded(false)
      return
    }
    collapseFrame = setTimeout(() => {
      collapseFrame = undefined
      panel.hidden = true
      void api.setExpanded(false)
    }, ANIMATION_MS)
  }

  function ballGrabOffset(event) {
    const rect = ball.getBoundingClientRect()
    return { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  }

  function scheduleCollapse() {
    if (pinned || running || asking() || dragging) return
    if (collapseTimer !== undefined) clearTimeout(collapseTimer)
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      void setExpanded(false)
    }, COLLAPSE_MS)
  }

  function draftOverflows() {
    return prompt.scrollHeight > prompt.clientHeight + 1
  }

  function syncComposerHeight() {
    const empty = promptText(prompt).trim() === ''
    prompt.classList.toggle('prompt-empty', empty)
    composer.classList.toggle('has-text', !empty)
    if (empty) {
      document.body.classList.remove('composer-capped')
      document.body.style.setProperty('--composer-height', 'var(--ball)')
      return
    }
    document.body.classList.remove('composer-capped')
    let height = COMPOSER_MIN_PX
    for (;;) {
      document.body.style.setProperty('--composer-height', `${height}px`)
      if (!draftOverflows() || height >= COMPOSER_MAX_PX) break
      height = Math.min(COMPOSER_MAX_PX, height + COMPOSER_LINE_PX)
    }
    document.body.classList.toggle('composer-capped', draftOverflows())
  }

  function clearPrompt() {
    prompt.textContent = ''
    prompt.classList.add('prompt-empty')
    document.body.classList.remove('composer-capped')
    document.body.style.setProperty('--composer-height', 'var(--ball)')
  }

  // ──────────────────────────────────────────────── 图片附件（P2-4）
  //
  // 参照 WorkBuddy 对话框发图（见 `参考-WorkBuddy图片实现.md`）。orb 比它简单：
  // 没有云、没有 netdrive、没有多用户，所以砍掉整个上传队列层，
  // 只留 **采集 → 压缩 → 预览 → 上送** 四步。
  //
  // ★ 为什么先压再存：`create_message` 的 image part 是 base64，
  //   一张 3MB 的手机照变成 4MB 字符 → 每轮上下文都背着它。压缩目标 512KB。
  //
  // ★ 为什么压缩在渲染层做：`main.js` 是 Node，没有 DOM、没有 canvas、
  //   没有 createImageBitmap。压缩必须在有 DOM 的这侧完成，
  //   上送的是**压缩后的 base64**。
  const attachments = []
  let attachSeq = 0
  let flashTimer

  /**
   * 临时提示：写进 `#status`，过几秒撤掉。
   *
   * ⚠️ 不直接 `status.textContent = x` 就走 —— `#status` 是**共享**的，
   *    host 的 `orb:status` 也往这里写（:2919）。临时消息不撤等于把
   *    host 的状态盖死。这里记录写入前的值并还原，是最小侵入做法。
   */
  function flashStatus(text, ms = 2600) {
    const previous = status.textContent
    status.textContent = text
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashTimer = undefined
      if (status.textContent === text) status.textContent = previous
    }, ms)
  }

  function renderAttachments() {
    attachStrip.textContent = ''
    if (attachments.length === 0) {
      attachStrip.hidden = true
      return
    }
    attachStrip.hidden = false
    for (const a of attachments) {
      const item = document.createElement('li')
      item.className = 'attach-item'
      item.dataset.id = a.id
      item.dataset.busy = a.busy ? '1' : '0'
      // heavy = 「压了但没压到 512KB 目标」或「压根没压（五十兆以上放弃）」，
      // 角标提醒用户这张图会明显吃上下文，删不删由他自己决定。
      item.dataset.heavy = !a.busy && (a.block.compressed === false || a.block.reachedTarget === false) ? '1' : '0'
      const sizeLine = a.busy
        ? `${a.block.name}\n处理中…`
        : `${a.block.name}\n${formatBytes(a.block.originalBytes)} → ${formatBytes(a.block.finalBytes)}`
      item.title = sizeLine
      const img = document.createElement('img')
      img.src = a.block.thumbURL
      img.alt = a.block.name
      item.append(img)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'attach-remove'
      remove.setAttribute('aria-label', `移除 ${a.block.name}`)
      remove.textContent = '×'
      // ⚠️ 必须 stopPropagation：附件条在 `#composer` 里，composer 上有 click
      //    监听（点空白聚焦输入框）。不挡的话删完图焦点会跳到输入框，
      //    在部分输入法下会把正在进行的选择吃掉。
      remove.addEventListener('click', (event) => {
        event.stopPropagation()
        event.preventDefault()
        dropAttachment(a.id)
      })
      item.append(remove)
      attachStrip.append(item)
    }
  }

  function dropAttachment(id) {
    const i = attachments.findIndex((a) => a.id === id)
    if (i < 0) return
    const [gone] = attachments.splice(i, 1)
    // objectURL 必须手动回收 —— 这个项目对资源泄漏敏感（见 image-attach.js 的 dispose）
    gone?.block?.dispose?.()
    renderAttachments()
  }

  function clearAttachments() {
    for (const a of attachments) a.block?.dispose?.()
    attachments.length = 0
    renderAttachments()
  }

  /**
   * ── 发送后把缩略图「交接」给对话流（P2-4 补）────────────────────────
   *
   * ★ 发送路径**不能**直接 `clearAttachments()`：它对每张附件走 `dispose()`
   *   → `URL.revokeObjectURL`，而这几张缩略图马上要贴进消息气泡里显示。
   *   URL 一 revoke，气泡里的 <img> 就是裂图 —— 与附件条那个裂图同源。
   *   所以发送时把这些块从附件条摘下来、留在 liveThumbs 里，等 clearTranscript 统一回收。
   */
  const liveThumbs = new Set()
  /** [{ count, blocks }] —— host 只回「有几张图」，按到达顺序配给 user 块。 */
  const echoQueue = []

  function handOffAttachments() {
    const handed = []
    for (const a of attachments) {
      const b = a.block
      if (a.busy) continue
      if (typeof b?.thumbURL !== 'string' || b.thumbURL === '') continue
      handed.push(b)
      liveThumbs.add(b)
    }
    attachments.length = 0
    renderAttachments()
    return handed
  }

  /** 取一批张数对得上的交接块；对不上就不取（宁可退回文字占位，也不画裂图）。 */
  function takeEchoThumbs(count) {
    const i = echoQueue.findIndex((e) => e.count === count)
    if (i < 0) return null
    const [entry] = echoQueue.splice(i, 1)
    return entry.blocks
  }

  /** 会话切换/重开时统一回收交接出去的 objectURL（调用前节点必须已经清掉）。 */
  function disposeLiveThumbs() {
    for (const b of liveThumbs) b.dispose?.()
    liveThumbs.clear()
    echoQueue.length = 0
  }

  /**
   * 历史回放的原图缓存（P2-4 补）。
   *
   * 磁盘上只推了「有几张图」，本体太大不能随块走（host 侧注释：4MB base64 走
   * innerHTML 级渲染会把面板卡死）。所以球上先画**可点击**的「图片 ×N」占位，
   * 点了才向 host 要那一张；拿到的 dataURL 按块 key 缓存，切走切回不用再请求。
   *
   * ⚠️ 这个缓存**故意不在 clearTranscript 里清**：清了就正好丢掉「切回来还能看」。
   *    key 自带会话前缀（`<convId>|u:ui-msg-N`），不会串会话。
   */
  const imageCache = new Map()
  /** 正在请求中的块 key（防连点重复请求）。 */
  const imagePending = new Set()

  /**
   * 收一批 File，逐个走「压缩 → 建缩略图」。
   *
   * ★ 先占位再压缩：压缩是异步的（大图要几百毫秒），先 push 一个 busy 块
   *   让用户**立刻看到「收到了」**，再原地替换成真图。全部压完才 append
   *   会让用户在慢图上以为没生效，然后重复拖同一张 —— 这正是 WorkBuddy
   *   用「上传队列」解决的问题，orb 需求简单，用占位块代替队列。
   */
  async function addFiles(files) {
    const list = Array.from(files ?? []).filter(isImageFile)
    if (list.length === 0) return
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      void flashStatus(`最多 ${MAX_ATTACHMENTS} 张图片`)
      return
    }
    const accepted = list.slice(0, room)
    if (list.length > room) void flashStatus(`最多 ${MAX_ATTACHMENTS} 张图片，多余已忽略`)

    const jobs = accepted.map((file) => {
      const id = `att-${++attachSeq}`
      // 占位块：thumbURL 先给空串，压缩完再补 —— renderAttachments 读的是
      // `a.block`，所以先塞一个「空壳」，压缩回来后整体替换。
      const placeholder = {
        id, busy: true,
        block: {
          id, name: file.name || 'image', thumbURL: '', mimeType: file.type || '',
          originalBytes: file.size || 0, finalBytes: 0, compressed: false,
          reachedTarget: false, dispose: () => {},
        },
      }
      attachments.push(placeholder)
      renderAttachments()
      return { id, file }
    })

    for (const { id, file } of jobs) {
      let block
      try {
        block = await prepareAttachment(file)
      } catch (err) {
        // 单张失败不拖垮整批：把占位块摘掉，提示一句。
        // 静默失败会让用户以为「拖进去了但没显示」，与「功能不存在」同症状。
        dropAttachment(id)
        void flashStatus(`这张图处理失败：${err?.message ?? '未知错误'}`)
        continue
      }
      const slot = attachments.find((a) => a.id === id)
      if (!slot) {
        // 用户在压缩期间点了删除 —— 把刚建好的资源立刻释放，别泄漏。
        block.dispose?.()
        continue
      }
      slot.block = block
      slot.busy = false
      renderAttachments()
    }
  }

  /** 把附件转成可上送的形状（base64 在提交那一刻才读，见 h$t 的等价物）。 */
  async function collectAttachments() {
    const out = []
    for (const a of attachments) {
      if (a.busy) continue
      const real = a.block
      if (typeof real?.toBase64 !== 'function') continue
      out.push({
        name: real.name,
        mimeType: real.mimeType,
        data: await real.toBase64(),
      })
    }
    return out
  }

  function refreshProcessLabel(group) {
    if (!group) return
    const elapsedMs = group.live
      ? group.startedAt === undefined ? undefined : Date.now() - group.startedAt
      : group.elapsedMs
    const title = !group.live && group.tools.size > 0
      ? processTitle([...group.tools], messages === zh)
      : undefined
    group.label.textContent = processLabel({
      zh: messages === zh,
      running: group.live,
      elapsedMs,
      title,
    })
  }

  function setProcessOpen(group, open) {
    if (!group) return
    group.preferredOpen = open
    const foldable = group.bodies.some((body) => body.childElementCount > 0)
    const shown = open && foldable
    group.section.toggleAttribute('data-open', shown)
    group.header.toggleAttribute('data-open', shown)
    group.header.disabled = !foldable
    group.chevron.hidden = !foldable
    if (foldable) group.header.setAttribute('aria-expanded', String(shown))
    else group.header.removeAttribute('aria-expanded')
  }

  function freezeProcess(group) {
    if (!group?.live) return
    group.elapsedMs = group.startedAt === undefined ? undefined : Date.now() - group.startedAt
    group.live = false
  }

  function stopProcessClock() {
    if (processClock === undefined) return
    clearInterval(processClock)
    processClock = undefined
  }

  function startProcessClock() {
    stopProcessClock()
    processClock = setInterval(() => {
      if (processGroup?.live) refreshProcessLabel(processGroup)
    }, 1000)
  }

  function closeProcess() {
    const group = processGroup
    if (!group) return
    stopProcessClock()
    freezeProcess(group)
    refreshProcessLabel(group)
    setProcessOpen(group, false)
    processGroup = undefined
  }

  function ensureProcess() {
    if (processGroup) return processGroup
    const section = document.createElement('section')
    section.className = 'turn'
    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'process'
    const label = document.createElement('span')
    label.className = 'process-label'
    const chevron = icon(CHEVRON_DOWN)
    chevron.classList.add('process-chevron')
    header.append(label, chevron)
    section.append(header)
    const loose = []
    let anchor = null
    for (const child of transcript.children) {
      if (child.dataset?.kind === 'user') {
        loose.length = 0
        anchor = null
        continue
      }
      if (child.dataset?.kind === 'assistant') {
        if (anchor === null) anchor = child
        loose.push(child)
      }
    }
    if (anchor) transcript.insertBefore(section, anchor)
    else transcript.append(section)
    for (const node of loose) section.append(node)
    const live = running
    const group = {
      section, header, label, chevron, bodies: [], current: undefined, live,
      startedAt: live ? Date.now() : undefined,
      elapsedMs: undefined,
      preferredOpen: live,
      tools: new Set(),
    }
    processGroup = group
    header.addEventListener('click', () => {
      if (header.disabled) return
      setProcessOpen(group, !section.hasAttribute('data-open'))
    })
    setProcessOpen(group, live)
    refreshProcessLabel(group)
    if (live) startProcessClock()
    return group
  }

  function syncThinkPreview(node) {
    const summary = node.querySelector('.think-summary-text')?.textContent ?? ''
    node.toggleAttribute('data-preview', !node.hasAttribute('data-expanded') && summary !== '')
  }

  function createThink(node) {
    node.dataset.variant = 'think'
    const status = document.createElement('span')
    status.className = 'visually-hidden'
    const disclosure = document.createElement('div')
    disclosure.className = 'think-disclosure'
    const row = document.createElement('div')
    row.className = 'think-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    const leading = document.createElement('span')
    leading.className = 'think-leading'
    const idle = document.createElement('span')
    idle.className = 'think-icon-idle'
    idle.append(icon(THINK))
    const hover = document.createElement('span')
    hover.className = 'think-chevron-hover'
    hover.append(icon(CHEVRON_DOWN))
    const openChevron = document.createElement('span')
    openChevron.className = 'think-chevron-open'
    openChevron.append(icon(CHEVRON_UP))
    leading.append(idle, hover, openChevron)
    const title = document.createElement('span')
    title.className = 'think-title'
    title.textContent = messages.think
    const separator = document.createElement('span')
    separator.className = 'think-separator'
    separator.setAttribute('aria-hidden', 'true')
    const summary = document.createElement('span')
    summary.className = 'think-summary'
    const summaryText = document.createElement('span')
    summaryText.className = 'think-summary-text'
    summary.append(summaryText)
    row.append(leading, title, separator, summary)
    const body = document.createElement('div')
    body.className = 'think-body'
    disclosure.append(row, body)
    node.append(status, disclosure)
    const toggle = () => {
      const open = !node.hasAttribute('data-expanded')
      node.toggleAttribute('data-expanded', open)
      disclosure.toggleAttribute('data-open', open)
      row.setAttribute('aria-expanded', String(open))
      syncThinkPreview(node)
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
  }

  /**
   * 系统提示行（`kind='notice'`）—— 目前只有「上下文压缩」用它（用户 m02698）。
   *
   * 为什么不复用 think/tool：那两种会被 `placeBlock` 收进「过程组」（`.turn`），
   * 而 `.turn:not([data-open]) > .block[data-kind="assistant"]:not([data-response])`
   * 那类折叠规则会连它一起藏掉。压缩提示属于「时间线上发生的事」，不是她的过程，
   * 所以它直接挂在 `#transcript` 上（同 user 行一级）。
   *
   * 摘要可能很长（`clip_chars` 默认 50000），所以正文默认收起 —— **有摘要才给箭头**，
   * 没有摘要（「摘要生成中…」那一刻）时整行不可点。
   */
  function createNoticeNode(node) {
    node.dataset.variant = 'notice'
    const row = document.createElement('div')
    row.className = 'notice-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    const leading = document.createElement('span')
    leading.className = 'notice-leading'
    leading.append(icon(COMPACT))
    const text = document.createElement('span')
    text.className = 'notice-text'
    const chevron = document.createElement('span')
    chevron.className = 'notice-chevron'
    chevron.append(icon(CHEVRON_DOWN))
    row.append(leading, text, chevron)
    const body = document.createElement('div')
    body.className = 'notice-body'
    body.hidden = true
    node.append(row, body)
    const toggle = () => {
      if (!node.hasAttribute('data-has-summary')) return
      const open = !node.hasAttribute('data-expanded')
      node.toggleAttribute('data-expanded', open)
      row.setAttribute('aria-expanded', String(open))
      body.hidden = !open
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
  }

  function updateNoticeNode(node, block) {
    node.querySelector('.notice-text').textContent = block.text
    const summary = typeof block.detail?.summary === 'string' ? block.detail.summary : ''
    node.toggleAttribute('data-has-summary', summary !== '')
    const body = node.querySelector('.notice-body')
    if (summary === '') {
      node.removeAttribute('data-expanded')
      node.querySelector('.notice-row').setAttribute('aria-expanded', 'false')
      body.hidden = true
      body.textContent = ''
      return
    }
    renderMarkdownBody(body, summary, { compact: true, live: block.running === true })
    // 摘要与统计是同一条 resend 一起到的：展开与否**尊重用户当前状态**，不强制收起。
    body.hidden = !node.hasAttribute('data-expanded')
  }

  /**
   * Chronological placement, as in Harness: replies sit between the process
   * runs that produced them. Thinking and tool blocks join the trailing
   * process body; a reply closes that run, so later tools open a new one.
   */
  function placeBlock(node, kind) {
    // user 行与系统提示行（notice）都直接挂在 transcript 上：它们不属于任何
    // 一轮的「过程」，也必须在折叠某一轮时依然可见。挂之前先断掉当前过程组，
    // 免得紧接着的正文被并进上一轮。
    if (kind === 'user' || kind === 'notice') {
      closeProcess()
      transcript.append(node)
      return
    }
    // reasoning 和 tool 节点移到 deco-lane 的 reasoning-lane（可滚动区域），
    // 不占用 transcript 的对话空间。右侧 GIF 不受影响。
    if (kind === 'reasoning' || kind === 'tool') {
      const lane = document.querySelector('#reasoning-lane')
      if (lane) {
        lane.append(node)
        return
      }
    }
    // With no turn section at all a reply stays loose; the next thinking/tool block scoops it in.
    if (kind === 'assistant' && processGroup === undefined) {
      transcript.append(node)
      return
    }
    const group = ensureProcess()
    if (kind === 'assistant') {
      group.current = undefined
      group.section.append(node)
      return
    }
    let body = group.current
    if (body === undefined) {
      body = document.createElement('div')
      body.className = 'process-body'
      group.section.append(body)
      group.bodies.push(body)
      group.current = body
    }
    body.append(node)
    setProcessOpen(group, group.preferredOpen === true)
  }

  const CHAT_READ_MAX_LINES = 8
  const CHAT_SEARCH_MAX_LINES = 8
  const CHAT_DIFF_MAX_LINES = 9

  function toolIcon(name) {
    if (name === 'web_search') return icon(GLOBE)
    if (name === 'web_fetch' || name === 'read' || name === 'read_image') return icon(BROWSE)
    switch (classifyTool(name)) {
      case 'bash': return icon(API)
      case 'search': return icon(SEARCH)
      case 'write':
      case 'edit': return icon(EDIT)
      case 'code': return icon(CODE)
      default: return icon(SPARKLE)
    }
  }

  async function writeClipboard(text) {
    // Main-process write: renderer clipboard APIs reject while the ball window
    // rests unfocused ("Document is not focused").
    if (typeof api?.copy === 'function') {
      api.copy(text)
      return true
    }
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    area.remove()
    return copied
  }

  function copyToClipboard(text, button) {
    const restore = () => {
      button.textContent = chatLabels.copy
      delete button.dataset.copied
    }
    const done = () => {
      button.textContent = chatLabels.copied
      button.dataset.copied = 'true'
      setTimeout(restore, 1600)
    }
    void writeClipboard(text).then((ok) => {
      if (ok) done()
      else restore()
    })
  }

  /**
   * Icon copy button for message chrome (MessageIconActions): copy glyph,
   * brief check mark once the clipboard write resolves.
   */
  function messageCopyButton(getText) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'msg-copy'
    button.title = chatLabels.copy
    button.append(icon(COPY))
    let revertTimer
    const reset = () => {
      delete button.dataset.copied
      button.title = chatLabels.copy
      button.replaceChildren(icon(COPY))
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (button.dataset.copied === 'true') return
      void writeClipboard(getText()).then((ok) => {
        if (!ok) return
        clearTimeout(revertTimer)
        button.dataset.copied = 'true'
        button.title = chatLabels.copied
        button.replaceChildren(icon(CHECK))
        revertTimer = setTimeout(reset, 1200)
      })
    })
    return button
  }

  /** Usage pill text: "12.3K tok", hidden entirely when no usage arrived. */
  function usagePill(node, block) {
    const pill = node.querySelector('.am-usage')
    const total = block.running ? null : tokenUsageTotal(block.usage)
    pill.hidden = total === null
    if (total !== null) {
      pill.textContent = usageText.count(formatTokenCount(total))
      pill.title = usageText.title
    }
  }

  function wireCopyButtons(root) {
    for (const button of root.querySelectorAll('.cb-copy, .term-copy, .search-copy')) {
      if (button.dataset.wired === 'true') continue
      button.dataset.wired = 'true'
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const block = button.closest('.cb, .term, .search')
        const code = block?.querySelector('pre')?.textContent ?? ''
        copyToClipboard(code, button)
      })
    }
  }

  function renderMarkdownBody(element, text, { compact = false, live = false } = {}) {
    element.innerHTML = renderMarkdown(text, { compact, copyLabel: chatLabels.copy })
    wireCopyButtons(element)
    // Shiki runs on settled content only; re-highlighting every delta is too costly while streaming.
    if (!live) void upgradeCodeBlocks(element)
  }

  function shimmer(element, active) {
    if (active) element.setAttribute('data-text-shimmer', '')
    else element.removeAttribute('data-text-shimmer')
  }

  /** Bounded row list with the primitives' ghost "… N more" expander. */
  function cappedRows(target, rows, cap) {
    target.replaceChildren()
    const show = rows.slice(0, cap)
    for (const row of show) target.append(row)
    if (rows.length <= cap) return
    const expand = document.createElement('button')
    expand.type = 'button'
    expand.className = 'card-expand'
    expand.textContent = `… ${rows.length - show.length}`
    let open = false
    expand.addEventListener('click', (event) => {
      event.stopPropagation()
      open = !open
      for (const row of rows.slice(show.length)) {
        if (open) target.append(row)
        else row.remove()
      }
      expand.remove()
      if (!open) {
        for (const row of rows.slice(cap)) row.remove()
        target.append(expand)
      }
      expand.textContent = open ? chatLabels.collapse : `… ${rows.length - show.length}`
      if (!open) return
    })
    target.append(expand)
  }

  function buildTerminalCard(model) {
    const card = document.createElement('div')
    card.className = 'term'
    card.setAttribute('data-body', 'true')
    const header = document.createElement('div')
    header.className = 'term-header'
    const prompt = document.createElement('div')
    prompt.className = 'term-prompt'
    const line = document.createElement('div')
    line.className = 'term-prompt-line'
    const command = document.createElement('span')
    command.className = 'term-command'
    command.textContent = model.command
    line.append(command)
    const failed = terminalFailed(model)
    const status = document.createElement('span')
    status.className = 'term-status'
    if (model.signal !== undefined) status.textContent = chatLabels.signal(model.signal)
    else if (model.exitCode === undefined || model.exitCode === null) status.textContent = chatLabels.noExitCode
    else {
      status.textContent = chatLabels.exitCode(model.exitCode)
      if (model.exitCode === 0 && !failed) status.setAttribute('data-ok', 'true')
    }
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'term-copy'
    copy.textContent = chatLabels.copy
    prompt.append(line)
    header.append(prompt, status, copy)
    card.append(header)
    const output = document.createElement('div')
    output.className = 'term-output'
    const text = model.output ?? ''
    if (text === '') {
      const empty = document.createElement('div')
      empty.className = 'term-empty'
      empty.textContent = chatLabels.noOutput
      card.append(empty)
    } else {
      for (const row of text.split('\n')) {
        const lineEl = document.createElement('div')
        lineEl.className = 'term-line'
        lineEl.textContent = row
        output.append(lineEl)
      }
      card.append(output)
    }
    return card
  }

  function buildDiffCard(model) {
    const card = document.createElement('div')
    card.className = 'diff'
    const body = document.createElement('div')
    body.className = 'diff-body'
    const rows = []
    for (const hunk of model.diffs) {
      const path = document.createElement('div')
      path.className = 'diff-line diff-path'
      path.textContent = hunk.path
      rows.push(path)
      for (const line of diffLines(hunk)) {
        const row = document.createElement('div')
        row.className = `diff-line diff-${line.kind}`
        row.textContent = line.text
        rows.push(row)
      }
    }
    cappedRows(body, rows, CHAT_DIFF_MAX_LINES)
    card.append(body)
    return card
  }

  function buildReadCard(model) {
    const card = document.createElement('div')
    card.className = 'cb'
    card.setAttribute('data-code-lang', model.lang ?? '')
    const bannerWrap = document.createElement('div')
    bannerWrap.className = 'cb-banner-wrap'
    const banner = document.createElement('div')
    banner.className = 'cb-banner'
    banner.setAttribute('data-code-block-banner', '')
    const info = document.createElement('div')
    info.className = 'cb-infostring'
    info.textContent = `${model.label} · ${chatLabels.readWindow(Math.min(model.lines.length, CHAT_READ_MAX_LINES), model.totalLines)}`
    const action = document.createElement('div')
    action.className = 'cb-action'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cb-copy'
    copy.textContent = chatLabels.copy
    action.append(copy)
    banner.append(info, action)
    bannerWrap.append(banner)
    card.append(bannerWrap)
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    const rows = model.lines.map((line) => {
      const row = document.createElement('div')
      row.className = 'read-line'
      const gutter = document.createElement('span')
      gutter.className = 'read-gutter'
      gutter.textContent = String(line.number)
      const content = document.createElement('span')
      content.className = 'read-content'
      content.textContent = line.text
      row.append(gutter, content)
      return row
    })
    const gutterWidth = `${String(model.totalLines).length + 1}ch`
    card.style.setProperty('--dsl-read-gutter', gutterWidth)
    cappedRows(code, rows, CHAT_READ_MAX_LINES)
    pre.append(code)
    card.append(pre)
    return card
  }

  function buildSearchCard(cardModel) {
    const card = document.createElement('div')
    card.className = 'search'
    const header = document.createElement('div')
    header.className = 'search-header'
    const summary = document.createElement('div')
    summary.className = 'search-summary'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'search-copy'
    copy.textContent = chatLabels.copy
    header.append(summary, copy)
    card.append(header)
    const body = document.createElement('div')
    body.className = 'search-body'
    const rows = []
    if (cardModel.kind === 'matches') {
      const shown = cardModel.files.reduce((total, file) => total + file.matches.length, 0)
      summary.textContent = chatLabels.matchesSummary(shown, cardModel.total, cardModel.files.length, cardModel.truncated)
      for (const file of cardModel.files) {
        const group = document.createElement('div')
        group.className = 'search-file-header'
        const path = document.createElement('span')
        path.className = 'search-file-path'
        path.textContent = file.path
        const count = document.createElement('span')
        count.className = 'search-file-count'
        count.textContent = String(file.matches.length)
        group.append(path, count)
        rows.push(group)
        for (const match of file.matches) {
          const line = document.createElement('div')
          line.className = 'search-line'
          const number = document.createElement('span')
          number.className = 'search-line-number'
          number.textContent = `${match.lineNumber}  `
          line.append(number)
          line.append(document.createTextNode(match.line))
          rows.push(line)
        }
      }
    } else {
      summary.textContent = chatLabels.pathsSummary(cardModel.paths.length, cardModel.total, cardModel.truncated)
      for (const path of cardModel.paths) {
        const line = document.createElement('div')
        line.className = 'search-line'
        line.textContent = path
        rows.push(line)
      }
    }
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'search-empty'
      empty.textContent = chatLabels.noResults
      card.append(empty)
      return card
    }
    cappedRows(body, rows, CHAT_SEARCH_MAX_LINES)
    card.append(body)
    return card
  }

  function linkOrText(className, url, label) {
    if (!/^https?:\/\//i.test(url)) return document.createTextNode(label)
    const link = document.createElement('a')
    link.className = className
    link.href = url
    link.textContent = label
    return link
  }

  function buildWebCard(model) {
    const card = document.createElement('div')
    card.className = 'web'
    if (model.kind === 'fetch') {
      const fetch = document.createElement('div')
      fetch.className = 'web-fetch'
      fetch.append(linkOrText('web-fetch-url', model.url, model.url))
      const meta = document.createElement('div')
      meta.className = 'web-fetch-meta'
      const status = document.createElement('span')
      status.className = 'web-status'
      status.textContent = `HTTP ${model.statusCode}`
      meta.append(status)
      if (model.truncated) {
        const truncated = document.createElement('span')
        truncated.className = 'web-truncated'
        truncated.textContent = chatLabels.contentTruncated
        meta.append(truncated)
      }
      fetch.append(url, meta)
      card.append(fetch)
      return card
    }
    if (model.answer) {
      const answer = document.createElement('div')
      answer.className = 'web-answer'
      renderMarkdownBody(answer, model.answer)
      card.append(answer)
    }
    if (model.sources.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'web-empty'
      empty.textContent = chatLabels.webNoResults
      card.append(empty)
      return card
    }
    const sources = document.createElement('ol')
    sources.className = 'web-sources'
    for (const source of model.sources) {
      const item = document.createElement('li')
      item.className = 'web-source'
      item.append(linkOrText('web-source-link', source.url, source.title !== undefined && source.title !== '' ? source.title : source.url))
      if (source.snippet !== undefined && source.snippet !== '') {
        const snippet = document.createElement('div')
        snippet.className = 'web-snippet'
        snippet.textContent = source.snippet
        item.append(snippet)
      }
      if (source.publishedAt !== undefined && source.publishedAt !== '') {
        const published = document.createElement('div')
        published.className = 'web-published'
        published.textContent = source.publishedAt
        item.append(published)
      }
      sources.append(item)
    }
    card.append(sources)
    if (model.truncated) {
      const truncated = document.createElement('div')
      truncated.className = 'web-truncated'
      truncated.textContent = chatLabels.sourcesTruncated
      card.append(truncated)
    }
    return card
  }

  function buildIoCard(inputText, outputText, isError) {
    const card = document.createElement('div')
    card.className = 'tool-io-card'
    if (inputText !== null) {
      const section = document.createElement('div')
      section.className = 'tool-io-section'
      const label = document.createElement('span')
      label.className = 'tool-io-label'
      label.textContent = chatLabels.input
      const text = document.createElement('span')
      text.className = 'tool-io-text'
      text.textContent = inputText
      section.append(label, text)
      card.append(section)
    }
    if (inputText !== null && outputText !== null) {
      const divider = document.createElement('span')
      divider.className = 'tool-io-divider'
      card.append(divider)
    }
    if (outputText !== null) {
      const section = document.createElement('div')
      section.className = 'tool-io-section'
      const label = document.createElement('span')
      label.className = 'tool-io-label'
      label.textContent = chatLabels.output
      const text = document.createElement('span')
      text.className = 'tool-io-text'
      text.textContent = outputText
      if (isError) text.setAttribute('data-error', 'true')
      section.append(label, text)
      card.append(section)
    }
    return card
  }

  function updateToolNode(node, block) {
    const detail = block.detail
    const name = block.text
    const root = node.querySelector('.tool')
    const variant = classifyTool(name)
    const state = block.running === true
      ? detail?.args ? 'running' : 'preparing'
      : detail?.isError === true ? 'error' : node.dataset.state === 'stopped' ? 'stopped' : 'ok'
    root.dataset.tool = name
    root.dataset.variant = variant
    root.dataset.state = state
    node.dataset.state = state

    node.querySelector('.visually-hidden').textContent = state === 'error' ? messages.failed
      : state === 'stopped' ? messages.stopped
        : state === 'running' || state === 'preparing' ? messages.running
          : ''

    const title = node.querySelector('.tool-title')
    title.textContent = toolTitle(name, messages === zh)
    shimmer(title, state === 'running' || state === 'preparing')

    const meta = parseMeta(detail?.meta)
    const terminal = terminalCardModel(name, detail?.args ?? '', detail?.result ? [{ type: 'text', text: detail.result }] : [])
    const read = terminal === null ? readCardModel(meta, detail?.result ? [{ type: 'text', text: detail.result }] : []) : null
    const search = read === null && terminal === null ? searchCardModel(meta) : null
    const web = search === null && read === null && terminal === null ? webCardModel(meta) : null
    const diff = terminal === null && read === null && search === null && web === null
      ? diffCardModel(name, detail?.args ?? '', detail?.isError === true, meta)
      : null

    const expandable = state !== 'preparing'
      && (Boolean(detail?.args) || Boolean(detail?.result) || terminal !== null || read !== null || search !== null || web !== null || diff !== null)
    const row = node.querySelector('.tool-row')
    root.toggleAttribute('data-expandable', expandable)
    row.toggleAttribute('data-expandable', expandable)
    if (!expandable) {
      root.removeAttribute('data-open')
      row.setAttribute('aria-expanded', 'false')
    }

    let summaryText
    if (state === 'error') {
      const first = firstLineOf(detail?.result ?? '')
      summaryText = first !== '' ? first : summaryFor(name, detail?.args ?? '')
    } else if (state === 'stopped') {
      summaryText = summaryFor(name, detail?.args ?? '')
    } else {
      summaryText = summaryFor(name, detail?.args ?? '')
    }
    const sep = node.querySelector('.tool-sep')
    const summary = node.querySelector('.tool-summary')
    const fileLink = node.querySelector('.tool-file-link')
    const suffix = node.querySelector('.tool-summary-suffix')
    const showCollapsed = summaryText !== '' && state !== 'preparing'
    sep.hidden = !showCollapsed
    summary.hidden = !showCollapsed
    summary.textContent = summaryText
    fileLink.hidden = true
    shimmer(summary, state === 'running')

    if (diff !== null && state !== 'error' && state !== 'stopped') {
      const totals = diffTotals(diff.diffs)
      suffix.hidden = false
      suffix.textContent = `+${totals.added} -${totals.removed}`
      suffix.className = 'tool-summary-suffix tool-diff-stat'
    } else {
      suffix.hidden = true
      suffix.textContent = ''
      suffix.className = 'tool-summary-suffix'
    }

    const bodyWrap = node.querySelector('.tool-body')
    bodyWrap.replaceChildren()
    if (terminal !== null) {
      bodyWrap.className = 'tool-body tool-terminal-body'
      bodyWrap.append(buildTerminalCard(terminal))
    } else if (diff !== null) {
      bodyWrap.className = 'tool-body tool-diff-body'
      bodyWrap.append(buildDiffCard(diff))
    } else if (read !== null) {
      bodyWrap.className = 'tool-body tool-read-body'
      bodyWrap.append(buildReadCard(read))
    } else if (search !== null) {
      bodyWrap.className = 'tool-body tool-search-body'
      bodyWrap.append(buildSearchCard(search.card))
      if (search.recovery !== undefined) {
        const recovery = document.createElement('div')
        recovery.className = 'tool-search-recovery'
        recovery.textContent = search.recovery
        bodyWrap.append(recovery)
      }
    } else if (web !== null) {
      bodyWrap.className = 'tool-body tool-web-body'
      bodyWrap.append(buildWebCard(web))
    } else {
      bodyWrap.className = 'tool-body'
      const input = formatToolBody(variant, detail?.args ?? '')
      const output = detail?.result ? detail.result : null
      if (input !== null || output !== null) {
        bodyWrap.append(buildIoCard(input, output, detail?.isError === true))
      }
    }
    if (processGroup !== undefined) processGroup.tools.add(name)
    refreshProcessLabel(processGroup)
  }

  function parseMeta(text) {
    if (typeof text !== 'string' || text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  function firstLineOf(text) {
    const newline = text.indexOf('\n')
    return newline === -1 ? text : text.slice(0, newline)
  }

  function summaryFor(name, argsRaw) {
    const variant = classifyTool(name)
    const base = deriveSummary(variant, argsRaw)
    if (variant !== 'others') return base
    return base === '' ? name : `${name} · ${base}`
  }

  function createToolNode(block) {
    const node = document.createElement('article')
    node.className = 'block'
    node.dataset.kind = 'tool'
    const root = document.createElement('div')
    root.className = 'tool'
    const status = document.createElement('span')
    status.className = 'visually-hidden'
    const row = document.createElement('div')
    row.className = 'tool-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    const leading = document.createElement('span')
    leading.className = 'tool-leading'
    const idle = document.createElement('span')
    idle.className = 'tool-icon-idle'
    idle.append(toolIcon(block.text))
    const hover = document.createElement('span')
    hover.className = 'tool-chevron-hover'
    hover.append(icon(CHEVRON_DOWN))
    const open = document.createElement('span')
    open.className = 'tool-chevron-open'
    open.append(icon(CHEVRON_UP))
    leading.append(idle, hover, open)
    const title = document.createElement('span')
    title.className = 'tool-title'
    const sep = document.createElement('span')
    sep.className = 'tool-sep'
    sep.setAttribute('aria-hidden', 'true')
    const summary = document.createElement('span')
    summary.className = 'tool-summary'
    const suffix = document.createElement('span')
    suffix.className = 'tool-summary-suffix'
    suffix.hidden = true
    const fileLink = document.createElement('span')
    fileLink.className = 'tool-file-link'
    fileLink.hidden = true
    row.append(leading, title, sep, summary, suffix, fileLink)
    const body = document.createElement('div')
    body.className = 'tool-body'
    root.append(status, row, body)
    node.append(root)
    const toggle = () => {
      if (root.hasAttribute('data-expandable') === false) return
      const isOpen = !root.hasAttribute('data-open')
      root.toggleAttribute('data-open', isOpen)
      row.setAttribute('aria-expanded', String(isOpen))
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
    return node
  }

  /** Per-node raw text the message copy button writes (raw markdown, as Harness). */
  const messageCopyText = new WeakMap()

  function updateAssistantNode(node, block) {
    const body = node.querySelector('.am-body')
    renderMarkdownBody(body, block.text, { live: block.running === true })
    const record = messageCopyText.get(node)
    if (record) record.text = block.text
    const actions = node.querySelector('.am-actions')
    if (actions) actions.hidden = block.running === true
    usagePill(node, block)
    const existing = node.querySelector('.am-stopped')
    if (block.interrupted === true) {
      const chip = existing ?? document.createElement('span')
      chip.className = 'am-stopped'
      chip.textContent = messages.stopped
      if (existing === null) body.append(chip)
    } else {
      existing?.remove()
    }
  }

  /**
   * 用户气泡里的图片回显（P2-4）。
   *
   * host 只推「有几张图 + 文件名」（`src/main.mjs:2007`，record 透传见 `resend`），
   * base64 本体**不进块** —— 一条 4MB base64 走 innerHTML 级渲染会把面板卡死
   * （host 侧注释写明）。所以这里用发送那一刻本地留着的 objectURL 缩略图；
   * 拿不到（历史会话重放、球重连后重推块）就退化成「图片 ×N」文字占位 ——
   * **绝不画空 src 或已 revoke 的 <img>**，那正好就是附件条那个裂图 bug。
   */
  function renderUserImages(bubble, block) {
    const count = Number(block.imageCount) || 0
    const existing = bubble.querySelector('.user-images')
    if (count <= 0) {
      existing?.remove()
      return
    }
    const names = Array.isArray(block.imageNames)
      ? block.imageNames.filter((n) => typeof n === 'string' && n !== '')
      : []
    const row = existing ?? document.createElement('div')
    row.className = 'user-images'
    row.textContent = ''
    const live = takeEchoThumbs(count)
    const cached = live === null ? imageCache.get(block.key) : undefined
    if (live !== null) {
      for (const b of live) {
        const img = document.createElement('img')
        img.src = b.thumbURL
        img.alt = typeof b.name === 'string' ? b.name : ''
        img.draggable = false
        row.append(img)
      }
    } else if (cached !== undefined) {
      appendImageThumbs(row, cached)
    } else {
      // 历史回放 / 球重连：本体不在球上 → 画**可点击**的占位，点了向 host 要原图。
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'user-image-chip'
      chip.textContent = chipLabel(block.key, count, names)
      chip.addEventListener('click', () => { requestBlockImages(block.key, count) })
      row.append(chip)
    }
    if (existing === null) bubble.append(row)
  }

  /** 占位条上的文案（加载中 / 带文件名 / 点击看原图）。 */
  function chipLabel(key, count, names) {
    if (imagePending.has(key)) return `图片 ×${count}（加载中…）`
    if (names.length > 0) return `图片 ×${count}（${names.join('、')}）`
    return `图片 ×${count}（点击看原图）`
  }

  /** 把一批 `{mimeType, dataURL}` 画成缩略图（data: URL，CSP 已放行）。 */
  function appendImageThumbs(row, images) {
    for (const it of images) {
      if (typeof it?.dataURL !== 'string' || it.dataURL === '') continue
      const img = document.createElement('img')
      img.src = it.dataURL
      img.alt = ''
      img.draggable = false
      row.append(img)
    }
  }

  /**
   * 向 host 要某个 user 块的原图（同一个块不重复请求）。
   *
   * ⚠️ 请求途中用户可能已经切走会话 → 回包时按 key 找不到节点就丢掉；
   *    但缓存**照存**：key 带会话前缀，切回来正好直接命中。
   */
  function requestBlockImages(key, count) {
    if (typeof key !== 'string' || key === '') return
    if (imageCache.has(key) || imagePending.has(key)) return
    if (typeof api.requestImages !== 'function') return
    imagePending.add(key)
    api.requestImages(key)
    const chip = blocks.get(key)?.querySelector('.user-bubble .user-image-chip')
    if (chip) chip.textContent = `图片 ×${count}（加载中…）`
  }

  /** host 回包：入缓存 + 就地替换占位；拿不到就留一个可点的占位，绝不留空白。 */
  function applyBlockImages(key, images, skipped) {
    imagePending.delete(key)
    const list = Array.isArray(images)
      ? images.filter((it) => typeof it?.dataURL === 'string' && it.dataURL !== '')
      : []
    if (list.length > 0) imageCache.set(key, list)
    const bubble = blocks.get(key)?.querySelector('.user-bubble')
    if (!bubble) return
    if (list.length === 0) {
      const chip = bubble.querySelector('.user-image-chip')
      if (chip) chip.textContent = Number(skipped) > 0 ? '图片（原图过大，未加载）' : '图片（原图没取到）'
      return
    }
    let row = bubble.querySelector('.user-images')
    if (row === null) {
      row = document.createElement('div')
      row.className = 'user-images'
      bubble.append(row)
    }
    row.textContent = ''
    appendImageThumbs(row, list)
  }

  function upsertBlock(block) {
    if (typeof block?.key !== 'string' || typeof block.text !== 'string') return
    blockData.set(block.key, block)
    let node = blocks.get(block.key)
    if (node === undefined) {
      if (block.kind === 'user') {
        node = document.createElement('div')
        node.className = 'user-row'
        node.dataset.kind = 'user'
        const bubble = document.createElement('div')
        bubble.className = 'user-bubble'
        const actions = document.createElement('div')
        actions.className = 'user-actions'
        actions.append(messageCopyButton(() => bubble.textContent ?? ''))
        node.append(bubble, actions)
      } else if (block.kind === 'assistant') {
        node = document.createElement('article')
        node.className = 'block'
        node.dataset.kind = 'assistant'
        const root = document.createElement('div')
        root.className = 'am'
        const body = document.createElement('div')
        body.className = 'am-body'
        const actions = document.createElement('div')
        actions.className = 'am-actions'
        actions.hidden = true
        const copyText = { text: '' }
        messageCopyText.set(node, copyText)
        actions.append(messageCopyButton(() => copyText.text))
        const usage = document.createElement('span')
        usage.className = 'am-usage'
        usage.hidden = true
        actions.append(usage)
        root.append(body, actions)
        node.append(root)
      } else if (block.kind === 'tool') {
        node = createToolNode(block)
      } else if (block.kind === 'notice') {
        node = document.createElement('article')
        node.className = 'block'
        node.dataset.kind = 'notice'
        createNoticeNode(node)
      } else {
        node = document.createElement('article')
        node.className = 'block'
        node.dataset.kind = 'reasoning'
        createThink(node)
      }
      blocks.set(block.key, node)
      placeBlock(node, block.kind)
    }
    if (block.kind !== 'tool') node.dataset.state = block.running ? 'running' : 'ok'
    // A folded turn keeps only the final answer visible (Harness turn-process fold).
    node.toggleAttribute('data-response', block.response === true)
    if (block.kind === 'user') {
      const bubble = node.querySelector('.user-bubble')
      // ⚠️ 顺序不能反：textContent 会清空子节点，先写文字再贴图行。
      bubble.textContent = block.text
      renderUserImages(bubble, block)
    } else if (block.kind === 'reasoning') {
      const summary = reasoningSummary(block.text, block.running === true)
      node.querySelector('.think-summary-text').textContent = summary
      const preview = node.querySelector('.think-summary')
      if (block.running) preview.setAttribute('data-streaming', 'true')
      else preview.removeAttribute('data-streaming')
      node.querySelector('.visually-hidden').textContent = block.running ? messages.running : ''
      renderMarkdownBody(node.querySelector('.think-body'), block.text, { compact: true, live: block.running === true })
      syncThinkPreview(node)
    } else if (block.kind === 'tool') {
      updateToolNode(node, block)
    } else if (block.kind === 'notice') {
      updateNoticeNode(node, block)
    } else {
      updateAssistantNode(node, block)
    }
  }

  /**
   * Transcript events apply in arrival order on one animation frame, so a turn
   * marker never lands before the blocks queued ahead of it, and the view only
   * scrolls when the reader is already at the bottom.
   */
  const staged = []
  let stagedFrame
  function stage(message) {
    staged.push(message)
    stagedFrame ??= requestAnimationFrame(() => {
      stagedFrame = undefined
      const list = staged.splice(0)
      const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120
      for (const item of list) {
        if (item.type === 'block') upsertBlock(item)
        else if (item.type === 'block-drop') removeBlock(item.key)
        else if (item.type === 'turn') setRunning(item.running === true, item.interrupted === true)
        else if (item.type === 'reset') clearTranscript()
      }
      if (nearBottom) transcript.scrollTop = transcript.scrollHeight
    })
  }

  function removeBlock(key) {
    const node = blocks.get(key)
    if (node === undefined) return
    blocks.delete(key)
    blockData.delete(key)
    node.remove()
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * 对话隐私锁（对话加密_落地方案.md）
   * ═══════════════════════════════════════════════════════════════════════
   *
   * 分工：host 决定「锁没锁、对不对」，球侧只做三件事 ——
   *   ① 历史列表里把锁定条目画成**占位行**（不露标题）；
   *   ② 被拦下打开会话 / 超时进锁时，弹**解锁卡**；
   *   ③ 把用户敲的字交给 host 比对，把 host 的话显示出来。
   *
   * ★★ 三条不能违反的约束：
   *
   *  1. **占位行绝不渲染标题。** host 推过来的 `title` 是空串（用空串而非省略字段，
   *     是为了保持 `{sessionId,title}` 契约不破）。这里也不拿任何缓存兜底 ——
   *     历史标题就是首条用户消息截出来的，漏出去等于把内容给旁边的人看。
   *
   *  2. **不用 `window.prompt`。** 这种「无边框 + 透明 + 置顶」窗口里
   *     `window.prompt` 弹不出来（实测），只能用行内 DOM。`window.confirm`
   *     能用，但它做不了密码输入框。所以解锁卡是**自绘 DOM**。
   *
   *  3. **暗号/密码原文只走内存。** 不写 dataset、不进 localStorage、
   *     不 console.log、不清空后留在闭包里超出必要时间 —— 交出去就丢。
   *
   * ⚠️ 状态存在这里而不是 host：`lockState` 只影响**这一屏怎么画**。
   *    真正的权威状态在 host（`src/lock.mjs` 的 locks.json），
   *    球侧这份是纯 UI 缓存，任何时候都可以被 host 的下一条消息纠正。
   */
  /**
   * 强锁「设密码卡」的一次性会话标记。
   *
   * ⚠️ 必须**声明在锁状态块顶部**，不能随手放在用到它的函数旁边：
   *    `setLockOpen` / `applyLock` 都是被 hoist 的函数声明，而 `let` 有 TDZ ——
   *    若 host 在 main() 执行到那行 `let` 之前就推来一条 `orb:lock`
   *    （冷启动时完全可能，socket 先连上、DOM 后装配），
   *    `applyLock → setLockOpen` 会读到处于 TDZ 的绑定 → **ReferenceError**。
   *    这类「主进程回调里 ReferenceError 掐断整条 IPC」在本项目已经踩过一次
   *    （`diag()` 未定义那次），症状同样是「点了没反应、日志零异常」。
   */
  let lockSetupSessionId = ''
  let lockState = {
    /** 'unlocked' | 'locked' */
    state: 'unlocked',
    /** 'soft' | 'strong' */
    kind: 'soft',
    /** 强锁时是哪条会话（软锁为 ''） */
    convId: '',
    /** 还能试几次 */
    attemptsLeft: 0,
    /** 有没有约过暗号 —— 没有就别让人对着空框输字 */
    hasAgreement: false,
    /** 解锁成功后要补开的会话（host 也会补，这里只用来画过渡态） */
    pendingOpen: '',
  }

  /** 小锁图标（内联 SVG，跟着 currentColor 走，暗亮主题都合适）。 */
  function lockIcon() {
    const span = document.createElement('span')
    span.className = 'lock-icon'
    span.setAttribute('aria-hidden', 'true')
    // 锁体 + 锁梁。描边继承 currentColor，不写死颜色。
    span.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none">' +
      '<rect x="3.25" y="7" width="9.5" height="6.5" rx="1.6" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
      '</svg>'
    return span
  }

  /**
   * 解锁卡的显示状态计算 —— 收口到一个函数，别在四处各拼一份条件。
   *
   * ⚠️ 这里体现的是「没有可用的考验，就不能把人挡在门外」：
   *    软锁生效但**还没约暗号**时，host 侧其实不会主动上锁（lock-flow 的
   *    startIdleWatch 有明确闸门）；但用户仍可能手动 `lock-now` 或通过
   *    其它路径进来。真到了这一步，唯一的正解是**如实告诉他现在对不了**，
   *    并给一条出路，而不是给一个永远打不开的输入框。
   */
  function lockView() {
    const strong = lockState.kind === 'strong'
    const noAgreement = !strong && lockState.hasAgreement !== true
    return {
      strong,
      noAgreement,
      eyebrow: strong ? messages.lockEyebrowStrong : messages.lockEyebrowSoft,
      title: strong ? messages.lockTitleStrong : messages.lockTitleSoft,
      detail: noAgreement
        ? messages.lockDetailNoAgreement
        : (strong ? messages.lockDetailStrong : messages.lockDetailSoft),
      placeholder: strong ? messages.lockPlaceholderStrong : messages.lockPlaceholderSoft,
      hint: noAgreement
        ? messages.lockHintNoAgreement
        : (strong ? messages.lockHintStrong : messages.lockHintAgreement),
      // 没暗号可对 → 输入区禁用（CSS 按 data-armed 变灰）
      armed: strong || !noAgreement,
    }
  }

  function renderLockCard() {
    if (lockGate === null) return
    const view = lockView()
    if (lockEyebrow) lockEyebrow.textContent = view.eyebrow
    if (lockTitle) lockTitle.textContent = view.title
    if (lockDetail) lockDetail.textContent = view.detail
    if (lockHint) lockHint.textContent = view.hint
    if (lockInput) {
      lockInput.placeholder = view.placeholder
      lockInput.disabled = !view.armed
    }
    if (lockSubmit) {
      lockSubmit.textContent = messages.lockSubmit
      lockSubmit.disabled = !view.armed
    }
    if (lockClose) {
      lockClose.textContent = '✕'
      lockClose.title = messages.lockClose
      lockClose.setAttribute('aria-label', messages.lockClose)
    }
    // 强锁才有逃生通道（导出对话）
    if (lockExport) {
      lockExport.hidden = !view.strong
      lockExport.textContent = messages.lockExport
    }
    if (lockCard) lockCard.dataset.armed = String(view.armed)
    lockGate.dataset.kind = lockState.kind
    lockGate.hidden = false
  }

  function setLockFeedback(text, ok) {
    if (lockFeedback === null) return
    const t = typeof text === 'string' ? text : ''
    if (t === '') {
      lockFeedback.hidden = true
      lockFeedback.textContent = ''
      return
    }
    lockFeedback.hidden = false
    lockFeedback.textContent = t
    lockFeedback.dataset.ok = String(ok === true)
  }

  function setLockOpen(next) {
    if (lockGate === null) return
    lockGate.hidden = !next
    if (!next) {
      setLockFeedback('', null)
      // ⚠️ 关卡片时**必须**清掉设置卡的一次性标记。否则下一次点「解锁」
      //    会走进 submitPasswordSetup，把暗号当成新密码交出去 ——
      //    症状是「输暗号没反应，反而把密码改了」。这类「一次性变量忘了清」
      //    在本项目已经栽过（重命名编辑态、pendingSchedulePick），一律在收口处清。
      lockSetupSessionId = ''
      if (lockInput) lockInput.value = ''
      return
    }
    renderLockCard()
    // 焦点给输入框 —— 键盘用户不必先 Tab 一圈
    const view = lockView()
    if (view.armed) lockInput?.focus()
  }

  /**
   * host 推来的锁定态变更（`orb:lock`）。
   *
   * 三种到达场景：
   *   - 超时软锁到点 → kind:soft，球**主动**收到（没有任何用户动作触发）
   *   - 点开挂了强锁的会话 → kind:strong + convId
   *   - 解锁成功 → state:unlocked，把卡片收掉
   */
  function applyLock(payload) {
    if (payload === null || typeof payload !== 'object') return
    const state = payload.state === 'locked' ? 'locked' : 'unlocked'
    lockState = {
      state,
      kind: payload.kind === 'strong' ? 'strong' : 'soft',
      convId: typeof payload.convId === 'string' ? payload.convId : '',
      attemptsLeft: typeof payload.attemptsLeft === 'number' ? payload.attemptsLeft : 0,
      hasAgreement: payload.hasAgreement === true,
      pendingOpen: lockState.pendingOpen,
    }
    if (state === 'unlocked') {
      setLockOpen(false)
      if (lockInput) lockInput.value = ''
      return
    }
    // 进了锁：历史抽屉要先让位，否则两层 UI 叠在一起
    setHistoryOpen(false)
    setLockOpen(true)
    // 锁定态下把已有列表就地重画一次 —— 不等 host 的 sendHistory 回包，
    // 减少「先看到一秒标题再被盖上」的窗口（那一眼就是泄密）。
    if (historyItems.length > 0) renderHistory()
  }

  /** host 对一次解锁尝试的裁定。 */
  function applyLockFeedback(payload) {
    if (payload === null || typeof payload !== 'object') return
    const ok = payload.ok === true
    const left = typeof payload.attemptsLeft === 'number' ? payload.attemptsLeft : 0
    // host 给了话就用它（那句「我希望你是一个诚实的人…」是她说的，不该被改写）；
    // 没给就本地拼一句「还剩 N 次」。
    const text = typeof payload.message === 'string' && payload.message !== ''
      ? payload.message
      : (ok ? '' : messages.lockAttemptsLeft(left))
    setLockFeedback(text, ok)
    if (!ok && lockInput) {
      // 清空重来，但**保留焦点** —— 让人能直接接着敲
      lockInput.value = ''
      lockInput.focus()
    }
  }

  function submitLock() {
    if (lockInput === null || lockInput.disabled) return
    // 设置卡与解锁卡共用同一个输入框和按钮，靠这个一次性变量分流。
    // 顺序：先判它，再判解锁 —— 否则设密码时会走成「提交一次解锁尝试」。
    if (lockSetupSessionId !== '') {
      submitPasswordSetup()
      return
    }
    const value = lockInput.value
    if (value.trim() === '') return
    // 原文交出去，本地不留：不再读第二次、不缓存
    api.unlock(value, lockState.convId || undefined)
    lockInput.value = ''
    setLockFeedback('', null)
  }

  /** 把锁定条目画成占位行 —— 与普通行同构（都是 `<button class="history-row">`）。 */
  function renderLockedRow(button, item) {
    button.classList.add('locked')
    button.dataset.lockKind = item.kind === 'strong' ? 'strong' : 'soft'
    // ⚠️ locked 的行**不设** textContent 之外的任何标题来源。
    //    dataset.sessionId 保留 —— 右键菜单要靠它定位。
    button.replaceChildren()
    const label = document.createElement('span')
    label.className = 'lock-label'
    label.textContent = messages.lockRowLabel
    button.append(lockIcon(), label)
  }

  function renderHistory() {
    // 正在行内重命名时**不要重画** —— 会把用户正在打的字冲掉。
    // 提交/取消时 renamingSessionId 会先被清空，所以不会卡住。
    if (renamingSessionId !== '') return
    historyList.replaceChildren()
    if (historyItems.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'history-empty'
      empty.textContent = messages.historyEmpty
      historyList.append(empty)
      return
    }
    for (const item of historyItems) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = item.sessionId === sessionId ? 'history-row current' : 'history-row'
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(item.sessionId === sessionId))
      // 对话级菜单靠这两个dataset 定位：右键哪一条、是不是锁着的
      button.dataset.sessionId = item.sessionId
      button.dataset.locked = String(item.locked === true)
      if (item.locked === true) {
        // 锁定态：画占位行（小锁 + 「已锁定的对话」），**绝不渲染 title**。
        // host 的 maskHistory() 已经把 title 抹成空串，这里也不拿旧值兜底 ——
        // 历史标题是首条用户消息截出来的，露出来就是泄密。
        renderLockedRow(button, item)
      } else {
        const title = typeof item.title === 'string' && item.title !== '' ? item.title : messages.untitled
        if (item.kind === 'wechat' || item.kind === 'impression') {
          // ★ 内部辅助会话（微信桥 / 印象整理）不再从抽屉里删掉 —— 删掉会让用户当天
          //   在微信里下派的工作凭空消失。改成前缀一枚小标，点进去照样看全文。
          const badge = document.createElement('span')
          badge.className = 'history-kind'
          badge.textContent = item.kind === 'wechat' ? '微信' : '内部'
          button.append(badge, document.createTextNode(title))
        } else {
          button.textContent = title
        }
      }
      button.addEventListener('click', () => {
        setHistoryOpen(false)
        if (item.sessionId !== sessionId) api.openSession(item.sessionId)
      })
      historyList.append(button)
    }
  }

  function clearTranscript() {
    stopProcessClock()
    processGroup = undefined
    blocks.clear()
    blockData.clear()
    transcript.replaceChildren()
    // 已交接给对话流的缩略图 objectURL 到这里才回收 —— 必须在 replaceChildren 之后
    // （节点先没了，再 revoke 才算干净；顺序反了会先砸掉还没卸载的 <img>）。
    disposeLiveThumbs()
    // 切会话把没发出去的附件一起丢掉 —— 否则用户切到另一条对话，
    // 图还挂在输入框上，发出去就是「这条会话里凭空出现一张上一会话的图」。
    clearAttachments()
    // 同时清空 reasoning-lane 里的思考过程/工具调用节点（保留 status）
    const lane = document.querySelector('#reasoning-lane')
    if (lane) {
      const status = lane.querySelector('#status')
      lane.replaceChildren(status || document.createDocumentFragment())
    }
    pending = undefined
    syncQuestion()
  }

  function setHistoryOpen(next) {
    // ★★★ 2026-10-08 第三轮修复：**开历史时也要踢掉另外三个抽屉**。
    //
    //   这块原来是不对称的，三个抽屉各有一句 `setExclusiveOpen('xxx')`
    //   在打开时把**历史**关掉（见上面 :632/:655/:689 的四个回调），
    //   但反方向**根本没有** —— `setExclusiveOpen` 里压根没有 `'history'` 这个 case。
    //   于是「历史 → 抽屉」走得通，「抽屉 → 历史」走不通：
    //   谁都不关谁，两个页面就叠在一起。
    //
    //   用户报的正是这条：**在 API 配置页点「历史会话」→ 历史列表压在 API 配置上**
    //   （截图里上半是历史、下半是 API 配置）。
    //   为什么不是每次都叠？因为 `handleMenuAction('history')` 里有一句手写的
    //   补丁（:3919）替它关了兄弟抽屉 —— 而**左下角的历史按钮**（:3474）
    //   和别的调用点都直接调本函数，全都没有那句，于是漏。
    //   （典型的「补丁打在调用点而不是函数里」，和隐藏球文案那个 bug 同源。）
    //
    //   修法：把互斥**收进 setHistoryOpen 自己**，所有调用点自动都对。
    //   顺序照三条纪律来：**先互斥（关别人）、后记账（改自己）** ——
    //   反过来的话，互斥回调里那句 `setHistoryOpen(false)` 会把刚开的自己关掉。
    if (next) {
      impressionPanel?.setOpen(false)
      apiConfigPanel?.setOpen(false)
      themePanel?.setOpen(false)
      biliHistoryPanel?.setOpen(false)
    }
    historyOpen = next
    historyList.hidden = !historyOpen
    historyButton.setAttribute('aria-pressed', String(historyOpen))
    // 历史面板打开时，隐藏底层的输入框和装饰区域（deco-lane），
    // 避免它们从历史面板上方露出来。
    document.body.classList.toggle('history-open', historyOpen)
    // ★ 关历史面板时把记忆中心也一起关掉。
    //   抽屉类视图有五处`setHistoryOpen(false)`（点会话、收到提问、发消息、
    //   切会话、开关面板），逐个补一句 `impressionPanel.setOpen(false)`
    //   迟早漏一处 —— 漏了那次就是「两个抽屉叠在一起」。
    //   现在开/关两个方向都在这里收口了（开：上面的 if (next)；关：下面这三句）。
    if (!historyOpen) impressionPanel?.setOpen(false)
    // API 配置抽屉同理：它和记忆中心一样是「平地起的一页」，不许和历史叠着。
    if (!historyOpen) apiConfigPanel?.setOpen(false)
    // 主题抽屉同理（它也是「平地起的一页」）。
    if (!historyOpen) themePanel?.setOpen(false)
    // 「看过的视频」同理。
    if (!historyOpen) biliHistoryPanel?.setOpen(false)
    // ★ 打开历史抽屉时把解锁卡让开（同一时刻只开一个抽屉）。
    //   反向由 applyLock() 负责：进锁时先 setHistoryOpen(false)。
    //   这两边都写、且都只写「关」，所以不会互相打架成死循环。
    if (historyOpen) setLockOpen(false)
    if (historyOpen) {
      renderHistory()
      api.requestHistory()
      setPermissionOpen(false)
    }
    syncQuestion()
  }

  function setPermissionOpen(next) {
    permissionOpen = next
    permissionMenu.hidden = !permissionOpen
    permissionButton.setAttribute('aria-expanded', String(permissionOpen))
  }

  /**
   * 收起面板时把所有抽屉复位成「默认只显示对话流」（用户 m01036 的 ④）。
   *
   * 只做「关」不做「开」：不碰 `pinned`、不碰窗口尺寸，
   * 所以不会和 `setHistoryOpen()` / `impressionPanel.setOpen()` 里的互斥分支打架。
   */
  function resetDrawers() {
    if (historyOpen) setHistoryOpen(false)
    if (impressionPanel?.isOpen()) impressionPanel.setOpen(false)
    if (apiConfigPanel?.isOpen()) apiConfigPanel.setOpen(false)
    if (themePanel?.isOpen()) themePanel.setOpen(false)
    if (biliHistoryPanel?.isOpen()) biliHistoryPanel.setOpen(false)
    setPermissionOpen(false)
  }

  function renderPermission() {
    permissionLabel.textContent = permissionText(permission)
    for (const option of permissionMenu.querySelectorAll('button')) {
      option.setAttribute('aria-selected', String(option.dataset.preset === permission))
    }
  }

  function syncContinue() {
    const draft = pending.drafts[pending.index]
    questionContinue.textContent = pending.index === pending.questions.length - 1
      ? messages.submit
      : messages.next
    questionContinue.disabled = pending.busy || !draftAnswered(draft)
    questionSkip.disabled = pending.busy
    questionCancel.disabled = pending.busy
    questionPrev.disabled = pending.busy || pending.index === 0
    questionNextNav.disabled = pending.busy || pending.index === pending.questions.length - 1
    questionCustom.disabled = pending.busy
    questionCustom.hidden = false
    questionCustom.placeholder = messages.custom
    if (document.activeElement !== questionCustom) questionCustom.value = draft.custom
  }

  function renderQuestion() {
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    const hasHeader = typeof item.header === 'string' && item.header !== ''
    questionEyebrow.hidden = !hasHeader
    questionEyebrow.textContent = hasHeader ? item.header : ''
    questionTitle.textContent = item.question
    const hasDetail = typeof item.detail === 'string' && item.detail !== ''
    questionDetail.hidden = !hasDetail
    questionDetail.textContent = hasDetail ? item.detail : ''
    questionOptions.replaceChildren()
    const options = item.options ?? []
    questionOptions.setAttribute('role', item.multiSelect === true ? 'group' : 'radiogroup')
    for (const [optionIndex, option] of options.entries()) {
      const selected = draft.selected.includes(option.label)
      const display = parseRecommendedLabel(option.label)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = selected ? 'question-option selected' : 'question-option'
      button.setAttribute('role', item.multiSelect === true ? 'checkbox' : 'radio')
      button.setAttribute('aria-checked', String(selected))
      button.disabled = pending.busy
      const mark = document.createElement('span')
      mark.className = 'question-option-mark'
      mark.textContent = item.multiSelect === true ? (selected ? '\u2713' : '') : String(optionIndex + 1)
      const copy = document.createElement('span')
      copy.className = 'question-option-copy'
      const label = document.createElement('span')
      label.className = 'question-option-label'
      label.textContent = display.label
      copy.append(label)
      if (display.recommended) {
        const badge = document.createElement('span')
        badge.className = 'question-recommended'
        badge.textContent = messages.recommended
        copy.append(badge)
      }
      if (typeof option.description === 'string' && option.description !== '') {
        const description = document.createElement('span')
        description.className = 'question-option-description'
        description.textContent = option.description
        copy.append(description)
      }
      button.append(mark, copy)
      button.addEventListener('click', () => { chooseOption(option.label) })
      questionOptions.append(button)
    }
    questionPager.hidden = pending.questions.length <= 1
    questionProgress.textContent = `${String(pending.index + 1)} / ${String(pending.questions.length)}`
    const hasError = typeof pending.error === 'string' && pending.error !== ''
    questionError.hidden = !hasError
    questionError.textContent = hasError ? pending.error : ''
    syncContinue()
  }

  function syncQuestion() {
    // ★ 抽屉不止历史面板一个。`#transcript`、`#history-list`、`#impression`
    //   三者是**兄弟节点**（CSS 里各自 absolute/flex 定位），同开就分屏。
    //   这里统一按「有没有抽屉开着」判断，别再只写 `historyOpen` ——
    //   漏一个就是「记忆中心打开时底下还露着对话文字」。
    const drawerOpen = historyOpen || impressionPanel.isOpen() || apiConfigPanel?.isOpen() === true
      || themePanel?.isOpen() === true
      || biliHistoryPanel?.isOpen() === true
    const showCard = pending !== undefined && !drawerOpen
    document.body.classList.toggle('asking', pending !== undefined)
    questionRoot.hidden = !showCard
    transcript.hidden = drawerOpen
    // ★ 背景层跟着**当前视图**切换（用户 m02033：三个页面各自一张背景图）。
    //   放在这里是因为「谁是当前视图」只有这一处收口：
    //   历史抽屉 → history 槽；我们的回忆 → recall 槽；其余（对话页、
    //   API 配置、主题、锁卡、提问卡）→ chat 槽。
    backgrounds.setView(
      historyOpen ? 'history'
        : impressionPanel.isOpen() ? 'recall'
          : 'chat',
    )
    if (showCard) renderQuestion()
    syncGif()
  }

  function chooseOption(label) {
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    if (item.multiSelect === true) {
      draft.selected = draft.selected.includes(label)
        ? draft.selected.filter((entry) => entry !== label)
        : [...draft.selected, label]
    } else {
      draft.selected = [label]
      draft.custom = ''
      if (pending.index < pending.questions.length - 1) pending.index += 1
    }
    draft.skipped = false
    pending.error = undefined
    renderQuestion()
  }

  function submitPending() {
    const missing = pending.drafts.findIndex((draft) => !draftCompleted(draft))
    if (missing >= 0) {
      pending.index = missing
      pending.error = messages.incomplete
      renderQuestion()
      return
    }
    pending.busy = true
    pending.error = undefined
    renderQuestion()
    api.answerQuestion(pending.id, buildAnswer(pending.questions, pending.drafts).answers)
  }

  function continueFlow() {
    if (pending === undefined || pending.busy) return
    const draft = pending.drafts[pending.index]
    if (!draftAnswered(draft)) {
      pending.error = messages.unanswered
      renderQuestion()
      return
    }
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      pending.error = undefined
      renderQuestion()
      return
    }
    submitPending()
  }

  function skipQuestion() {
    if (pending === undefined || pending.busy) return
    pending.drafts[pending.index] = { selected: [], custom: '', skipped: true }
    pending.error = undefined
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      renderQuestion()
      return
    }
    submitPending()
  }

  function cancelQuestion() {
    if (pending === undefined || pending.busy) return
    pending.busy = true
    pending.error = undefined
    renderQuestion()
    api.cancelQuestion(pending.id)
  }

  function showQuestion(payload) {
    if (!payload || typeof payload.id !== 'string' || !Array.isArray(payload.questions) || payload.questions.length === 0) return
    if (pending?.id === payload.id) {
      syncQuestion()
      return
    }
    pending = { id: payload.id, questions: payload.questions, drafts: emptyDrafts(payload.questions), index: 0, busy: false }
    setHistoryOpen(false)
    syncQuestion()
    void setExpanded(true)
  }

  function clearQuestion(id) {
    if (pending === undefined || pending.id !== id) return
    pending = undefined
    syncQuestion()
  }

  function isPrimaryButton(event) {
    return event.button === 0
  }

  function primaryButtonHeld(event) {
    return (event.buttons & 1) === 1
  }

  // ★ 2026-10-07 夜（用户 m00827 §2）：**悬停不再展开面板**。
  //   面板只由「左键点球」打开，右键只开环菜单，两者互斥 —— 悬停展开会跟右键开菜单
  //   抢同一块区域：鼠标往球上一挪面板就自己出来，右键那一刻又得先收回去。
  document.body.addEventListener('pointerenter', () => {
    dockPointerInside = true
    if (dragging || collapsing) return
    if (docked === undefined) return
    if (dockHoverArmed) void unsnapDocked()
  })
  document.body.addEventListener('pointerleave', () => {
    dockPointerInside = false
    suppressExpand = false
    if (dragging || collapsing) return
    scheduleCollapse()
  })

  ball.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
    collapsing = false
    skipClick = false
    lastOrigin = undefined
    pointer = { ...ballGrabOffset(event), startX: event.screenX, startY: event.screenY }
    ball.setPointerCapture(event.pointerId)
  })
  ball.addEventListener('pointermove', (event) => {
    if (pointer === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
    if (!dragging) {
      if (Math.hypot(event.screenX - pointer.startX, event.screenY - pointer.startY) <= 4) return
      dragging = true
      if (running || asking()) {
        void moveBall(lastOrigin.x, lastOrigin.y)
        return
      }
      collapsing = true
      pinned = false
      document.body.classList.remove('pinned')
      void setExpanded(false, true).then(() => {
        collapsing = false
        if (dragging && lastOrigin !== undefined) void moveBall(lastOrigin.x, lastOrigin.y)
      })
      return
    }
    if (!collapsing) void moveBall(lastOrigin.x, lastOrigin.y)
  })
  async function finishPointer(event) {
    if (dragging) {
      skipClick = true
      dragging = false
      collapsing = false
      const origin = pointer === undefined
        ? lastOrigin
        : { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
      pointer = undefined
      lastOrigin = undefined
      const skipDock = skipDockCommit
      skipDockCommit = false
      if (!skipDock) {
        if (origin !== undefined) await moveBall(origin.x, origin.y)
        await clampBall()
      }
      return true
    }
    pointer = undefined
    lastOrigin = undefined
    return false
  }
  ball.addEventListener('pointerup', async (event) => {
    if (!isPrimaryButton(event)) {
      void finishPointer(event)
      return
    }
    const dragged = await finishPointer(event)
    if (dragged || skipClick) {
      skipClick = false
      return
    }
    await togglePanel()
  })
  ball.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  ball.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

  // 环形菜单（独立窗口）：右键球体开/关，菜单项点击通过 IPC 回传。
  //
  // ★ 顺序是硬要求：收起面板会**改变窗口尺寸与球的位置**，
  //   必须等它落定再读球心坐标。旧实现写的是 `void setExpanded(false, true)`，
  //   于是主进程同步收缩到 96×96、而这里仍按收缩前的坐标算球心 ——
  //   实测菜单窗口落在 left:537px、整个跑到 96×96 视口之外（勘察报告 C1）。
  ball.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    // ★ 必须 stopPropagation：createContextMenu 在 document 上也挂了 contextmenu，
    //   不拦住的话「球上右键」会被处理两次 —— 环菜单刚开就被第二次 toggle 关掉。
    event.stopPropagation()
    void toggleRingMenu()
  })

  /**
   * 面板与环菜单**互斥**（用户 m00827 §2）：
   *   左键点球 → 面板开/关；右键点球 → 环菜单开/关；开一个必收另一个。
   * 状态以主进程的 `orb:ring-state` 广播为准（菜单也会因光标离开环带自己关掉，
   * 只在本侧记账必然漂移）。
   */
  async function toggleRingMenu() {
    if (ringOpen) {
      if (typeof api.ringClose === 'function') api.ringClose()
      ringOpen = false
      return
    }
    if (expanded) {
      pinned = false
      document.body.classList.remove('pinned')
      await setExpanded(false, true)
    }
    if (typeof api.ringOpen !== 'function') return
    const rect = ball.getBoundingClientRect()
    api.ringOpen(rect.left + rect.width / 2, rect.top + rect.height / 2, ringItems())
    ringOpen = true
  }

  /**
   * 左键点球：**钉住面板 / 取消钉住**（用户 m01764 要求把「点一下钉住」还回来）。
   *
   * ★★ 为什么必须钉住，而不是「开完就算」：
   *   `scheduleCollapse()`（见上面 :909）的闸门是
   *   `if (pinned || running || asking() || dragging) return` ——
   *   **只有钉住挡得住「指针离开窗口 180ms 后面板自己收」**（COLLAPSE_MS=180）。
   *   而缩放手柄铺在面板**外侧**那圈透明 chrome 上（`resize-handles.js` 的 geometry()），
   *   用户伸手去拖边缘时只要越界一瞬，面板就先自己没了 —— 表现就是
   *   「拖动边缘放大缩小的功能没了」。两个症状同一个根因。
   *
   * 语义与原始版一致（`probe/_ui-bak-20261007-220204/assets/shell.js:2754-2756`：
   * `pinned = !pinned; classList.toggle('pinned', pinned); if (pinned) await setExpanded(true)`）：
   *   未钉住 → 钉住 + 展开；已钉住 → 取消钉住并收起。
   *   （原始版第二次点击只取消钉住、不收起；这里连收起一起做 —— 「左键是开/关」
   *    是用户 m00827 定的语义，恢复钉住不该把它丢掉。）
   *
   * 与右键环菜单仍然互斥：`setExpanded(true)` 开头会 `api.ringClose()`。
   */
  async function togglePanel() {
    if (ringOpen) {
      if (typeof api.ringClose === 'function') api.ringClose()
      ringOpen = false
    }
    if (expanded) {
      pinned = false
      document.body.classList.remove('pinned')
      await setExpanded(false, true)
      return
    }
    // ★ 先钉住再展开：这样 `setExpanded(true)` 里那句 `applyDocked(undefined)`／
    //   后续任何 `scheduleCollapse()` 都已经被闸门挡住，没有中间态会被收掉。
    pinned = true
    document.body.classList.add('pinned')
    await setExpanded(true)
  }

  // 悬停展开取消后，拖文件到球上是唯一还需要「自己展开」的入口 —— 补上。
  // 不补的话：窗口仍是 96×96、#panel 的 composer 还没显示，文件无处可落。
  document.addEventListener('dragenter', () => {
    if (!expanded) void setExpanded(true)
  })

  /**
   * 环形菜单项：球级功能 + 新建对话 + 隐藏悬浮球。
   * 菜单项清单**只在这里有一份**（`ballMenuItems()` 是旧右键菜单的同一份源头），
   * 环菜单窗口只负责画，不复制清单 —— 抄两份必然漂移。
   * 参考图里的齿轮/播放/连衣裙/闹钟/点心/面具在 orb 没有对应功能，一律不放。
   *
   * ★ 2026-10-08：`ball-hide` 只加在**环菜单**，不加进 `ballMenuItems()`。
   *   因为 `ballMenuItems()` 同时喂**原生右键菜单**，而那一份已经有「隐藏悬浮球」了
   *   （见 main.js 的 contextMenuTemplate）。加进去会变成同一菜单里出现两次。
   *   环菜单此前**完全没有**隐藏入口 —— 用户「右键球体没找到隐藏悬浮球」，
   *   找的很可能就是这个（他截图里展开的正是环菜单）。
   */
  function ringItems() {
    const base = ballMenuItems()
    const last = base.pop()
    return [
      ...base,
      { id: 'new-chat', label: messages.fresh },
      { id: 'ball-hide', label: messages.menuHideBall },
      last,
    ]
  }

  // 环形菜单菜单项点击回传：复用 handleMenuAction
  if (api.onRingAction) {
    api.onRingAction((id) => {
      void runRingAction(id)
    })
  }

  /**
   * 环菜单是**球态**下打开的（打开前已经收起了面板），而更换样式/我们的回忆/
   * 历史对话/新建对话的目的地全在 #panel 里 —— 不先展开面板，用户点了什么都不会发生
   * （勘察报告 C6：旧实现 4 项里有 3 项的归宿在刚被 hidden 的 #panel 内）。
   *
   * ★ 例外：`ball-hide` **根本不会走到这里** —— 主进程在 orb:ring-action 里
   *   就把它截下来直接 hideBall() 了，不回传球窗口。
   *   理由：隐藏要的是「球别挡着我」，先 setExpanded(true) 展开面板等于反着来。
   *   这里的兜底分支只是防御性写法，万一哪天那条截流被改掉了，
   *   也不会出现「点隐藏却弹出面板」这种荒诞行为。
   */
  async function runRingAction(id) {
    if (id === 'ball-hide') return
    if (!expanded) await setExpanded(true)
    handleMenuAction(id)
  }

  // ESC 收起环菜单。环菜单窗口是 focusable:false（刻意不抢键盘焦点，
  // 否则会打断正在输入框里打字的用户），所以 ESC 只能在球窗口这侧收下来；
  // 主进程的 orb:ring-close 同时接受球窗口发来的关闭请求。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    // 环菜单优先（它正盖在球上，用户的注意力在那儿）
    if (ringOpen) {
      if (typeof api.ringClose === 'function') api.ringClose()
      ringOpen = false
      return
    }
    // 面板也能用 ESC 收：左键点球现在是「钉住/取消钉住」，走 togglePanel 只会取消钉住
    // （面板还留在屏幕上），而 ESC 的语义是**收起来** —— 所以这里显式清掉钉住再强制收起
    // （`force` 才绕得过 setExpanded 里那道 `pinned` 闸门）。
    if (expanded) {
      pinned = false
      document.body.classList.remove('pinned')
      void setExpanded(false, true)
    }
  })

  // 面板毛玻璃透明度：环菜单外侧圆环拖动 → 主进程夹取并落盘 → 推回来即时生效。
  // 不落盘的话重启就回到 CSS 默认值 —— 旧实现被那段写死的 0.76 冲掉的正是它。
  if (typeof api.onPanelOpacity === 'function') {
    api.onPanelOpacity((value) => {
      const opacity = Number(value)
      if (!Number.isFinite(opacity)) return
      document.documentElement.style.setProperty('--panel-opacity', String(opacity))
    })
  }

  // 环菜单开/关状态由主进程广播（含「光标离开环带自动关」这条路径），
  // 左右键互斥的判断靠它保持准确。
  if (typeof api.onRingState === 'function') {
    api.onRingState((open) => {
      ringOpen = open === true
    })
  }

  dockTab.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
    collapsing = false
    skipClick = true
    lastOrigin = undefined
    pointer = { dx: 0, dy: 0, startX: event.screenX, startY: event.screenY }
    dockTab.setPointerCapture(event.pointerId)
  })
  dockTab.addEventListener('pointermove', (event) => {
    if (pointer === undefined || docked === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX, y: event.screenY }
    const inward = docked === 'right' ? pointer.startX - event.screenX : event.screenX - pointer.startX
    if (inward <= DOCK_DRAG_OFF_PX) return
    dragging = true
    void unsnapDocked()
  })
  dockTab.addEventListener('pointerup', (event) => { void finishPointer(event) })
  dockTab.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  dockTab.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

  const selectionChip = document.querySelector('#selection-chip')
  const selectionChipText = document.querySelector('#selection-chip-text')
  const selectionChipDismiss = document.querySelector('#selection-chip-dismiss')
  selectionChipDismiss.textContent = '\u00d7'
  const tccGate = document.querySelector('#tcc-gate')
  const tccDismiss = document.querySelector('#tcc-dismiss')
  const tccTitle = document.querySelector('#tcc-title')
  const tccApp = document.querySelector('#tcc-app')
  const tccScreenStatus = document.querySelector('#tcc-screen-status')
  const tccScreenOpen = document.querySelector('#tcc-screen-open')
  const tccAccessibilityStatus = document.querySelector('#tcc-accessibility-status')
  const tccAccessibilityOpen = document.querySelector('#tcc-accessibility-open')
  const tccFooter = document.querySelector('#tcc-footer')
  const tccLater = document.querySelector('#tcc-later')
  tccDismiss.textContent = '\u00d7'
  document.querySelector('#tcc-relaunch').hidden = true

  function setAttachedSelection(text) {
    attachedSelection = text
    const show = text !== ''
    selectionChip.hidden = !show
    document.body.classList.toggle('has-selection-chip', show)
    selectionChipText.textContent = text
    syncGif()
  }

  function tccReady(tccStatus) {
    return tccStatus == null || tccStatus.applicable === false
      || (tccStatus.screen === 'granted' && tccStatus.accessibility === 'granted')
  }

  function tccStatusLabel(state) {
    if (state === 'granted') return messages.tccStatusGranted
    if (state === 'needsRelaunch') return messages.tccStatusNeedsRelaunch
    return messages.tccStatusMissing
  }

  function hideTccGate() {
    tccGateVisible = false
    tccGate.hidden = true
    document.body.classList.remove('tcc-gating')
    syncGif()
  }

  function showTccGate(tccStatus) {
    tccGateVisible = true
    lastTccStatus = tccStatus
    const name = typeof tccStatus.appName === 'string' ? tccStatus.appName : ''
    tccApp.textContent = messages.tccAppHint.replaceAll('{name}', name)
    tccFooter.textContent = messages.tccFooter.replaceAll('{name}', name)
    tccScreenStatus.textContent = tccStatusLabel(tccStatus.screen)
    tccAccessibilityStatus.textContent = tccStatusLabel(tccStatus.accessibility)
    tccScreenOpen.hidden = tccStatus.screen === 'granted'
    tccAccessibilityOpen.hidden = tccStatus.accessibility === 'granted'
    tccGate.hidden = false
    document.body.classList.add('tcc-gating')
    syncGif()
  }

  async function refreshTccGate(options = {}) {
    if (typeof api.tccStatus !== 'function') return true
    let tccStatus
    try {
      tccStatus = await api.tccStatus()
    } catch {
      return true
    }
    if (tccReady(tccStatus)) {
      hideTccGate()
      return true
    }
    if (options.forceShow || tccGateVisible) showTccGate(tccStatus)
    return false
  }

  async function openTccRight(right) {
    if (typeof api.openTcc !== 'function') return
    let tccStatus
    try {
      tccStatus = await api.openTcc(right)
    } catch {
      return
    }
    if (tccReady(tccStatus)) hideTccGate()
    else showTccGate(tccStatus)
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitComposer()
  })
  async function submitComposer() {
    const text = promptText(prompt).trim()
    const pending = attachments.some((a) => a.busy)
    // ★ 纯图无字是合法消息（拖张图就发）。旧版 `text === ''` 直接 return，
    //   会把「只发图」静默吞掉 —— 用户看到的是「点了发送但什么都没发生」。
    if (text === '' && attachments.length === 0) return
    if (pending) {
      // 图还在压，发出去只有半个附件。明确挡住比悄悄发半截好。
      flashStatus('图片还在处理中，稍等一下')
      return
    }
    if (text.length > PROMPT_LIMIT) {
      status.textContent = messages.tooLong
      return
    }
    const ready = await refreshTccGate({ forceShow: true })
    if (!ready) {
      await setExpanded(true)
      return
    }
    // ★ base64 在这一刻才读（WorkBuddy 的 h$t 也是提交时才转换）。
    //   提前转＝整个面板内存里常驻几 MB 字符串。
    const payloadParts = await collectAttachments()
    const payload = composeSend(text, attachedSelection)
    clearPrompt()
    // 附件条清空，但缩略图**不 revoke** —— 交接给对话流回显（见 handOffAttachments）。
    const handed = handOffAttachments()
    if (handed.length > 0) echoQueue.push({ count: handed.length, blocks: handed })
    setAttachedSelection('')
    setHistoryOpen(false)
    setPermissionOpen(false)
    api.send(payload, payloadParts)
  }
  prompt.addEventListener('input', syncComposerHeight)
  prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    if (typeof composer.requestSubmit === 'function') composer.requestSubmit()
    else composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  /**
   * 粘贴：文本照旧，图片收进附件条。
   *
   * ★★ 这里**必须**先判断有没有文件，再决定 `preventDefault()` ——
   *    旧实现第一行就无条件 `preventDefault()` 然后只喂 `text/plain`，
   *    于是截图粘贴被整条吞掉（`clipboardData.files` 从来没被读过）。
   *    Word/网页里复制的富文本仍然只取纯文本（保留原有行为）。
   */
  prompt.addEventListener('paste', (event) => {
    const files = pickImageFiles(event.clipboardData)
    if (files.length > 0) {
      event.preventDefault()
      void addFiles(files)
      return
    }
    event.preventDefault()
    insertPlainText(prompt, event.clipboardData?.getData('text/plain') ?? '')
    syncComposerHeight()
  })

  // ── 拖拽入窗 ──
  //
  // ★ 拖拽深度用**计数器**而不是布尔量。鼠标从子元素移到另一个子元素会
  //   连发 dragleave + dragenter，布尔量会被后到的 dragleave 清成 false，
  //   提示层闪烁（这正是 WorkBuddy 用 `f.current++/--` 的原因）。
  let dragDepth = 0
  const dragHasFiles = (event) => {
    const types = event.dataTransfer?.types
    return types != null && Array.from(types).includes('Files')
  }
  composer.addEventListener('dragenter', (event) => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    dragDepth += 1
    dropHint.hidden = false
  })
  composer.addEventListener('dragover', (event) => {
    if (!dragHasFiles(event)) return
    // 不 preventDefault 的话浏览器会走默认行为（把文件当导航打开）
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })
  composer.addEventListener('dragleave', (event) => {
    if (!dragHasFiles(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) dropHint.hidden = true
  })
  composer.addEventListener('drop', (event) => {
    event.preventDefault()
    dragDepth = 0
    dropHint.hidden = true
    void addFiles(pickImageFiles(event.dataTransfer))
  })
  // ★ 无边框窗口「窗外松手收不到 drop」→ 提示层会永远挂着。
  //   用 window 的 blur / dragend 兜底收尾（本项目在 resize 手柄上踩过同款坑）。
  window.addEventListener('blur', () => {
    dragDepth = 0
    dropHint.hidden = true
  })
  window.addEventListener('dragend', () => {
    dragDepth = 0
    dropHint.hidden = true
  })
  composer.addEventListener('click', (event) => {
    if (event.target === composer) prompt.focus()
  })

  for (const preset of PERMISSION_PRESETS) {
    const item = document.createElement('li')
    const option = document.createElement('button')
    option.type = 'button'
    option.dataset.preset = preset
    option.setAttribute('role', 'option')
    option.textContent = permissionText(preset)
    option.addEventListener('click', () => {
      permission = preset
      setPermissionOpen(false)
      renderPermission()
      api.setPermission(preset)
    })
    item.append(option)
    permissionMenu.append(item)
  }
  renderPermission()
  permissionButton.addEventListener('click', (event) => {
    event.stopPropagation()
    setHistoryOpen(false)
    setPermissionOpen(!permissionOpen)
  })
  document.addEventListener('pointerdown', (event) => {
    if (permissionRoot.contains(event.target)) return
    setPermissionOpen(false)
  })
  historyButton.addEventListener('click', () => { setHistoryOpen(!historyOpen) })
  newConversation.addEventListener('click', () => {
    setHistoryOpen(false)
    setPermissionOpen(false)
    api.newSession()
    prompt.focus()
  })
  stop.addEventListener('click', () => { api.stop() })
  questionCancel.addEventListener('click', cancelQuestion)
  questionSkip.addEventListener('click', skipQuestion)
  questionContinue.addEventListener('click', continueFlow)
  questionPrev.addEventListener('click', () => {
    if (pending === undefined || pending.busy || pending.index === 0) return
    pending.index -= 1
    pending.error = undefined
    renderQuestion()
  })
  questionNextNav.addEventListener('click', () => {
    if (pending === undefined || pending.busy || pending.index === pending.questions.length - 1) return
    pending.index += 1
    pending.error = undefined
    renderQuestion()
  })
  questionCustom.addEventListener('input', () => {
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    draft.custom = questionCustom.value
    draft.skipped = false
    if (item.multiSelect !== true) draft.selected = []
    pending.error = undefined
    questionError.hidden = true
    syncContinue()
  })
  questionCustom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  })

  api.onBlock((block) => { stage(block) })
  api.onBlockDrop((key) => { stage({ type: 'block-drop', key }) })
  // 历史回放的原图回包（P2-4 补）：**不是块**、不走 stage —— 它只就地补图，不动顺序。
  if (typeof api.onImages === 'function') {
    api.onImages((payload) => {
      const key = typeof payload?.key === 'string' ? payload.key : ''
      if (key === '') return
      applyBlockImages(key, payload.images, payload.skipped)
    })
  }
  api.onTurn((turn) => { stage({ type: 'turn', ...(turn ?? {}) }) })
  api.onSession((id) => { sessionId = typeof id === 'string' ? id : '' })
  api.onHistory((items) => {
    historyItems = Array.isArray(items) ? items : []
    // ⚠️ 这里**不能**用 `if (historyOpen)` 守着。
    //    踩过：解锁后 host 会重推一份明文列表，但进锁时 applyLock() 已经把
    //    抽屉关掉了（historyOpen === false）→ 这次推送不重画 → 列表 DOM 里
    //    还是上一份**遮罩占位行**。用户解锁后再打开历史，看到的仍是
    //    一堆「已锁定的对话」—— 明明已经解开了，却像没解开。
    //    renderHistory() 只是重建一份离屏节点，代价很小；
    //    「抽屉关着就不用同步」是省小钱赔大钱的优化。
    renderHistory()
  })
  /**
   * 对话级操作（重命名/删除/锁定）的回执。
   *
   * host 一直在发这条，但 preload 之前没暴露、helper 也没转发 ——
   * 所以失败时球侧**完全静默**：用户点了没反应、没提示、也没日志，
   * 只能以为功能坏了。接上之后至少「为什么没成」是看得见的。
   */
  api.onConversationAction((result) => {
    if (result?.ok === true) {
      if (result.action === 'history.rename') status.textContent = `${messages.menuRename} ✓`
      else if (result.action === 'history.delete') status.textContent = `${messages.menuDelete} ✓`
      else if (result.action === 'history.lock') {
        // 上锁/解锁成功 → 菜单文案与列表都要跟着变，等 host 的 sendHistory 回来。
        // 这里只给一句即时反馈，别自己改 historyItems（那是 host 的快照）。
        status.textContent = result.locked === true ? `${messages.menuLock} ✓` : `${messages.menuUnlock} ✓`
      } else if (result.action === 'history.set-password') {
        // 密码设好了 → 自动补一次上锁（用户点「定好并上锁」，不该只定不上）。
        const sessionId = lockSetupSessionId
        lockSetupSessionId = ''
        setLockOpen(false)
        if (sessionId !== '') api.conversationAction('history.lock', { sessionId })
      } else if (result.action === 'history.export') {
        // 导出成功 → 告诉用户去哪找（这种窗口里没有「另存为」对话框，固定落 exports/）
        const where = typeof result.path === 'string' && result.path !== '' ? result.path : ''
        status.textContent = `${messages.lockExportDone}${where}`
      }
      return
    }
    // ── 失败分支 ──────────────────────────────────────────────────
    // 上锁被拒（还没设密码）→ 弹设置卡。这是**唯一**能让用户上锁成功后
    // 又被自己关在门外的地方，所以它的处理必须显式、不能走通用失败提示。
    if (result?.action === 'history.lock' && result?.needPassword === true) {
      status.textContent = messages.lockNeedPassword
      openPasswordSetup(result.sessionId ?? '')
      return
    }
    if (result?.action === 'history.set-password') {
      if (lockFeedback !== null) {
        lockFeedback.hidden = false
        lockFeedback.textContent = `${messages.lockSetFailed}${result.error ?? messages.unknownError}`
        lockFeedback.dataset.ok = 'false'
      }
      lockSetupSessionId = ''
      return
    }
    // 失败要看得见 —— 之前这条回执没人接，失败就是纯静默
    const reason = typeof result?.error === 'string' && result.error !== ''
      ? result.error
      : messages.unknownError
    status.textContent = `✗ ${reason}`
  })
  api.onPermission((preset) => {
    if (typeof preset !== 'string') return
    permission = preset
    renderPermission()
  })
  // ── 对话隐私锁（对话加密_落地方案.md）──────────────────────────────
  // 三条回调**必须都在**：`onLock` 是唯一的进锁入口，漏了它超时锁永远收不到
  // （它是 host 主动推的，没有任何用户动作能给这个事件当载体）。
  if (typeof api.onLock === 'function') {
    api.onLock((payload) => { applyLock(payload) })
  }
  if (typeof api.onLockFeedback === 'function') {
    api.onLockFeedback((payload) => { applyLockFeedback(payload) })
  }
  if (typeof api.onSoftAgreement === 'function') {
    // 「取消/重设暗号」的状态标记。球侧只需同步 hasAgreement，
    // 免得用户取消了暗号、卡片却还在说「对暗号」。
    api.onSoftAgreement((payload) => {
      lockState.hasAgreement = payload?.state === 'set'
      if (lockGate !== null && !lockGate.hidden) renderLockCard()
    })
  }
  if (lockSubmit !== null) lockSubmit.addEventListener('click', () => { submitLock() })
  if (lockInput !== null) {
    // Enter 提交。⚠️ 必须在 keydown 而不是 keypress，且要判 isComposing ——
    //    中文输入法选词时的回车不能当成提交。
    lockInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || isComposing(event)) return
      event.preventDefault()
      submitLock()
    })
  }
  if (lockClose !== null) {
    lockClose.addEventListener('click', () => { setLockOpen(false) })
  }
  if (lockExport !== null) {
    lockExport.addEventListener('click', () => {
      // 逃生通道（方案 §7）：**不解锁**，直读磁盘明文导成 txt。
      // 走既有 conversation-action 通道，host 侧自己决定能不能导。
      api.conversationAction('history.export', { sessionId: lockState.convId })
    })
  }
  api.onReset(() => { stage({ type: 'reset' }) })
  api.onAttach((text) => {
    if (typeof text !== 'string' || text === '') return
    void setExpanded(true).then(() => {
      setAttachedSelection(text)
      prompt.focus()
    })
  })
  selectionChipDismiss.addEventListener('click', () => { setAttachedSelection('') })
  tccDismiss.addEventListener('click', () => { hideTccGate() })
  tccLater.addEventListener('click', () => { hideTccGate() })
  tccScreenOpen.addEventListener('click', () => { void openTccRight('screen') })
  tccAccessibilityOpen.addEventListener('click', () => { void openTccRight('accessibility') })
  api.onAvatar((src) => {
    avatarSrc = typeof src === 'string' && src !== '' ? src : 'orb-idle.gif'
    const gif = document.querySelector('#ball-gif')
    if (!gif) return
    delete gif.dataset.mode
    syncGif()
  })
  /**
   * ★ 托盘图标的**逐图人脸裁切参数**（用户选定的 B 方案）。
   *
   * 为什么必须逐图定参、不能用统一的「居中裁一刀」：
   *   头像素材是**完整立绘**，脸的位置每张都不一样 —— 实测
   *   `smile` 的脸在上部（cy≈0.35）、默认 512² 的脸在中下部（cy≈0.65）。
   *   一个比例必然裁不准另一张（试过 `upper-62` 对默认图裁出来的是头饰和头发）。
   *
   * 三分量含义（都相对**短边**，cx/cy 是裁切框中心在图中的归一化位置）：
   *   cx: 水平中心；cy: 垂直中心；s: 裁切边长 ÷ 短边。
   *
   * ⚠️ 这组数字是**看着导出的候选图逐张挑的**（probe/face-scan*.cjs），不是算出来的。
   *   换素材就得重新挑 —— 别凭直觉改。
   *
   * ⚠️ `heart.gif` 的原图里**眼睛本来就被「比心」的双手挡住了**，任何裁切都看不到眼睛；
   *    这里刻意 `s=0.90` 把手势完整保留 —— 托盘里靠「比心剪影」辨识，而不是靠脸。
   */
  const TRAY_FACE_CROP = {
    // 示例素材（头肩构图，脸在中间偏上）。
    'orb-idle.gif': { cx: 0.5, cy: 0.45, s: 0.8 },
    // ↓ 自制球形态，逐张手挑的原始值（勿随意覆盖）。
    // 换素材必须重新标定这三个数：probe/face-scan*.cjs 出候选图逐张看。
    'avatars/smile.gif': { cx: 0.5, cy: 0.32, s: 0.68 },
    'avatars/cheer.gif': { cx: 0.5, cy: 0.36, s: 0.7 },
    'avatars/cheeks.gif': { cx: 0.46, cy: 0.42, s: 0.72 },
    'avatars/heart.gif': { cx: 0.5, cy: 0.4, s: 0.74 },
    'avatars/point.gif': { cx: 0.48, cy: 0.38, s: 0.72 },
    'avatars/rice.gif': { cx: 0.5, cy: 0.4, s: 0.72 }
  }
  /** 没登记的图（比如用户自定义上传的）退回「轻微上移的居中裁切」——
   *  比整图缩放强（脸会大一点），又不会因为猜错比例把脸裁掉。 */
  const TRAY_FACE_CROP_FALLBACK = { cx: 0.5, cy: 0.42, s: 0.8 }

  /**
   * ★ 托盘图标解码（供主进程 executeJavaScript 调用）。
   *
   * **为什么这活儿必须由渲染层干**：Electron 的 `nativeImage` 不解析 GIF
   * （createFromPath 对 GIF 返回空图，且 Tray 接受空图**不报错** —— 症状是
   * 托盘出现一个空白格子、日志全干净）。Chromium 支持 GIF，所以让这边解码。
   *
   * 取帧方式：把当前球脸 `#ball-gif` 的**已经加载好的**图像画进 canvas，
   * 再 `toDataURL('image/png')`。因为 `#ball-gif` 就是球正在显示的图，
   * 「球显示什么、托盘就是什么」天然一致，也不需要再发一次网络请求。
   *
   * 尺寸取 64×64（不是 16）：托盘图标在高 DPI 屏上会要 2x，
   * 主进程再 `resize` 到 16 即可 —— 从大往小缩比从小往大放清楚得多。
   *
   * 失败一律 resolve(null)，绝不 reject：主进程那边用 `catch` 兜底，
   * 但**静默失败族**的教训是「失败要留痕」，所以这里也 console.error。
   */
  window.__orbTrayIconPng = function (src) {
    return new Promise((resolve) => {
      try {
        const source = document.querySelector('#ball-gif')
        // 调用方给了具体 src 就用它；空串表示「当前球脸」，而球脸的真源就是 #ball-gif。
        const url =
          typeof src === 'string' && src !== ''
            ? src
            : source?.src || 'orb-idle.gif'
        // 用 url 反查裁切参数：预设是相对路径（与表里的 key 对得上）；
        // data URL（用户自定义上传）与 #ball-gif 的绝对 file:// URL 都查不到 ⇒ 走兜底。
        const key = Object.keys(TRAY_FACE_CROP).find((k) => url === k || url.endsWith('/' + k))
        const crop = (key && TRAY_FACE_CROP[key]) || TRAY_FACE_CROP_FALLBACK
        const img = new Image()
        // 预设是相对路径、data URL 直接用；两者都不带凭据，无需 crossOrigin。
        img.onload = () => {
          try {
            const side = 64
            const canvas = document.createElement('canvas')
            canvas.width = side
            canvas.height = side
            const ctx = canvas.getContext('2d')
            if (!ctx) return resolve(null)
            ctx.imageSmoothingQuality = 'high'
            // GIF 在新建的 <img> 里取首帧，正合托盘所需。
            const W = img.naturalWidth || img.width
            const H = img.naturalHeight || img.height
            const box = Math.min(W, H) * crop.s
            // 裁切框左上角；夹在工作区里，防止参数越界切出空白。
            const sx = Math.max(0, Math.min(W - box, W * crop.cx - box / 2))
            const sy = Math.max(0, Math.min(H - box, H * crop.cy - box / 2))
            ctx.drawImage(img, sx, sy, box, box, 0, 0, side, side)
            resolve(canvas.toDataURL('image/png'))
          } catch (error) {
            console.error('orb tray icon: canvas 导出失败', error)
            resolve(null)
          }
        }
        img.onerror = () => {
          console.error('orb tray icon: 头像加载失败', url)
          resolve(null)
        }
        img.src = url
      } catch (error) {
        console.error('orb tray icon: 解码异常', error)
        resolve(null)
      }
    })
  }
  // 情绪装饰 GIF（P1-5）。**刻意挂在 onAvatar 旁边而不是 onAvatar 里**——
  // 两者是两个不相干的图层：`avatar` 是球的脸（兼拖窗把手），
  // `deco` 是面板左下角的装饰。串了就是「她一开口球脸被换掉」。
  if (typeof api.onDeco === 'function') {
    api.onDeco((payload) => { applyDeco(payload) })
  }
  api.onStatus((text) => { status.textContent = typeof text === 'string' ? text : '' })
  // The theme arrives as the helper's nativeTheme (the prefers-color-scheme
  // query above follows it); the locale switches the whole page dictionary.
  if (typeof api.onAppearance === 'function') {
    api.onAppearance((appearance) => {
      if (appearance !== null && typeof appearance === 'object') {
        applyLocale(appearance.locale)
        refreshAllText()
      }
    })
  }
  // 主题与三张背景（用户 m02033）：主进程是唯一真源，这里只收快照上屏。
  // 主题页自己也会 `orb:theme-get` / `orb:bg-get` 取一次（打开时），
  // 但背景层**不打开抽屉也该显示**，所以这里主动拉一次兜底 ——
  // 主进程在 `did-finish-load` 也会推一次，两条路都幂等。
  if (typeof api.onTheme === 'function') {
    api.onTheme((payload) => { themePanel?.applyTheme(payload) })
  }
  if (typeof api.onBackgrounds === 'function') {
    api.onBackgrounds((payload) => {
      backgrounds.apply(payload)
      themePanel?.applyBackgrounds(payload)
    })
  }
  void (async () => {
    if (typeof api.themeGet === 'function') {
      try { themePanel?.applyTheme(await api.themeGet()) } catch { /* 主进程未就绪时保持默认 */ }
    }
    if (typeof api.backgroundsGet === 'function') {
      try { backgrounds.apply(await api.backgroundsGet()) } catch { /* 同上 */ }
    }
  })()
  transcript.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (anchor === null) return
    const href = anchor.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) return
    event.preventDefault()
    api.openExternal(href)
  })
  api.onQuestion((payload) => { showQuestion(payload) })
  api.onQuestionClear((id) => { clearQuestion(id) })
  api.onQuestionError((payload) => {
    if (pending === undefined || pending.id !== payload?.id) return
    pending.busy = false
    pending.error = typeof payload.text === 'string' ? payload.text : messages.incomplete
    renderQuestion()
  })

  // ── 渲染层右键菜单 ─────────────────────────────────────────────
  // 取代原来的 Electron 原生 `Menu.popup()`（原因见 context-menu.js 头部）。
  // 这里同时承载两类菜单：
  //   1. 球菜单 —— 右键球或面板空白处
  //   2. 对话级菜单 —— 右键某条历史会话（重命名 / 删除 / 锁定，待办 P0-4）
  // 菜单**项由 host 下发**，渲染层不硬编码业务项。
  const contextMenu = createContextMenu({
    onAction: (id, payload) => { handleMenuAction(id, payload) },
    /**
     * 菜单开/关的真实上报。
     *
     * 之前是「关穿透 + 220ms 后无条件恢复」，实测把球弄死了：
     * 面板已展开时还恢复穿透，用户看到的就是「亮着但点不动的球」。
     * 现在把开关如实报给 host，由它决定恢复时机（它才知道展开态）。
     */
    onOpen: () => {
      if (typeof api.setMenuHold === 'function') api.setMenuHold(true)
    },
    onClose: () => {
      if (typeof api.setMenuHold === 'function') api.setMenuHold(false)
    },
    /** 可编辑区：让位给原生编辑菜单，否则右键等于没反应。 */
    onEditableContextMenu: () => {
      if (typeof api.popupEditMenu === 'function') api.popupEditMenu()
    },
    onContextMenu: (event) => {
      // 球体上的右键由环形菜单处理，这里不弹传统菜单。
      // ★ 只判 `ball.contains()` 是不够的（用户 m01036 截图：球**边缘**右键弹出了这个旧列表菜单）：
      //   球是 72×72 的圆按钮，圆外那一圈描边/光晕（以及贴边时的 1-2px 缝隙）
      //   不在 #ball 的盒子里，右键落到 body 上就会走到下面的 ballMenuItems 分支。
      //   所以用 `nearBall()` 把「球心 半径+12px」整块都算成球。
      if (ball.contains(event.target) || nearBall(event)) {
        void toggleRingMenu()
        return
      }
      const onRow = event.target instanceof Element ? event.target.closest('.history-row') : null
      if (onRow !== null) {
        const id = onRow.dataset.sessionId
        if (typeof id === 'string' && id !== '') {
          contextMenu.open({
            x: event.clientX,
            y: event.clientY,
            items: conversationMenuItems(id, onRow.dataset.locked === 'true', onRow.textContent ?? ''),
          })
          return
        }
      }
      contextMenu.open({ x: event.clientX, y: event.clientY, items: ballMenuItems() })
    },
  })
  contextMenu.bind()

  /**
   * 落点是否在球上（含球外一圈 12px 的描边/光晕区）。
   *
   * 为什么不能只用 `ball.contains(target)`：`#ball` 是 72×72 的方形盒子，
   * 但球是圆的，圆外那圈（描边光晕、以及贴屏幕边时的缝隙）落在 body 上 ——
   * 用户 m01036 报的「球体边缘右键弹出旧菜单」正是从这里漏出去的。
   */
  function nearBall(event) {
    const rect = ball.getBoundingClientRect()
    if (!(rect.width > 0)) return false
    const dx = event.clientX - (rect.left + rect.width / 2)
    const dy = event.clientY - (rect.top + rect.height / 2)
    return Math.hypot(dx, dy) <= rect.width / 2 + 12
  }

  /**
   * 面板拖拽缩放（P0-5）。
   *
   * 窗口是 `frame:false` + `transparent:true` → Windows 上没有系统 resize 热区，
   * 用户没有「边框」可拖，必须自绘手柄。详见 resize-handles.js 头部。
   *
   * 拖拽中**不改面板的 CSS 宽高**，只让手柄显示一个尺寸读数：
   * 窗口没变大之前，把面板撑宽只是把内容画到窗口边界之外，会被裁掉，
   * 用户拖了半天看不到任何变化。手柄内部已经处理好了读数，这里不用管。
   *
   * `getDirection` 必须喂真实展开方向 —— 只有「远离球」的那几条边能拖，
   * 贴着球的边暴露出来会抢球的点击（见 resize-handles.js 头部）。
   */
  const resizeHandles = createResizeHandles({
    isEnabled: () => expanded,
    getDirection: () => expandDirection,
    onCommit: (width, height) => {
      // 交给主进程 clamp + 落盘 + 真的 setBounds（那里有球锚点的重算）。
      //
      // ★ 必须接住返回的方向：面板变大后可能从球的左边翻到右边，
      //   主进程重算完 `expandedOverlayBounds` 才知道实际方向。
      //   不接的话手柄会一直按旧方向显示 —— 面板已经长到球右边，
      //   可拖的手柄还留在左边，用户得往反方向拖。
      const req = api.setPanelSize?.(Math.round(width), Math.round(height))
      if (req && typeof req.then === 'function') {
        void req.then((state) => {
          if (state && typeof state.horizontal === 'string') applyDirection(state)
        })?.catch?.(() => {})
      }
    },
  })

  /**
   * 菜单动作分发。
   *
   * 三类分开处理，**不要都退到 `api.openMenu()`** —— 那条通道是旧的原生菜单，
   * 在无边框透明窗口下锚点会错位（就是 P0-6 的根因）。
   *
   * 重命名与删除要先在渲染层问过用户：重命名得给地方打字，删除不可逆。
   */
  function handleMenuAction(id, payload) {
    // ── 球级菜单
    if (id === 'avatar.set') {
      const src = typeof payload?.src === 'string' ? payload.src : ''
      if (src !== '') api.setAvatar(src)
      return
    }
    if (id === 'avatar') { setHistoryOpen(false); impressionPanel?.setOpen(false); apiConfigPanel?.setOpen(false); themePanel?.setOpen(false); biliHistoryPanel?.setOpen(false); openAvatarPicker(); return }
    if (id === 'history') {
      // ★ 互斥已收进 `setHistoryOpen` 自己（开历史时踢掉另外三个抽屉）——
      //   这里**不要再手写一遍**：补丁写在调用点就是这个 bug 的成因
      //   （左下角历史按钮没这句，于是从 API 配置页进去就两页叠着）。
      setHistoryOpen(!historyOpen)
      return
    }
    if (id === 'impression') { impressionPanel.setOpen(!impressionPanel.isOpen()); return }
    if (id === 'api-config') { apiConfigPanel?.setOpen(!apiConfigPanel.isOpen()); return }
    if (id === 'theme') { themePanel?.setOpen(!themePanel.isOpen()); return }
    // 「看过的视频」：取代原环菜单里的「打开旧后端界面」（2026-10-21 用户拍板）。
    if (id === 'bili-history') { biliHistoryPanel?.setOpen(!biliHistoryPanel.isOpen()); return }
    // 环形菜单独有：新建对话。行为与左下角「+」按钮**逐字一致** ——
    // 同一个动作不允许有第二种打开方式（两处各写一套，迟早行为不同）。
    if (id === 'new-chat') { setHistoryOpen(false); setPermissionOpen(false); api.newSession(); prompt.focus(); return }

    // ── 记忆中心的频率档位（id 形如 impression.schedule.24）
    //必须在球级分支之后、对话级分支之前 —— 它带 payload.sessionId 会被误判。
    if (id.startsWith('impression.schedule.')) {
      const pick = pendingSchedulePick
      pendingSchedulePick = null
      pick?.(id.slice('impression.schedule.'.length))
      return
    }
    if (id === 'legacy-web') { void openLegacyWeb(); return }
    // ★ 隐藏悬浮球（环菜单项）。正常路径下主进程会截流、压根走到不这里，
    //   但留着这条分支有两个好处：① 万一截流被改掉也不出错；
    //   ② 探针可以直接调 handleMenuAction('ball-hide') 验行为，不必起 Electron。
    if (id === 'ball-hide') {
      if (typeof api.hideBall === 'function') api.hideBall()
      return
    }

    // ── 对话级菜单
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return
    const item = historyItems.find((row) => row.sessionId === sessionId)
    const title = typeof item?.title === 'string' && item.title !== '' ? item.title : messages.untitled

    if (id === 'history.rename') { beginInlineRename(sessionId, title); return }
    if (id === 'history.delete') { openDeleteConfirm(sessionId, title); return }
    if (id === 'history.lock') {
      // 解锁是即时的；上锁需要先有密码 —— 没密码时 host 会回 needPassword，
      // 这里**先弹设置卡**，设完再自动补一次上锁请求。
      // 不在球侧判「有没有密码」：那是 host 的权威状态，球侧只有一份可能过期的快照。
      // 球侧抢着判 = 又把「谁能上锁」这条规则抄成两份，迟早不同步。
      api.conversationAction(id, { sessionId })
      return
    }
  }

  /**
   * 强锁密码设置卡。
   *
   * 复用解锁卡那块 DOM 是**故意**的：两者形状完全一样（一个输入框 + 一个主按钮），
   * 复用能少一整套样式与焦点管理。区别只在文案与提交后走哪条通道 ——
   * 用 `lockSetupSessionId` 这个一次性中转变量区分。
   *
   * ⚠️ 用一次性变量而不是常驻 flag：清得掉、不会串到下一次解锁。
   *    这与修「重命名存不进去」时学到的教训一致 —— 状态该有明确的生命周期。
   *    （变量本身声明在锁状态块顶部，见那里的 TDZ 说明。）
   */
  function openPasswordSetup(sessionId) {
    if (lockGate === null) return
    lockSetupSessionId = sessionId
    lockState = { state: 'locked', kind: 'strong', convId: sessionId, attemptsLeft: 0, hasAgreement: false, pendingOpen: '' }
    if (lockEyebrow) lockEyebrow.textContent = messages.lockEyebrowStrong
    if (lockTitle) lockTitle.textContent = messages.lockSetupTitle
    if (lockDetail) lockDetail.textContent = messages.lockSetupDetail
    if (lockHint) lockHint.textContent = messages.lockSetupHint
    if (lockInput) {
      lockInput.placeholder = messages.lockSetupPlaceholder
      lockInput.disabled = false
      lockInput.value = ''
    }
    if (lockSubmit) {
      lockSubmit.textContent = messages.lockSetupSubmit
      lockSubmit.disabled = false
    }
    if (lockClose) {
      lockClose.textContent = '✕'
      lockClose.title = messages.lockClose
      lockClose.setAttribute('aria-label', messages.lockClose)
    }
    if (lockExport) lockExport.hidden = true
    if (lockCard) lockCard.dataset.armed = 'true'
    if (lockFeedback !== null) {
      lockFeedback.hidden = false
      lockFeedback.textContent = messages.lockSetupWarn
      lockFeedback.dataset.ok = 'false'
    }
    lockGate.hidden = false
    lockInput?.focus()
  }

  /** 设置卡提交：把密码交给 host 落 scrypt 哈希，成功后自动补上锁。 */
  function submitPasswordSetup() {
    if (lockInput === null) return
    const pw = lockInput.value
    if (pw.trim() === '') return
    const sessionId = lockSetupSessionId
    lockInput.value = ''
    if (lockFeedback !== null) {
      lockFeedback.hidden = false
      lockFeedback.textContent = messages.lockSetupSaving
      lockFeedback.dataset.ok = 'true'
    }
    // ⚠️ 原文只交一次，立刻丢。这里之后 lockInput.value 已清空，
    //    闭包里也不留 pw —— 上面那行 `const pw` 就是这个作用域里唯一一份。
    api.conversationAction('history.set-password', { sessionId, password: pw })
  }

  /**
   * 「更换显示样式」——直接走DOM 弹层，不用原生菜单的子菜单。
   * 头像预设清单由 helper 侧的 AVATAR_PRESETS 决定，这里通过
   * `api.listAvatars()` 拿，避免两处硬编码同一份清单。
   */
  async function openAvatarPicker() {
    if (typeof api.listAvatars !== 'function') return
    const presets = await api.listAvatars()
    if (!Array.isArray(presets) || presets.length === 0) return
    const anchor = document.querySelector('#ball')
    const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: 8, bottom: 8 }
    contextMenu.open({
      x: rect.left + rect.width / 2,
      y: rect.bottom,
      items: presets.map((p) => ({
        id: 'avatar.set',
        label: typeof p.name === 'string' && p.name !== '' ? p.name : p.src,
        group: 'avatar',
        checked: p.src === avatarSrc,
        payload: { src: typeof p.src === 'string' ? p.src : '' },
      })),
    })
  }

  /**
   * 「打开旧后端界面」——地址由 helper 侧持有（Host 推给它的）。
   *
   * ★ 用户 m01036 报「菜单里点『打开旧后端』，打开的实际上是历史对话」。
   *   真因不是 id 映射错（`context-menu.js` 用闭包里的 item.id，没有错位）：
   *   helper 侧在 Host 还没推 `legacy-endpoint` 时**静默 return**（main.js 的 openLegacyWeb），
   *   于是什么也没发生，而面板里还停在上一个抽屉（当时正是历史对话）——
   *   用户看到的就是「点了旧后端，出来历史对话」。
   *   现在先问一次地址：拿不到就打开 API 配置页（那正是能看见/修地址的地方），
   *   把一个静默失败变成有去处的一步。
   */
  async function openLegacyWeb() {
    if (typeof api.openLegacyWeb !== 'function') return
    let http = ''
    try {
      const status = typeof api.legacyStatus === 'function' ? await api.legacyStatus() : null
      http = typeof status?.http === 'string' ? status.http : ''
    } catch {
      http = ''
    }
    if (http === '') {
      apiConfigPanel?.setOpen(true, { note: messages.apiNoEndpoint })
      return
    }
    api.openLegacyWeb()
  }

  /**
   * ★ 把上面那份「带兜底的 openLegacyWeb」挂到 window 上，给**主进程**调用。
   *
   * 背景（用户 2026-10-08 报「打开旧后端目前来说是无效的」）：
   *   托盘 / 原生右键的「显示主页面」是**主进程直连**（`main.js` 的 openLegacyWeb），
   *   而那边在拿不到地址时只写一条 console.error 就 return ⇒ 用户点了没反应。
   *   渲染层这份会先问 legacyStatus、拿不到就打开「API 配置」抽屉 —— 那才是该发生的事。
   *   主进程用 `executeJavaScript` 找这个函数，找到就走这条好路。
   *
   * 命名用 `__orb` 前缀：和已有的 `__orbTrayIconPng` 一致，
   * 一眼能看出「这是给主进程的钩子，不是业务函数」。
   */
  window.__orbOpenLegacyWeb = () => {
    // 不 await：主进程那边只关心「有没有这条好路」，不关心它什么时候跑完。
    openLegacyWeb()
    return true
  }

  /**
   * 原生右键菜单的「看过的视频」走的钩子（2026-10-21）。
   * 抽屉在渲染层，主进程只能这样请它开 —— 与 `__orbOpenLegacyWeb` 同一套做法。
   */
  window.__orbOpenBiliHistory = () => {
    biliHistoryPanel?.setOpen(true)
    return true
  }

  /** 重命名：用现成的 window.prompt —— 它阻塞但可靠，且焦点/取消语义免费。 */
  /**
   * 重命名：**行内编辑**。
   *
   * 上一版用 `window.prompt`，实测在无边框透明置顶窗口里弹不出来
   * （用户反馈「重命名没跑通」，而删除的 `window.confirm` 却能用）——
   * 与其赌各平台对这两个对话框的支持差异，不如按用户要求改成行内编辑：
   * 标题行原地变成输入框 + 确认/取消。
   *
   * 交互约定：
   *   - 全选原有文字，直接打字覆盖
   *   - Enter 确认、Esc 取消、失焦取消（都走同一个收尾函数，避免状态打架）
   *   - 空标题 / 没改内容 → 直接退出，不发请求
   */
  let renamingSessionId = ''

  function beginInlineRename(sessionId, currentTitle) {
    if (renamingSessionId === sessionId) return
    // 已在别处编辑时先复原（它自己会 renderHistory），再开新的
    if (renamingSessionId !== '') {
      renamingSessionId = ''
      renderHistory()
    }
    const row = historyList.querySelector(`.history-row[data-session-id="${cssEscape(sessionId)}"]`)
    if (!(row instanceof HTMLElement)) return

    renamingSessionId = sessionId
    row.classList.add('renaming')
    const previous = currentTitle === messages.untitled ? '' : currentTitle

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'rename-input'
    input.value = previous
    input.maxLength = 200
    input.setAttribute('aria-label', messages.menuRenamePrompt ?? '新的名字')

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'rename-btn confirm'
    confirm.textContent = '✓'
    confirm.title = messages.menuRename

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'rename-btn'
    cancel.textContent = '✕'
    cancel.title = messages.menuDelete === undefined ? '' : ''

    // 先摘掉原来的行内容，编辑态占住同一个位置（不另起一行，避免列表跳动）
    const shell = document.createElement('span')
    shell.className = 'rename-row'
    row.replaceChildren(shell)
    shell.append(input, confirm, cancel)

    const finish = (commit) => {
      if (renamingSessionId !== sessionId) return
      const next = input.value.trim()
      // 先清标记再复原 —— renderHistory() 会重画整个列表，
      // 编辑态的 DOM 随之丢弃，不需要手工把文字写回去。
      renamingSessionId = ''
      row.classList.remove('renaming')
      renderHistory()
      if (commit && next !== '' && next !== previous) {
        api.conversationAction('history.rename', { sessionId, title: next })
      }
    }

    /**
     * ★★ 三个提交入口都必须 `stopPropagation()`（2026-10-07 用户实测「改名保存不了」）。
     *
     * 历史列表的每一行**本身就是 `<button class="history-row">`**，它带着自己的
     * click 监听（`setHistoryOpen(false)` + `api.openSession`，见 renderHistory）。
     * 而我们把 input 和 ✓/✕ **塞进了这个 button 里** ——
     * 点 ✓ 时事件沿冒泡链上行到 row，于是面板被关掉、DOM 当场销毁。
     * `orb.log` 里一条 `重命名 …` 都没有，看着就像「请求压根没发出去」。
     *
     * ⚠️ 只能在 `finish()` **之后**停，不能靠「判断事件目标在不在编辑区里」：
     *   `finish` 里的 `renderHistory()` 是同步的，它先`replaceChildren()`
     *   重建整个列表 —— 等事件冒泡到 row 时编辑区早已脱离文档，
     *   任何基于 DOM 归属的判据都失效了。
     *   也不要用 capture 阶段无差别拦：那样连 ✓ 自己那一下都会挡掉。
     *
     * ⚠️ 为什么上一轮探针 45/45 全绿却漏掉它：探针复刻了重命名的**全部逻辑**，
     *   唯独没给 row 挂 click 监听。**结构不同构的探针，测不出结构性的 bug。**
     */
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); event.stopPropagation(); return }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); event.stopPropagation() }
    })
    confirm.addEventListener('click', (event) => { finish(true); event.stopPropagation() })
    cancel.addEventListener('click', (event) => { finish(false); event.stopPropagation() })
    /**
     * ★ 关键：在 `mousedown` 阶段 `preventDefault()`，**让输入框根本不丢焦点**。
     *
     * 这是实测踩到的坑（用户反馈「改名无法生效」）。浏览器点按钮的顺序是
     *   mousedown →（input 失焦）→ blur → mouseup → click
     * 而失焦的默认行为正是 `mousedown` 的 preventDefault 能挡掉的。
     * 挡掉之后 blur 根本不触发，click 就能安安稳稳走到 `finish(true)`。
     *
     * ⚠️ 不要试图靠「blur 里 setTimeout 延后判定」来绕 —— 那会把收尾推到
     * 下一轮事件，而 `renderHistory()` 已经把整行重建了，click 打在销毁的
     * 节点上，什么都不会发生。（探针 §9 就是被这一版骗过才红的。）
     */
    for (const button of [confirm, cancel]) {
      button.addEventListener('mousedown', (event) => {
        // 只关心焦点，别让按钮拿走焦点（否则 input 失焦 → blur 抢跑）
        event.preventDefault()
      })
    }
    // 兜底：真的失焦了（点空白处、Tab 走开、窗口失焦）才当取消。
    // 不加延迟 —— 有 mousedown preventDefault 在，正常点按钮不会走到这里。
    input.addEventListener('blur', () => { if (renamingSessionId === sessionId) finish(false) })

    input.focus()
    input.select()
  }

  /** CSS.escape 的兜底 —— 会话 id 带 base64 变体字符，必须转义才能进选择器。 */
  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
    return String(value).replace(/["\\]/g, '\\$&')
  }

  /**
   * 删除确认：用window.confirm 二次确认，**文案必须写清不可逆**。
   * 这里不做「先软删、后清空」的两段式 —— 用户明确要「删除」，
   * 软删会让「删了但还在列表里」变成新的困惑源。
   */
  function openDeleteConfirm(sessionId, title) {
    const text = messages.menuDeleteConfirm?.(title) ?? `删除「${title}」？不可恢复。`
    if (!window.confirm(text)) return
    api.conversationAction('history.delete', { sessionId })
  }

  /** 球/面板空白处的菜单项。label 走本地化。 */
  function ballMenuItems() {
    return [
      { id: 'avatar', label: messages.menuAppearance },
      { id: 'impression', label: messages.menuImpression },
      { id: 'history', label: messages.menuHistory },
      // 「API 配置」= 面板里的抽屉页（和「我们的回忆」同一形态），
      // 待办 P2-1「独立的 API 配置界面」的落点。清单只有这一份，
      // 环菜单（ringItems()）从它派生，所以两边永远同时有/同时无。
      { id: 'api-config', label: messages.menuApiConfig },
      // 「主题」= 同样形态的抽屉页（用户 m02033）：黑白三态切换 +
      // 三个页面各自导入背景图。用户说「右键菜单的位置还很充裕」。
      { id: 'theme', label: messages.menuTheme },
      // 「看过的视频」= 她在 B 站看过什么的账本抽屉。
      // ★ 取代了原来的 `{ id: 'legacy-web', label: messages.menuLegacyWeb }`：
      //   旧后端 10-19 剥离后那项只会弹「还没有旧后端地址」，用户要求改造成这个页面。
      { id: 'bili-history', label: messages.menuBiliHistory },
    ]
  }

  /** 单条历史会话的菜单项。锁定态决定第一项是「锁定」还是「解锁」。 */
  function conversationMenuItems(id, locked, title) {
    return [
      { id: 'history.rename', label: messages.menuRename, group: 'act', payload: { sessionId: id } },
      {
        id: 'history.lock',
        label: locked ? messages.menuUnlock : messages.menuLock,
        group: 'act',
        payload: { sessionId: id },
      },
      {
        id: 'history.delete',
        label: messages.menuDelete,
        kind: 'danger',
        group: 'danger',
        payload: { sessionId: id },
      },
    ]
  }

  syncGif()

  // ★ 装配完成的唯一标记：`probe/shell-boot-smoke.cjs` 靠它判定「main() 走完了」，
  //   带 `--enable-logging` 跑时也能在控制台一眼看到这一行。
  //   加它的直接原因是 2026-10-08 那次事故：`api-config.js` 里一个漏掉定义的
  //   `applyClose()` 让 main() 在 :579 静默中断 —— UI 看起来「球在，但点不动、
  //   拖不动」，宿主日志一行错都没有，只做静态源码扫描的探针全绿。
  document.documentElement.dataset.shellReady = '1'
  console.log('[shell] main() 装配完成')

  // 面板实例挂到 main 上，给 main() 之外的订阅用（见文件末尾的说明）。
  main.impressionPanel = impressionPanel
}

// ★ 装配只跑一次 —— 守卫在 main() 内部。
//   曾经这里连着写了两遍 `main()`（中间夹一句 api.onImpression），
//   导致整套 UI 装了两套：两个右键菜单实例、16 条缩放手柄，
//   用户表现为「点重命名后菜单不消失」「输入框右键没反应」。
//   详见 main() 头部注释。
main()

// 记忆中心的 host 订阅**已经在 main() 内部挂好**（`shell.js:569`，面板就是在那里
// 建出来的），这里不再重复挂。
//
// ⚠️ 之前这里还写过一遍
//      api.onImpression?.((payload) => impressionPanel.onPayload(payload))
//   而 `impressionPanel` 是 main() 内部的 `const`（:533），模块作用域根本看不见它。
//   那行**不会当场报错**（引用写在回调体内），但会在**每来一条记忆中心 payload 时**
//   抛一次 `ReferenceError: impressionPanel is not defined`（uncaught），并且与
//   :569 的订阅重复。真要再挂一次，只能取 `main.impressionPanel`，别再直接写这个名字。
