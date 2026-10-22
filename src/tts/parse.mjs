/**
 * 火山引擎语音回包解析（纯函数，零依赖，可单测）。
 *
 * 为什么要单独一个文件：这个回包的形状**有三种**，全是实测撞出来的，不是文档写的：
 *
 *   1. **NDJSON 流**（`/api/v3/tts/unidirectional` 的主形态）：
 *        多行 JSON，音频按块回来，每行 `{"code":0,"data":"<base64>"}`，
 *        最后一行 `{"code":20000000,"data":null}` 表示结束。
 *        ⇒ 必须**逐行拼**，不能整段 JSON.parse（会抛异常，然后你会误判成「没音频」）。
 *
 *   2. **单个 JSON**（个别网关 / 另一条产品线）：
 *        一个对象里 `data` 就是整段 base64。
 *
 *   3. **错误**：`code` 有的放在顶层，有的塞在 `header.code` 里
 *        （`video/tts/tts-verify.mjs` 就是这么兼容的，这里沿用）。
 *
 * 单独成文件还有个好处：拼块顺序、结束判定、错误码提取这些逻辑能脱离网络单测，
 * 不必真去调一次接口。
 */

/** 音频块累积器。按到达顺序拼，顺序错一点听感就乱。 */
export function concatAudio(parts) {
  const list = (Array.isArray(parts) ? parts : []).filter(Boolean)
  if (list.length === 0) return null
  return Buffer.concat(list)
}

/**
 * 解析一次火山回包。
 *
 * @param {string} raw 原始响应文本
 * @returns {{
 *   audio: Buffer|null,    音频字节（没音频就是 null）
 *   blocks: number,        收到几个音频块（诊断用：1 = 单 JSON，>1 = 真流式）
 *   ended: boolean,        是否收到结束标记
 *   failCode: number|null, 业务错误码
 *   failMsg: string,       错误说明
 *   extra: string[],       旁路回包（字幕/时间戳等），留档用
 * }}
 */
export function parseVolcanoResponse(raw) {
  const text = String(raw ?? '')
  if (text.trim() === '') {
    return { audio: null, blocks: 0, ended: false, failCode: null, failMsg: '空响应', extra: [] }
  }

  const parts = []
  const extra = []
  let ended = false
  let failCode = null
  let failMsg = ''
  let sawJson = false

  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s === '') continue
    let obj
    try {
      obj = JSON.parse(s)
    } catch {
      // 不是 JSON 的行（比如网关的 HTML 错误页）留着，出问题时有据可查
      extra.push(s)
      continue
    }
    sawJson = true
    // code 在顶层或 header 里，两种都认
    const code = obj?.header?.code ?? obj?.code
    const msg = obj?.header?.message ?? obj?.message ?? obj?.msg ?? ''

    if (code === 0 && typeof obj?.data === 'string' && obj.data.length > 0) {
      parts.push(Buffer.from(obj.data, 'base64'))
    } else if (code === 20000000) {
      ended = true
    } else if (typeof code === 'number' && code !== 0) {
      // 只记第一个错误：后面通常是同一原因的重复
      if (failCode === null) {
        failCode = code
        failMsg = String(msg || '')
      }
    } else if (obj && typeof obj.data !== 'string') {
      // code 缺失但也不是音频 ⇒ 字幕/时间戳之类的旁路
      extra.push(s)
    }
  }

  // 一条 JSON 都没解析出来：整段不是 JSON（HTML 错误页 / 纯文本报错）
  if (!sawJson) {
    return {
      audio: null,
      blocks: 0,
      ended: false,
      failCode: null,
      failMsg: `响应不是 JSON：${text.slice(0, 200)}`,
      extra,
    }
  }

  return { audio: concatAudio(parts), blocks: parts.length, ended, failCode, failMsg, extra }
}

/**
 * 把业务错误码翻成人话。
 *
 * 为什么值得单独做：`45000010` 的真实含义是「**X-Api-Key 本身不合法**」，
 * 但它看起来像「参数错」，很容易被误判成「头写错了 / 网络问题 / 音色不存在」，
 * 于是白白换半天参数。她在 video/tts 里已经踩过一次，这里把已知的几条固化下来。
 *
 * @param {number|null} code
 * @param {string} msg 服务端原文
 * @returns {string} 给用户/日志看的说明
 */
export function explainVolcanoError(code, msg = '') {
  const m = String(msg || '').trim()
  switch (Number(code)) {
    case 45000010:
      return `凭据不合法（45000010）：是 API Key 本身无效，不是头写错、不是网络问题。去控制台确认这条 key 属于哪个服务、有没有启用。${m ? ` 原文：${m}` : ''}`
    case 401:
      return `未授权（401）：App ID / Access Key 对不上，或者用错了鉴权方式。${m ? ` 原文：${m}` : ''}`
    case 403:
      return `无权限（403）：这条凭据没开通这个音色/服务，或者资源包用完了。${m ? ` 原文：${m}` : ''}`
    case 404:
      return `接口路径不存在（404）：请求的文件/端点不对，通常是产品线不匹配。${m ? ` 原文：${m}` : ''}`
    case 429:
      return `限流（429）：请求太密，等一会儿再试。${m ? ` 原文：${m}` : ''}`
    default:
      return code === null || code === undefined
        ? m || '未知错误'
        : `业务错误 ${code}：${m || '（服务端没给说明）'}`
  }
}
