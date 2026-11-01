import { readFileSync } from 'fs'
import { resolve } from 'path'
import type {
  RootData, LevelData, GongfaEntry, ShenTongEntry, FuXiuEntry,
  WeaponOrArmorEntry, PillEntry, BodyLevelEntry, ResonanceData, BreakthroughRates,
} from './types'

const DATA_DIR = resolve(__dirname, '../data')

function load<T = any>(file: string): Record<string, T> {
  const raw = readFileSync(resolve(DATA_DIR, file), 'utf-8')
  return JSON.parse(raw)
}

export const data = {
  gongfa:       load<GongfaEntry>('功法加成.json'),
  shentong:     load<ShenTongEntry>('神通手段.json'),
  fuxiu:        load<FuXiuEntry>('輔修功法.json'),
  tiers:        load<{ weight: number; color: string }>('品階概率.json'),
  resonance:    load<any>('境界共鳴.json') as ResonanceData,
  levels:       load<LevelData>('境界屬性.json'),
  breakRates:   load<any>('突破概率.json') as BreakthroughRates,
  bodyLevels:   load<BodyLevelEntry>('練體境界.json'),
  sectPositions:load<{ position: number }>('宗門職位.json'),
  bounty:       load<any>('懸賞令.json'),
  pills:        load<PillEntry>('丹藥屬性.json'),
  craftPills:   load<any>('煉丹丹藥.json'),
  furnaces:     load<any>('煉丹爐.json'),
  herbs:        load<any>('煉丹藥材.json'),
  qiFlags:      load<any>('聚靈旗.json'),
  weapons:      load<WeaponOrArmorEntry>('武器屬性.json'),
  armors:       load<WeaponOrArmorEntry>('防具屬性.json'),
  roots:        load<RootData>('靈根屬性.json'),
}

// ---------- 通用查表工具 ----------

export function getRoot(id: string): RootData | undefined { return data.roots[id] }
export function getLevel(id: string): LevelData | undefined { return data.levels[id] }
export function getGongfa(id: string | number): GongfaEntry | undefined { return data.gongfa[String(id)] }
export function getShenTong(id: string | number): ShenTongEntry | undefined { return data.shentong[String(id)] }
export function getFuXiu(id: string | number): FuXiuEntry | undefined { return data.fuxiu[String(id)] }
export function getPill(id: string | number): PillEntry | undefined { return data.pills[String(id)] }
export function getWeapon(id: string | number): WeaponOrArmorEntry | undefined { return data.weapons[String(id)] }
export function getArmor(id: string | number): WeaponOrArmorEntry | undefined { return data.armors[String(id)] }
export function getBodyLevel(id: string | number): BodyLevelEntry | undefined { return data.bodyLevels[String(id)] }

/** 依权重抽取灵根，返回 [id, data] */
export function rollRoot(): [string, RootData] {
  const entries = Object.entries(data.roots)
  const total = entries.reduce((s, [, v]) => s + v.weight, 0)
  let r = Math.random() * total
  for (const [id, v] of entries) {
    r -= v.weight
    if (r <= 0) return [id, v]
  }
  return entries[0]
}

/**
 * 依权重抽取灵根，返回 [id, data]。
 * 排除 ID 升序后前 excludeCount 个低阶灵根，直到剩最高阶灵根为止。
 */
export function rollRootExcluding(excludeCount: number): [string, RootData] {
  const entries = Object.entries(data.roots).sort((a, b) => Number(a[0]) - Number(b[0]))
  const available = entries.slice(Math.max(0, excludeCount))
  if (available.length === 0) return entries[entries.length - 1]
  const total = available.reduce((s, [, v]) => s + v.weight, 0)
  let r = Math.random() * total
  for (const [id, v] of available) {
    r -= v.weight
    if (r <= 0) return [id, v]
  }
  return available[available.length - 1]
}

/** 计算两个境界（"名称"）的共鸣加成 */
export function computeResonance(realmName: string, bodyName: string) {
  const stages = data.resonance.stages
  let realmStage = '', realmIdx = -1
  let bodyStage = '', bodyIdx = -1
  for (const [stage, info] of Object.entries(stages)) {
    let i = info.realm.indexOf(realmName); if (i >= 0) { realmStage = stage; realmIdx = i }
    let j = info.body.indexOf(bodyName); if (j >= 0) { bodyStage = stage; bodyIdx = j }
  }
  if (realmStage === '' || bodyStage === '') return { buff: [], desc: '无共鸣' }
  const syn = data.resonance.synergy
  if (realmStage === bodyStage) {
    const diff = Math.abs(realmIdx - bodyIdx)
    if (diff === 0) return syn.sameStageSameLevel
    if (diff === 1) return syn.sameStageDiff1
    if (diff === 2) return syn.sameStageDiff2
  }
  return syn.crossStage
}

/** 判断 skillId 属于哪类技能 */
export function getSkillType(skillId: number): 'gongfa' | 'fuxiu' | 'shentong' | null {
  const id = String(skillId)
  if (data.gongfa[id]) return 'gongfa'
  if (data.fuxiu[id]) return 'fuxiu'
  if (data.shentong[id]) return 'shentong'
  return null
}

export function getShenTongWeight(id: number): number {
  const st = data.shentong[String(id)]
  if (!st) return 1
  return st.weight ?? 50
}