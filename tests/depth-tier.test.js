import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  depthLimitFor,
  renderDepthGuidance,
  sceneGuidanceFor,
  contentGuidanceFor,
} from '../lib/depth-guidance.js'

// 看图深度档位（移植自 dsh-vision PRECISION）：档位定深挖上限，不参与提示词
// 组合（模板集合，非矩阵）；默认 standard = 现状逐字节不变。

test('depthLimitFor: fast=1, deep=4, standard undefined (no hard cap)', () => {
  assert.equal(depthLimitFor('fast'), 1)
  assert.equal(depthLimitFor('deep'), 4)
  assert.equal(depthLimitFor('standard'), undefined)
  assert.equal(depthLimitFor(undefined), undefined)
})

test('sceneGuidanceFor: known kinds have guidance, general/unknown/mixed release', () => {
  assert.match(sceneGuidanceFor('code'), /逐字/)
  assert.match(sceneGuidanceFor('document'), /语义优先/)
  assert.match(sceneGuidanceFor('ui'), /detect/)
  assert.match(sceneGuidanceFor('chat'), /气泡/)
  assert.equal(sceneGuidanceFor('general'), '') // general 走 content_kind 内容引导
  assert.equal(sceneGuidanceFor('unknown'), '')
  assert.equal(sceneGuidanceFor('mixed'), '')
  assert.equal(sceneGuidanceFor(undefined), '')
})

test('contentGuidanceFor: content kinds have guidance, unknown releases', () => {
  assert.match(contentGuidanceFor('person'), /人物/)
  assert.match(contentGuidanceFor('food'), /食物/)
  assert.match(contentGuidanceFor('vehicle'), /交通工具/)
  assert.equal(contentGuidanceFor('unknown'), '')
})

test('renderDepthGuidance: scene + depth for document', () => {
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'deep' })
  assert.match(text, /语义优先/)
  assert.match(text, /2-4 次充分深挖/)
})

test('renderDepthGuidance: general uses content_kind precise guidance when known', () => {
  const text = renderDepthGuidance({ visualKind: 'general', contentKind: 'food', depth: 'standard' })
  assert.match(text, /食物/)
  assert.match(text, /standard/)
  assert.doesNotMatch(text, /请先判断/) // 已知 content_kind 时不再要求模型自判
})

test('renderDepthGuidance: general falls to self-judge guidance when content_kind unknown', () => {
  const text = renderDepthGuidance({ visualKind: 'general', contentKind: 'unknown', depth: 'standard' })
  assert.match(text, /请先判断图中主体/)
  assert.match(text, /standard/)
})

test('renderDepthGuidance: fast carries tier-insufficient note (dsh-vision answer-section idea)', () => {
  const text = renderDepthGuidance({ visualKind: 'ui', depth: 'fast' })
  assert.match(text, /detect/)
  assert.match(text, /fast/)
  assert.match(text, /升级档位/)
})

test('renderDepthGuidance: unknown releases (depth copy only)', () => {
  const text = renderDepthGuidance({ visualKind: 'unknown', depth: 'standard' })
  assert.match(text, /standard/)
  assert.doesNotMatch(text, /检测到/)
})

test('renderDepthGuidance: invalid depth falls back to standard copy', () => {
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'bogus' })
  assert.match(text, /standard/)
})

test('index.js integration: visionDepth wired into Config, bootstrap state and tool wrapper', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes("visionDepth: z.union(['fast', 'standard', 'deep']).default('standard')"), true)
  assert.equal(index.includes('bootstrapState.visualKind = evidence.visual_kind'), true)
  assert.equal(index.includes('bootstrapState.contentKind = evidence.content_kind'), true)
  assert.equal(index.includes('depthLimitFor(visionDepth())'), true)
  assert.equal(index.includes("code: 'VISION_DEPTH_LIMIT'"), true)
  assert.equal(index.includes('renderDepthGuidance({'), true)
})

test('client.js integration: visionDepth select rendered in Performance group', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(client.includes("const SELECT_KEYS = ['visionDepth']"), true)
  assert.equal(client.includes('selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), ['), true)
  assert.equal(client.includes("selectVisionDepth: '看图深度档位'"), true)
  assert.equal(client.includes("selectVisionDepth: 'Vision depth tier'"), true)
})
