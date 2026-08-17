// 场景级识图路由层 · mixed 分路识别（mixed-router）。
//
// 定位：**精度优化**（不是成本优化）。
//
// bootstrap 判定 visual_kind=mixed 后，1.5.3 没有任何后续处理——模型自由深挖
// 可能漏判另一半内容、选错识别方式（§4.6 缺陷实证：第一遍只知道"这是混合的"，
// 不知道"哪几种类型 + 各在哪些区域"）。本模块把混合内容拆分为 ≤2 个分支，各
// 分支独立软引导识别方式，避免漏判/错判，**提升混合图的识别精度**；成本影响是
// 副产品（MAX_MIXED_BRANCHES=2 封顶，混合图 ≤2 次视觉调用）。
//
// 策略来源：dsh-vision（text-llm-vision main 分支）的混合路由——提交 17aff58
// 引入、d9e233b 定型为「候选列表 + 聚焦点 + 双分支」，实现于 vision_client.py
// 的 _parse_scene / _build_branches / _route_engine；语义从"实体主体"（人+飞机）
// 改为"内容类型"（文档+UI）。分支引导遵守软路由成立结论：**不硬拦截识别方式**，
// OCR 仅用于逐字专精场景（可执行代码 / 精确引用 / 合同表单 / 表格数字 / 验证码 /
// 无语义锚点的生僻字）。
//
// 模块为纯函数（零网络依赖），输入为 bootstrap 的结构化输出（visual_kind=mixed
// 时的 regions/entities），输出为分支决策（供 pre-step 钩子注入引导）。

export const MAX_MIXED_BRANCHES = 2

// bootstrap schema 中 entities[].type 的合法枚举
const ENTITY_TYPES = new Set(['text', 'button', 'input', 'image', 'icon', 'object', 'person', 'other'])

// 交互元素信号：存在即倾向 ui 分支
const UI_SIGNAL_TYPES = new Set(['button', 'input', 'icon'])

// 文字内容信号：达到阈值即倾向 document 分支
const DOCUMENT_TEXT_THRESHOLD = 2

// 分支引导表（软引导，非白名单——模型保留逃生通道）。
// 匹配序：("kind","sub") 精确 → ("kind","") → "_default"（同 dsh-vision _route_engine）。
const BRANCH_GUIDANCE = new Map([
  ['document:code', '逐字转写（代码可执行性例外）'],
  ['document:form', '语义优先，逐字字段名/值确需引用时用 OCR'],
  ['document:table', '结构提取优先，数字/金额逐字（表格 OCR 专精场景）'],
  ['document:', '语义优先；仅当需要逐字引用（长文档/合同/表单）时才用 OCR'],
  ['ui:', 'detect / ground 优先（元素清单与像素定位）'],
  ['code:', '逐字转写（可执行性例外）'],
  ['table:', '结构提取优先，数字/金额逐字'],
  ['_default', '放行（模型自由选择识别方式）'],
])

// 分支输出顺序：信号强度排序（可交互 > 文字 > 其余），决定主/次分支
const KIND_PRIORITY = ['ui', 'document', 'code', 'table', 'chat', 'general']

const arr = (value) => (Array.isArray(value) ? value : [])

/**
 * 从 bootstrap 的 regions/entities 推断内容类型，按优先级排序（第一个为主分支）。
 * 保守可测的信号：button/input/icon → ui；文字实体 ≥ 阈值 → document；
 * regions 兜底（entities 缺失时按 region role 弱信号）；无信号 → []（放行，
 * 绝不硬拦——同 dsh-vision "绝不掉 generic"）。
 */
export function inferMixedKinds(evidence) {
  const counts = new Map()
  for (const entity of arr(evidence && evidence.entities)) {
    if (!entity || typeof entity !== 'object') continue
    const type = String(entity.type || '').trim()
    if (ENTITY_TYPES.has(type)) counts.set(type, (counts.get(type) || 0) + 1)
  }
  const kinds = []
  const uiSignals = (counts.get('button') || 0) + (counts.get('input') || 0) + (counts.get('icon') || 0)
  if (uiSignals >= 1) kinds.push('ui')
  if ((counts.get('text') || 0) >= DOCUMENT_TEXT_THRESHOLD) kinds.push('document')
  if (kinds.length === 0) {
    const textRegions = arr(evidence && evidence.regions).filter(
      (region) =>
        region &&
        typeof region === 'object' &&
        ['text', 'content', 'body'].includes(String(region.role || '').trim()),
    ).length
    if (textRegions >= DOCUMENT_TEXT_THRESHOLD) kinds.push('document')
  }
  return kinds.sort(
    (a, b) =>
      (KIND_PRIORITY.indexOf(a) === -1 ? 99 : KIND_PRIORITY.indexOf(a)) -
      (KIND_PRIORITY.indexOf(b) === -1 ? 99 : KIND_PRIORITY.indexOf(b)),
  )
}

/** 分支引导：("kind","sub") 精确 → ("kind","") → "_default"。 */
export function mixedGuidance(kind, sub = '') {
  const exact = BRANCH_GUIDANCE.get(`${kind}:${sub}`)
  if (exact !== undefined) return exact
  const fallback = BRANCH_GUIDANCE.get(`${kind}:`)
  return fallback !== undefined ? fallback : BRANCH_GUIDANCE.get('_default')
}

/**
 * 分支队列：主分支必含，次分支按序追加；去重 + MAX_MIXED_BRANCHES 封顶。
 * 移植 dsh-vision _build_branches 语义（主类必含 + 聚焦点差异类 + ≤2 封顶）。
 * 内容类型（document/ui/code/table）是单一路径，不产生多分支；分支只出现在
 * mixed 图的 ui+document 等组合。
 */
export function buildMixedBranches(mainKind, secondaryKinds = []) {
  const seen = new Set([mainKind])
  const out = [{ kind: mainKind, sub: '', guidance: mixedGuidance(mainKind) }]
  for (const kind of secondaryKinds) {
    if (seen.has(kind) || kind === 'unknown' || kind === 'general') continue
    seen.add(kind)
    out.push({ kind, sub: '', guidance: mixedGuidance(kind) })
    if (out.length >= MAX_MIXED_BRANCHES) break
  }
  return out
}

/**
 * 消费 bootstrap 的结构化输出，产出 mixed 分路决策。
 * 防呆（同 dsh-vision 候选解析防呆思想）：输入缺失 / 推断为空 → fallback=true
 * （放行，模型自由，绝不硬拦）；推断 1 类 → 单分支；≥2 类 → 双分支（≤2 封顶）。
 */
export function planMixedBranches(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { visual_kind: 'mixed', branches: [], fallback: true, note: 'mixed 细分推断失败 → 放行（模型自由选择识别方式，同现状行为）' }
  }
  const kinds = inferMixedKinds(evidence)
  if (kinds.length === 0) {
    return { visual_kind: 'mixed', branches: [], fallback: true, note: 'mixed 细分推断失败 → 放行（模型自由选择识别方式，同现状行为）' }
  }
  return {
    visual_kind: 'mixed',
    branches: buildMixedBranches(kinds[0], kinds.slice(1)),
    fallback: false,
    note: `mixed 分路识别：**精度优化**（避免漏判/错判另一半内容）；≤${MAX_MIXED_BRANCHES} 分支，每分支一次识别调用，成本封顶`,
  }
}

/** 生成注入给模型的混合分支引导文案（中文，供 followupReminder 使用）。 */
export function renderMixedGuidance(plan) {
  if (!plan || plan.fallback || plan.branches.length === 0) return undefined
  const lines = plan.branches.map((branch) => `- ${branch.kind}${branch.sub ? `.${branch.sub}` : ''}：${branch.guidance}`)
  return (
    '检测到混合内容（' +
    plan.branches.map((branch) => branch.kind).join(' + ') +
    '）。为避免漏判/错判（精度优化），请按分支分别验证，各分支至少一次识别调用后再作答；' +
    '分支之间不要混用识别方式。\n' +
    lines.join('\n')
  )
}
