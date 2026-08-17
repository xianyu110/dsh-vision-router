import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_MIXED_BRANCHES,
  buildMixedBranches,
  inferMixedKinds,
  mixedGuidance,
  planMixedBranches,
  renderMixedGuidance,
} from '../lib/mixed-router.js'

// mixed 分路识别：精度优化（避免漏判/错判另一半内容），≤2 分支成本封顶。

test('inferMixedKinds: ui + document mixed', () => {
  const kinds = inferMixedKinds({
    entities: [
      { type: 'button', label: '确定', region_id: 'r1' },
      { type: 'text', label: '标题', region_id: 'r1' },
      { type: 'text', label: '正文', region_id: 'r2' },
    ],
  })
  assert.deepEqual(kinds, ['ui', 'document']) // ui 优先作主分支
})

test('inferMixedKinds: document only from text entities', () => {
  const kinds = inferMixedKinds({
    entities: [
      { type: 'text', label: 'a', region_id: 'r1' },
      { type: 'text', label: 'b', region_id: 'r2' },
      { type: 'text', label: 'c', region_id: 'r3' },
    ],
  })
  assert.deepEqual(kinds, ['document'])
})

test('inferMixedKinds: no signal falls back to [] (never hard-block)', () => {
  assert.deepEqual(inferMixedKinds({ entities: [] }), [])
  assert.deepEqual(inferMixedKinds(undefined), [])
  assert.deepEqual(inferMixedKinds({ entities: [{ type: 'person', label: '人' }] }), [])
})

test('inferMixedKinds: regions role fallback when entities missing', () => {
  const kinds = inferMixedKinds({
    regions: [
      { id: 'r1', role: 'text', content: 'a' },
      { id: 'r2', role: 'content', content: 'b' },
    ],
  })
  assert.deepEqual(kinds, ['document'])
})

test('buildMixedBranches: dedupe + MAX_MIXED_BRANCHES cap', () => {
  const branches = buildMixedBranches('ui', ['document', 'document', 'code', 'table'])
  assert.equal(branches.length, 2)
  assert.deepEqual(branches.map((b) => b.kind), ['ui', 'document'])
})

test('buildMixedBranches: single branch when no secondary', () => {
  const branches = buildMixedBranches('document', [])
  assert.equal(branches.length, 1)
  assert.equal(branches[0].kind, 'document')
})

test('buildMixedBranches: general/unknown never become secondary branches', () => {
  const branches = buildMixedBranches('ui', ['general', 'unknown'])
  assert.equal(branches.length, 1)
})

test('mixedGuidance: exact sub wins, kind falls back, default releases', () => {
  assert.match(mixedGuidance('document', 'code'), /逐字/)
  assert.match(mixedGuidance('document', 'table'), /逐字/)
  assert.match(mixedGuidance('ui'), /detect/)
  assert.match(mixedGuidance('document'), /语义优先/)
  assert.match(mixedGuidance('chat'), /放行/)
  assert.match(mixedGuidance('unknown'), /放行/)
})

test('planMixedBranches: ui+document decision carries precision note', () => {
  const plan = planMixedBranches({
    visual_kind: 'mixed',
    regions: [{ id: 'r1', role: 'text', content: '标题' }],
    entities: [
      { type: 'button', label: '确定', region_id: 'r1' },
      { type: 'text', label: '说明', region_id: 'r1' },
      { type: 'text', label: '正文', region_id: 'r2' },
    ],
  })
  assert.equal(plan.fallback, false)
  assert.equal(plan.visual_kind, 'mixed')
  assert.deepEqual(plan.branches.map((b) => b.kind), ['ui', 'document'])
  // 精度优化定位标注必须在决策 note 中
  assert.match(plan.note, /精度优化/)
})

test('planMixedBranches: no signal falls back (release, never hard-block)', () => {
  const plan = planMixedBranches({ visual_kind: 'mixed', regions: [], entities: [] })
  assert.equal(plan.fallback, true)
  assert.deepEqual(plan.branches, [])
})

test('planMixedBranches: null input falls back', () => {
  assert.equal(planMixedBranches(undefined).fallback, true)
  assert.equal(planMixedBranches(null).fallback, true)
})

test('renderMixedGuidance: mixed plan renders per-branch guidance; fallback renders nothing', () => {
  const plan = planMixedBranches({
    entities: [
      { type: 'button', label: 'x', region_id: 'r1' },
      { type: 'text', label: 'a', region_id: 'r1' },
      { type: 'text', label: 'b', region_id: 'r2' },
    ],
  })
  const text = renderMixedGuidance(plan)
  assert.match(text, /检测到混合内容（ui \+ document）/)
  assert.match(text, /精度优化/)
  assert.match(text, /detect \/ ground 优先/)
  assert.match(text, /语义优先/)
  assert.equal(renderMixedGuidance(planMixedBranches(undefined)), undefined)
})

test('index.js integration: mixed plan stored on bootstrap completion and injected in followup', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes("bootstrapState.mixedPlan = planMixedBranches(evidence)"), true)
  assert.equal(index.includes("renderMixedGuidance(bootstrapState && bootstrapState.mixedPlan)"), true)
  assert.equal(index.includes("evidence.visual_kind === 'mixed'"), true)
})

test('MAX_MIXED_BRANCHES is two (cost cap)', () => {
  assert.equal(MAX_MIXED_BRANCHES, 2)
})
