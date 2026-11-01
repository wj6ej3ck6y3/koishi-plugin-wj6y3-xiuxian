export interface RootData {
  name: string
  tier: string
  weight: number
  atk: number
}

export interface LevelData {
  name: string
  power: number
  hp: number
  mp: number
  atk: number
  def: number
  spd: number
  expToNext: number
}

export interface Modifier {
  stat: string
  value: number
  mode?: 'pct' | 'flat'
}

export interface GongfaEntry {
  name: string
  weight: number
  tier: string
  modifiers: Modifier[]
  desc: string
}

export interface ShenTongEntry {
  name: string
  weight: number
  type: number
  atkValue: number | number[]
  mpCost: number
  turnCost: number
  rate: number
  desc: string
  buffType?: number
  buffValue?: number
  lifestealPct?: number
}

export interface FuXiuEntry {
  name: string
  weight: number
  tier: string
  effect: string
  value: number
  desc: string
}

export interface WeaponOrArmorEntry {
  name: string
  weight: number
  tier: string
  modifiers: Modifier[]
  desc: string
}

export interface PillEntry {
  name: string
  tag?: string
  type: 'pill'
  weight: number
  realm: number
  usePerTime: number
  dailyLimit: number
  totalStock: number
  modifiers: Modifier[]
  price: { buy: number; sell: number }
  desc: string
}

export interface BodyLevelEntry {
  name: string
  costStone: number | null
  probability: number | null
  modifiers: Modifier[]
}

export interface ResonanceData {
  stages: Record<string, { realm: string[]; body: string[] }>
  synergy: {
    sameStageSameLevel: { buff: Modifier[]; desc: string }
    sameStageDiff1: { buff: Modifier[]; desc: string }
    sameStageDiff2: { buff: Modifier[]; desc: string }
    crossStage: { buff: Modifier[]; desc: string }
  }
}

export interface BreakthroughRates {
  normal: Record<string, { rate: number }>
  big: Record<string, { target: string; rate: number; requirePill: string[] }>
  saint: Record<string, { target: string; rate: number; requirePill: string[] }>
}

export interface ComputedStats {
  hp: number; mp: number; atk: number; def: number; spd: number
  crit: number; critDmg: number; pen: number
}