import { Context, Session } from 'koishi'
import {
  data, getLevel, getRoot, getGongfa, getFuXiu, getWeapon, getArmor,
  getBodyLevel, computeResonance, getShenTong, getSkillType, getShenTongWeight,
} from './data'
import { TABLE, Player, BuffRow } from './models'
import type { ComputedStats, Modifier } from './types'

export { getShenTong }

// ======================= 玩家读取 =======================

export async function getPlayer(ctx: Context, userId: string): Promise<Player | null> {
  const rows = await ctx.database.get('wj6y3_xiuxian_player', { userId })
  return rows[0] ?? null
}

export async function requirePlayer(ctx: Context, session: Session): Promise<Player> {
  const p = await getPlayer(ctx, session.userId!)
  if (!p) throw new Error('尚未踏入仙途，请先发送「我要修仙」')
  // uid 懒修复
  if (p.uid === null) {
    let uid: number | null = (session as any).user?.id ?? null
    if (uid === null) {
      const user = await ctx.database.getUser(session.platform as any, session.userId!)
      if (user && typeof user.id === 'number') uid = user.id
    }
    if (uid !== null) {
      await ctx.database.set(TABLE.player, { userId: p.userId }, { uid })
      p.uid = uid
    }
  }
  return p
}

export async function getBuff(ctx: Context, userId: string): Promise<BuffRow> {
  const rows = await ctx.database.get('wj6y3_xiuxian_buff', { userId })
  if (rows[0]) return rows[0]
  const row: BuffRow = {
    userId, mainBuff: 0, secBuff: 0, subBuff: 0,
    faqiBuff: 0, armorBuff: 0, atkBuff: 0, blessedSpot: 0,
    furnaceBuff: 0,
    qiFlagBuff: 0,
  }
  await ctx.database.create('wj6y3_xiuxian_buff', row)
  return row
}
/**
 * 截断（不四舍五入）到指定小数位数。
 * 用于防御力这类「只展示至小数点后 N 位，超出截断」的场景。
 *
 * @param value  原始值
 * @param digits 保留的小数位数（默认 2）
 */
export function truncateDecimal(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = Math.pow(10, digits)
  return Math.floor(value * factor) / factor
}

/**
 * 计算百分比（0~100 整数，向下取整）。
 * 用于气血、真元等「当前 / 上限」显示。
 * max 非法或 ≤ 0 时返回 0，避免除零 NaN。
 */
export function formatPct(current: number, max: number): number {
  if (!max || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor(current / max * 100)))
}

// ======================= 学习制核心：已学技能 =======================

export interface LearnedSkills {
  gongfa: number[]
  fuxiu: number[]
  shentong: number[]
}

/**
 * 读取玩家已学技能（并自动迁移旧 buff 字段）。
 * 迁移后清空 buff.mainBuff/subBuff/secBuff，避免重复迁移。
 */
export async function getLearnedSkills(ctx: Context, userId: string): Promise<LearnedSkills> {
  const buff = await getBuff(ctx, userId)
  const existing = await ctx.database.get(TABLE.skill, { userId })
  const have = new Set(existing.map(r => r.skillId))

  // 旧数据迁移
  const legacy: number[] = []
  if (buff.mainBuff && !have.has(buff.mainBuff)) legacy.push(buff.mainBuff)
  if (buff.subBuff && !have.has(buff.subBuff)) legacy.push(buff.subBuff)
  if (buff.secBuff && !have.has(buff.secBuff)) legacy.push(buff.secBuff)
  if (legacy.length > 0) {
    await ctx.database.upsert(
      TABLE.skill,
      legacy.map(id => ({ userId, skillId: id })),
      ['userId', 'skillId'],
    )
    await ctx.database.set(TABLE.buff, { userId }, { mainBuff: 0, subBuff: 0, secBuff: 0 })
    for (const id of legacy) have.add(id)
  }

  const result: LearnedSkills = { gongfa: [], fuxiu: [], shentong: [] }
  for (const id of have) {
    const t = getSkillType(id)
    if (t) result[t].push(id)
  }
  return result
}

// ======================= 灵石 =======================

function getCurrency(ctx: Context): string {
  const c = (ctx as any).config?.currency
  if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  return '灵石'
}

function getMonetary(ctx: Context): any {
  return ctx.get('monetary')
}

export async function getStone(ctx: Context, uid: number | null): Promise<number> {
  if (uid === null) return 0
  if (!getMonetary(ctx)) return 0
  try {
    const rows = await ctx.database.get('monetary', {
      uid,
      currency: getCurrency(ctx),
    }, ['value'])
    return Number(rows[0]?.value) || 0
  } catch (e) {
    ctx.logger('xiuxian').warn('getStone error:', e)
    return 0
  }
}

export async function addStone(ctx: Context, uid: number | null, amount: number) {
  if (uid === null) return
  const monetary = getMonetary(ctx)
  if (!monetary) return
  const cur = getCurrency(ctx)
  try {
    if (amount > 0) await monetary.gain(uid, amount, cur)
    else if (amount < 0) await monetary.cost(uid, -amount, cur)
  } catch (e) {
    ctx.logger('xiuxian').warn('addStone error:', e)
  }
}

export async function costStone(ctx: Context, uid: number | null, amount: number): Promise<boolean> {
  if (uid === null) return false
  const cur = await getStone(ctx, uid)
  if (cur < amount) return false
  await addStone(ctx, uid, -amount)
  return true
}

// ======================= 属性计算（学习制） =======================

function sumModifiers(mods: Modifier[] | undefined, field: string): number {
  if (!mods) return 0
  return mods.filter(m => m.stat === field && (m.mode ?? 'pct') === 'pct')
             .reduce((s, m) => s + m.value, 0)
}

export async function computeStats(ctx: Context, player: Player): Promise<ComputedStats> {
  const lv = getLevel(player.level)
  if (!lv) return { hp: 0, mp: 0, atk: 0, def: 0, spd: 0, crit: 0, critDmg: 0, pen: 0 }

  const buff = await getBuff(ctx, player.userId)
  const learned = await getLearnedSkills(ctx, player.userId)
  const modifiers: Modifier[] = []

  // ✅ 已学主功法：全部累计
  for (const gid of learned.gongfa) {
    const g = getGongfa(gid)
    if (g?.modifiers) modifiers.push(...g.modifiers)
  }

  // ✅ 已学辅修：按 effect 累计
  for (const fid of learned.fuxiu) {
    const sub = getFuXiu(fid)
    if (!sub) continue
    if (sub.effect === 'hpPct') modifiers.push({ stat: 'hp', value: sub.value / 100 })
    else if (sub.effect === 'damageBoost') modifiers.push({ stat: 'atk', value: sub.value / 100 })
    // 其它 effect（lifesteal 等）在战斗内单独处理
  }

  // 武器 / 防具
  const w = buff.faqiBuff ? getWeapon(buff.faqiBuff)?.modifiers : []
  if (w) modifiers.push(...w)
  const a = buff.armorBuff ? getArmor(buff.armorBuff)?.modifiers : []
  if (a) modifiers.push(...a)

  // 炼体 + 共鸣
  const body = player.exercisesLevel ? getBodyLevel(player.exercisesLevel) : undefined
  if (body?.modifiers) modifiers.push(...(body.modifiers as Modifier[]))

  const bodyName = body?.name || ''
  const res = computeResonance(lv.name, bodyName)
  if (res.buff) modifiers.push(...(res.buff as Modifier[]))

  const root = getRoot(player.root)
  const rootAtkMul = root?.atk ?? 1

  const hpMul = 1 + sumModifiers(modifiers, 'hp')
  const mpMul = 1 + sumModifiers(modifiers, 'mp')
  const defMul = 1 + sumModifiers(modifiers, 'def')
  const spdMul = 1 + sumModifiers(modifiers, 'spd')

  const atkFlatBonus = buff.atkBuff || 0
  const atkPracticeMul = 1 + (player.atkPractice || 0) * 0.04
  const baseAtk = lv.atk * rootAtkMul + atkFlatBonus
  const atk = baseAtk * (1 + sumModifiers(modifiers, 'atk')) * atkPracticeMul

  const crit = 0.05 + sumModifiers(modifiers, 'crit')
  const critDmg = 1.5 + sumModifiers(modifiers, 'critDmg')
  const pen = sumModifiers(modifiers, 'pen')

  return {
    hp: Math.round(lv.hp * hpMul),
    mp: Math.round(lv.mp * mpMul),
    atk: Math.round(atk),
    def: Math.min(95, lv.def * defMul),
    spd: Math.round(lv.spd * spdMul),
    crit, critDmg, pen,
  }
}

/** 单独计算已学功法的 cultivateSpeed 累计（用于闭关） */
export async function computeCultivateSpeed(ctx: Context, userId: string): Promise<number> {
  const learned = await getLearnedSkills(ctx, userId)
  let total = 0
  for (const gid of learned.gongfa) {
    const g = getGongfa(gid)
    if (!g?.modifiers) continue
    for (const m of g.modifiers) {
      if (m.stat === 'cultivateSpeed' && (m.mode ?? 'pct') === 'pct') total += m.value
    }
  }
  return total
}

export async function refreshPlayerStats(ctx: Context, player: Player) {
  const st = await computeStats(ctx, player)
  const lv = getLevel(player.level)!
  player.maxhp = Math.floor(st.hp)
  player.maxmp = Math.floor(st.mp)
  player.atk = Math.floor(st.atk)
  player.hp = Math.floor(Math.min(player.hp, st.hp))
  player.mp = Math.floor(Math.min(player.mp, st.mp))
  player.power = Math.round(lv.power * (1 + (st.atk / (lv.atk || 1) - 1) * 0.5))
  await ctx.database.set('wj6y3_xiuxian_player', { userId: player.userId }, {
    maxhp: player.maxhp, maxmp: player.maxmp,
    atk: player.atk, hp: player.hp, mp: player.mp,
    power: player.power,
  })
  return st
}

// ======================= 突破 =======================

export interface BreakthroughCheck {
  nextLevelId: string | null
  currentName: string
  rate: number
  requirePill: string[]
  big: boolean
  expRequired: number
  canBreak: boolean
  message?: string
}

export function checkBreakthrough(player: Player): BreakthroughCheck {
  const lv = getLevel(player.level)
  if (!lv) return { nextLevelId: null, currentName: '?', rate: 0, requirePill: [], big: false, expRequired: 0, canBreak: false, message: '境界数据缺失' }
  const nextId = String(parseInt(player.level, 10) + 1)
  const nextLv = getLevel(nextId)
  if (!nextLv) return { nextLevelId: null, currentName: lv.name, rate: 0, requirePill: [], big: false, expRequired: lv.expToNext, canBreak: false, message: '已至绝巅，唯有飞升' }

  const big = data.breakRates.big[lv.name]
  const saint = data.breakRates.saint[lv.name]
  let rate = 0
  let requirePill: string[] = []
  let isBig = false
  if (big) { rate = big.rate; requirePill = big.requirePill || []; isBig = true }
  else if (saint) { rate = saint.rate; requirePill = saint.requirePill || []; isBig = true }
  else {
    const n = data.breakRates.normal[lv.name]
    rate = n?.rate ?? 100
  }
  rate += player.levelUpRate || 0
  if (rate > 100) rate = 100

  const expRequired = lv.expToNext
  const hasExp = player.exp >= expRequired
  return {
    nextLevelId: nextId, currentName: lv.name, rate,
    requirePill, big: isBig, expRequired, canBreak: hasExp,
    message: hasExp ? undefined : `修为不足（${Math.floor(player.exp)}/${expRequired}）`,
  }
}

//======================= 丹藥tag =======================
export const ALL_ITEM_TABLES = () => ({
  ...Object.fromEntries(Object.entries(data.pills).map(([k, v]) => [k, { ...v, _type: 'pill' }])),
  ...Object.fromEntries(Object.entries(data.gongfa).map(([k, v]) => [k, { ...v, _type: 'gongfa' }])),
  ...Object.fromEntries(Object.entries(data.shentong).map(([k, v]) => [k, { ...v, _type: 'shentong' }])),
  ...Object.fromEntries(Object.entries(data.fuxiu).map(([k, v]) => [k, { ...v, _type: 'fuxiu' }])),
  ...Object.fromEntries(Object.entries(data.weapons).map(([k, v]) => [k, { ...v, _type: 'weapon' }])),
  ...Object.fromEntries(Object.entries(data.armors).map(([k, v]) => [k, { ...v, _type: 'armor' }])),
  ...Object.fromEntries(Object.entries(data.qiFlags).map(([k, v]) => [k, { ...v, _type: 'qiflag' }])),
  ...Object.fromEntries(Object.entries(data.craftPills).map(([k, v]) => [k, { ...v, _type: 'pill' }])),
  ...Object.fromEntries(Object.entries(data.herbs).map(([k, v]) => [k, { ...v, _type: 'herb' }])),
  ...Object.fromEntries(Object.entries(data.furnaces).map(([k, v]) => [k, { ...v, _type: 'furnace' }])),
})

// ======================= 背包 =======================

export async function addItem(ctx: Context, userId: string, goodsId: number, num = 1) {
  const exist = await ctx.database.get('wj6y3_xiuxian_back', { userId, goodsId })
  if (exist[0]) {
    await ctx.database.set('wj6y3_xiuxian_back', { userId, goodsId }, {
      goodsNum: exist[0].goodsNum + num,
      updateTime: new Date(),
    })
  } else {
    await ctx.database.create('wj6y3_xiuxian_back', {
      userId, goodsId, goodsNum: num,
      createTime: new Date(), updateTime: new Date(),
      dayNum: 0, allNum: 0, actionTime: new Date(0),
      state: 0, bindNum: 0,
    })
  }
}

/** 在玩家背包内按名字查找物品（按物品名字匹配玩家实际持有的 goodsId） */
export async function findItemInBackpack(
  ctx: Context, userId: string, name: string,
): Promise<[string, any] | null> {
  const backRows = await ctx.database.get(TABLE.back, { userId })
  const all = ALL_ITEM_TABLES()
  for (const it of backRows) {
    if ((it.goodsNum ?? 0) <= 0) continue
    const meta = all[it.goodsId]
    if (meta && (meta as any).name === name) return [String(it.goodsId), meta]
  }
  return null
}

/**
 * 从背包移除物品。
 * @param keepEmptyRow true 时数量归零但保留行（用于追踪 dayNum/allNum）；
 *                     false 时直接删除行。
 */
export async function removeItem(
  ctx: Context,
  userId: string,
  goodsId: number,
  num = 1,
  keepEmptyRow = false,
): Promise<boolean> {
  const rows = await ctx.database.get('wj6y3_xiuxian_back', { userId, goodsId })
  if (!rows[0] || rows[0].goodsNum < num) return false

  if (rows[0].goodsNum === num) {
    if (keepEmptyRow) {
      await ctx.database.set('wj6y3_xiuxian_back', { userId, goodsId }, { goodsNum: 0 })
    } else {
      await ctx.database.remove('wj6y3_xiuxian_back', { userId, goodsId })
    }
  } else {
    await ctx.database.set('wj6y3_xiuxian_back', { userId, goodsId }, {
      goodsNum: rows[0].goodsNum - num,
    })
  }
  return true
}

// ======================= 统一的战斗前置入口 =======================

export interface PlayerBattleReady {
  player: Player
  stats: ComputedStats
  unit: CombatUnit
}

/**
 * 统一战斗前置：读玩家 → 检查气血 → 计算属性 → 构造战斗单位。
 * 气血枯竭时返回 string（直接作为命令回复），正常时返回对象。
 */
export async function preparePlayerBattle(
  ctx: Context,
  session: Session,
): Promise<PlayerBattleReady | string> {
  const player = await requirePlayer(ctx, session)
  if (!Number.isFinite(player.hp)) {
    return '⚠️ 气血数据异常，请联系管理员'
  }
  // 重伤阈值：至少 1% 上限气血才能出战
  const threshold = Math.max(1, Math.floor(player.maxhp * 0.01))
  if (player.hp < threshold) {
    return `你身受重伤，请服丹或出关疗伤后再战`
  }
  const stats = await computeStats(ctx, player)
  const unit = await buildPlayerUnit(ctx, player, stats)
  return { player, stats, unit }
}

// ======================= 战斗引擎（含神通释放） =======================

export interface CombatUnit {
  name: string
  hp: number; maxhp: number
  mp: number; maxmp: number
  atk: number; def: number; spd: number
  crit: number; critDmg: number; pen: number
  /** 已学神通 ID 列表（学习制） */
  shenTongIds?: number[]
  /** 吸血%（来自辅修） */
  lifesteal?: number
  /** 临时 buff 状态（type 3 神通施加） */
  tempAtkMul?: number
  tempDefMul?: number
  tempBuffRemain?: number
  /**
   * 持续伤害列表：每回合按 source 当前状态重算（暴击/浮动/半防/保底 1）
   */
  dotList?: Array<{
    /** 每回合伤害倍率（源攻击 × multiplier） */
    multiplier: number
    /** 剩余回合 */
    remainTurns: number
    /** 显示用的名字 */
    sourceName: string
    /** 施加者的活引用，用于取 atk / crit / critDmg / tempAtkMul / pen */
    source: CombatUnit
  }>
  userId?: string
}

export interface BattleLogEntry { round: number; text: string }

export async function buildPlayerUnit(ctx: Context, p: Player, st: ComputedStats, name = ''): Promise<CombatUnit> {
  const learned = await getLearnedSkills(ctx, p.userId)
  let lifesteal = 0
  for (const fid of learned.fuxiu) {
    const sub = getFuXiu(fid)
    if (sub?.effect === 'lifesteal') lifesteal += sub.value / 100
  }

  // 隐患 1：用 ?? 而非 ||，避免 0 血被 fallback 成满血
  // 隐患 2：hp/mp 钳制到 [1, maxhp]，保证不会倒挂、也不会 0 血卡死
  const rawHp = p.hp ?? st.hp
  const rawMp = p.mp ?? st.mp

  return {
    name: name || p.userName,
    hp: Math.min(rawHp, st.hp),
    maxhp: st.hp,
    mp: Math.min(rawMp, st.mp),
    maxmp: st.mp,
    atk: st.atk, def: st.def, spd: st.spd,
    crit: st.crit, critDmg: st.critDmg, pen: st.pen,
    shenTongIds: learned.shentong,
    lifesteal,
    userId: p.userId,
  }
}

/**
 * 统一伤害计算管道（普攻 / 神通每段 / DoT 每回合 全部走这里）
 *
 * @param attacker   攻击方
 * @param defender   防守方
 * @param multiplier 伤害倍率（普攻 = 1；神通 = atkValue；DoT = 记录的 multiplier）
 * @param defFactor  防御系数（普攻 1；神通 / DoT 均 0.5）
 *
 * 计算顺序：
 *   1 攻击 × 增益倍率 × 伤害倍率
 *   2 暴击判定（触发则 × critDmg）
 *   3 伤害浮动 ×[0.9, 1.1]
 *   4 计算有效防御（含防守方减伤、穿透、防御系数）
 *   5 扣防 → 保底 1
 *
 * ⚠️ 全流程仅在最后一步保底 1，中间不做 max(1, …) 截断。
 */
export function calcOneHit(
  attacker: CombatUnit,
  defender: CombatUnit,
  multiplier: number,
  defFactor: number,
): { dmg: number; crit: boolean } {
  // 1 攻击 × 增益倍率 × 伤害倍率
  let raw = attacker.atk * (attacker.tempAtkMul ?? 1) * multiplier

  // 2 暴击
  const crit = Math.random() < attacker.crit
  if (crit) raw *= attacker.critDmg

  // 3 伤害浮动 ±10%
  raw *= (0.9 + Math.random() * 0.2)

  // 4 减伤%（穿透可部分无视减伤）
  //    def 已是百分比（0~95），defFactor 仅影响「神通/普攻是否用全量减伤」
  const defReduce = (defender.def / 100) * defFactor * (1 - attacker.pen)
  const appliedDefReduce = Math.min(0.95, Math.max(0, defReduce))

  // 5 乘算减伤 → 保底 1
  const dmg = Math.max(1, Math.floor(raw * (1 - appliedDefReduce)))
  return { dmg, crit }
}

/** 普攻在神通池中的权重 */
const BASIC_ATTACK_WEIGHT = 200

function pickAction(
  unit: CombatUnit,
  cdMap: Map<number, number>,
): { kind: 'basic' } | { kind: 'shentong'; id: number } {
  const pool: Array<{ kind: 'basic'; weight: number } | { kind: 'shentong'; id: number; weight: number }> = [
    { kind: 'basic', weight: BASIC_ATTACK_WEIGHT },
  ]
  if (unit.shenTongIds && unit.shenTongIds.length > 0) {
    for (const id of unit.shenTongIds) {
      if ((cdMap.get(id) ?? 0) > 0) continue     // 冷却中跳过
      const st = getShenTong(id)
      if (!st) continue
      // mp 不够也过滤掉，避免选中后释放失败浪费回合
      if (unit.mp < st.mpCost * unit.maxmp) continue
      pool.push({ kind: 'shentong', id, weight: getShenTongWeight(id) })
    }
  }
  const total = pool.reduce((s, x) => s + x.weight, 0)
  let r = Math.random() * total
  for (const x of pool) {
    r -= x.weight
    if (r <= 0) return x.kind === 'basic' ? { kind: 'basic' } : { kind: 'shentong', id: x.id }
  }
  return { kind: 'basic' }
}

export function simulateBattle(a: CombatUnit, b: CombatUnit, maxRound = 30): {
  winner: 'a' | 'b' | 'draw'; log: BattleLogEntry[]
} {
  const log: BattleLogEntry[] = []
  const cdA = new Map<number, number>()
  const cdB = new Map<number, number>()

  const doTurn = (att: CombatUnit, def: CombatUnit, cdMap: Map<number, number>, round: number): boolean => {
    if (att.hp <= 0 || def.hp <= 0) return false
    const action = pickAction(att, cdMap)

    // ===== 普攻 =====
    if (action.kind === 'basic') {
      const { dmg, crit } = calcOneHit(att, def, 1, 1)
      def.hp = Math.max(0, def.hp - dmg)
      log.push({ round, text: `${att.name} 攻击 ${def.name} 造成 ${dmg}${crit ? '（暴击！）' : ''}，剩 ${def.hp}/${def.maxhp}` })
      if (att.lifesteal && att.lifesteal > 0) {
        const heal = Math.floor(dmg * att.lifesteal)
        if (heal > 0) att.hp = Math.min(att.maxhp, att.hp + heal)
      }
      return def.hp <= 0
    }

    // ===== 神通 =====
    const st = getShenTong(action.id)
    if (!st) return false
    att.mp -= Math.floor(st.mpCost * att.maxmp)
    cdMap.set(action.id, st.turnCost)   // turnCost = 冷却/持续回合数

    if (Math.random() * 100 >= st.rate) {
      log.push({ round, text: `${att.name} 施展「${st.name}」但未命中` })
      return false
    }

    // ===== type 3：增减益（无伤害，持续 = 冷却 = turnCost）=====
    if (st.type === 3) {
      if (st.buffType === 1) {
        att.tempAtkMul = (att.tempAtkMul ?? 1) * (1 + (st.buffValue ?? 0))
        att.tempBuffRemain = Math.max(att.tempBuffRemain ?? 0, st.turnCost)
        log.push({ round, text: `${att.name} 施展「${st.name}」，攻击提升 ${Math.floor((st.buffValue ?? 0) * 100)}%（${st.turnCost} 回合）` })
      } else if (st.buffType === 2) {
        att.tempDefMul = (att.tempDefMul ?? 1) * (1 + (st.buffValue ?? 0))
        att.tempBuffRemain = Math.max(att.tempBuffRemain ?? 0, st.turnCost)
        log.push({ round, text: `${att.name} 施展「${st.name}」，减伤提升 ${Math.floor((st.buffValue ?? 0) * 100)}%（${st.turnCost} 回合）` })
      }
      return false
    }

    // ===== type 2：持续伤害（首击即时 + DoT turnCost-1 回合，全部走统一管道）=====
    if (st.type === 2) {
      const mul = Number(st.atkValue) || 0

      // 首击即时结算（暴击 / 浮动 / 半防 / 保底 1）
      const first = calcOneHit(att, def, mul, 0.5)
      def.hp = Math.max(0, def.hp - first.dmg)
      log.push({
        round,
        text: `${att.name} 施展「${st.name}」造成 ${first.dmg}${first.crit ? '（暴击！）' : ''} 伤害，剩 ${def.hp}/${def.maxhp}`,
      })

      if (st.turnCost && st.turnCost > 1) {
        def.dotList = def.dotList ?? []
        const exist = def.dotList.find(d => d.sourceName === st.name)
        if (exist) {
          exist.multiplier = Math.max(exist.multiplier, mul)
          exist.remainTurns = Math.max(exist.remainTurns, st.turnCost - 1)
          exist.source = att
        } else {
          def.dotList.push({
            multiplier: mul,
            remainTurns: st.turnCost - 1,
            sourceName: st.name,
            source: att,
          })
        }
        log.push({
          round,
          text: `${def.name} 陷入「${st.name}」持续伤害（每回合 ×${mul.toFixed(2)} 重算，共 ${st.turnCost} 次）`,
        })
      }
      return def.hp <= 0
    }

    // ===== type 1 / type 4：多段伤害，每段独立结算（暴击 / 浮动 / 半防 / 保底 1）=====
    const values = Array.isArray(st.atkValue) ? st.atkValue : [st.atkValue]
    let totalDmg = 0
    let anyCrit = false
    for (const v of values) {
      const { dmg, crit } = calcOneHit(att, def, v, 0.5)
      totalDmg += dmg
      if (crit) anyCrit = true
    }
    def.hp = Math.max(0, def.hp - totalDmg)
    log.push({
      round,
      text: `${att.name} 施展「${st.name}」（${values.length} 段）造成 ${totalDmg} 伤害${anyCrit ? '（暴击！）' : ''}，剩 ${def.hp}/${def.maxhp}`,
    })

    if (st.lifestealPct) {
      const heal = Math.floor(totalDmg * st.lifestealPct)
      if (heal > 0) {
        att.hp = Math.min(att.maxhp, att.hp + heal)
        log.push({ round, text: `${att.name} 吸取 ${heal} 气血` })
      }
    }
    return def.hp <= 0
  }

  // ===== 主循环：每回合双方轮流出手 =====
  for (let r = 1; r <= maxRound; r++) {
    const order: Array<[CombatUnit, CombatUnit, 'a' | 'b', Map<number, number>]> = a.spd >= b.spd
      ? [[a, b, 'a', cdA], [b, a, 'b', cdB]]
      : [[b, a, 'b', cdB], [a, b, 'a', cdA]]
    for (const [att, def, side, cd] of order) {
      if (doTurn(att, def, cd, r)) return { winner: side, log }
    }

    // ===== 回合末：CD -1 =====
    for (const [id, v] of cdA) if (v > 0) cdA.set(id, v - 1)
    for (const [id, v] of cdB) if (v > 0) cdB.set(id, v - 1)

    // ===== 回合末：buff 计时 -1、DoT 结算（每回合独立重算）=====
    for (const u of [a, b]) {
      if (u.tempBuffRemain && u.tempBuffRemain > 0) {
        u.tempBuffRemain -= 1
        if (u.tempBuffRemain === 0) { u.tempAtkMul = undefined; u.tempDefMul = undefined }
      }
      if (u.dotList && u.dotList.length > 0) {
        for (const dot of u.dotList) {
          // DoT 走统一管道：暴击 / 浮动 / 半防 / 保底 1，源攻击取施加者实时状态
          const { dmg, crit } = calcOneHit(dot.source, u, dot.multiplier, 0.5)
          u.hp = Math.max(0, u.hp - dmg)
          log.push({
            round: r,
            text: `${u.name} 受到「${dot.sourceName}」持续伤害 ${dmg}${crit ? '（暴击！）' : ''}，剩 ${u.hp}/${u.maxhp}`,
          })
          dot.remainTurns -= 1
        }
        u.dotList = u.dotList.filter(d => d.remainTurns > 0)
        if (u.hp <= 0) return { winner: u === a ? 'b' : 'a', log }
      }
    }
  }

  const aPct = a.hp / a.maxhp, bPct = b.hp / b.maxhp
  return { winner: aPct > bPct ? 'a' : bPct > aPct ? 'b' : 'draw', log }
}

// ======================= 战斗记录内存暂存 =======================

export interface BattleRecord {
  /** 记录写入时间戳 */
  ts: number
  /** 战斗标题（如「讨伐世界 BOSS「远古魔龙」」） */
  title: string
  /** 战斗日志 */
  log: BattleLogEntry[]
  /** 战斗结果（'a' 为玩家方胜，'b' 为对手胜，'draw' 平局） */
  winner: 'a' | 'b' | 'draw'
  /** 玩家单位名称 */
  playerName: string
  /** 对手单位名称 */
  opponentName: string
}

/** 记录战斗的可选参数 */
export interface BattleRecordOptions {
  /** 对手 userId。传了则双方都记录 */
  opponentUserId?: string
  /** 对手视角的标题（不传则与主角相同） */
  opponentTitle?: string
}

const BATTLE_RECORD_TTL = 120_000   // 120 秒
const _battleRecords = new Map<string, BattleRecord>()

/** 写入战斗记录（默认只写主角；传 opponentUserId 则双方都写） */
export function recordBattle(
  userId: string,
  record: BattleRecord,
  options?: BattleRecordOptions,
): void {
  // ===== 主角视角 =====
  _battleRecords.set(userId, record)
  setTimeout(() => {
    const cur = _battleRecords.get(userId)
    if (cur && cur.ts === record.ts) _battleRecords.delete(userId)
  }, BATTLE_RECORD_TTL)

  // ===== 对手视角（可选）=====
  const oppId = options?.opponentUserId
  if (!oppId) return
  const flipped: BattleRecord = {
    ts: record.ts,
    title: options.opponentTitle ?? record.title,
    log: record.log,
    winner: record.winner === 'a' ? 'b' : record.winner === 'b' ? 'a' : 'draw',
    playerName: record.opponentName,
    opponentName: record.playerName,
  }
  _battleRecords.set(oppId, flipped)
  setTimeout(() => {
    const cur = _battleRecords.get(oppId)
    if (cur && cur.ts === flipped.ts) _battleRecords.delete(oppId)
  }, BATTLE_RECORD_TTL)
}

/** 读取战斗记录（过期返回 null） */
export function getBattleRecord(userId: string): BattleRecord | null {
  const rec = _battleRecords.get(userId)
  if (!rec) return null
  if (Date.now() - rec.ts > BATTLE_RECORD_TTL) {
    _battleRecords.delete(userId)
    return null
  }
  return rec
}

/** 战斗记录 TTL（供命令显示剩余秒数） */
export function getBattleRecordTtl(): number {
  return BATTLE_RECORD_TTL
}

// ======================= 每日重置 =======================

export async function resetDaily(ctx: Context) {
  const all = await ctx.database.get('wj6y3_xiuxian_player', {})
  for (const p of all) {
    await ctx.database.set('wj6y3_xiuxian_player', { userId: p.userId }, {
      riftDailyCount: 0, workRefreshCount: 0, dualCultivation: 0,
    })
  }
}

// ======================= 单次限定突破丹 =======================

/** 判断是否为单次限定突破丹（breakthroughBigRate 类） */
export function isOneShotBreakthroughPill(pill: any): boolean {
  return pill?.modifiers?.some((m: any) => m.stat === 'breakthroughBigRate')
}

/** 取该丹的突破率加成值（%），非单次丹返回 0 */
export function getOneShotBreakthroughValue(pill: any): number {
  const bt = pill?.modifiers?.find((m: any) => m.stat === 'breakthroughBigRate')
  return bt?.value ?? 0
}

/** 查询玩家已服用的某颗单次丹（是否整局已用） */
export async function isOneShotPillUsed(
  ctx: Context, userId: string, pillId: number,
): Promise<boolean> {
  const rows = await ctx.database.get('wj6y3_xiuxian_pill_used', { userId, pillId })
  return rows.length > 0
}

/** 突破时计算本次目标境界可用的单次丹加成 */
export async function computeOneShotBreakthroughBonus(
  ctx: Context, userId: string, currentLevel: string,
): Promise<{ bonus: number; pillIds: number[] }> {
  const targetNext = String(parseInt(currentLevel, 10) + 1)
  const rows = await ctx.database.get('wj6y3_xiuxian_pill_used', {
    userId, targetLevelId: targetNext,
  })
  let bonus = 0
  const pillIds: number[] = []
  for (const r of rows) {
    const pill = data.pills[String(r.pillId)] ?? data.craftPills[String(r.pillId)]
    if (!pill) continue
    bonus += getOneShotBreakthroughValue(pill)
    pillIds.push(r.pillId)
  }
  return { bonus, pillIds }
}

// ======================= 聚灵旗 =======================

/** 每级聚灵旗对修为的加成（0.1 = +10%），想改数值直接改这里 */
const QI_CULTIVATE_PER_LEVEL = 0.1
/** 每级聚灵旗对灵田时间的加速（0.2 意味 5 级 2 倍速），想改数值直接改这里 */
const QI_HERB_PER_LEVEL = 0.2

export interface QiFlagBonus {
  /** 修为倍率（≥1，越大越好） */
  cultivateMul: number
  /** 灵田时间倍率（≤1，越小越快） */
  herbTimeMul: number
  /** 当前旗名称（若未装备则空串） */
  name: string
}

// ======================= 悬赏令掉落池 =======================

export interface DropEntry {
  category: string
  id: number
  name: string
  weight: number
}

type CategoryPool = Record<string, DropEntry[]>

let _dropPoolCache: CategoryPool | null = null

/** 构建全物品池（按类别分组），首次调用后缓存 */
export function buildDropPool(): CategoryPool {
  if (_dropPoolCache) return _dropPoolCache
  const pool: CategoryPool = {
    pill: [], craftPill: [], herb: [], weapon: [], armor: [],
    gongfa: [], shentong: [], fuxiu: [], qiFlag: [], furnace: [],
  }

  const push = (cat: keyof CategoryPool, id: string, v: any) => {
    if (!v?.name) return
    pool[cat].push({
      category: cat, id: Number(id), name: v.name,
      weight: Math.max(1, Number(v.weight) || 1),
    })
  }

  for (const [id, v] of Object.entries(data.pills)) push('pill', id, v)
  for (const [id, v] of Object.entries(data.craftPills)) push('craftPill', id, v)
  for (const [id, v] of Object.entries(data.herbs)) push('herb', id, v)
  for (const [id, v] of Object.entries(data.weapons)) push('weapon', id, v)
  for (const [id, v] of Object.entries(data.armors)) push('armor', id, v)
  for (const [id, v] of Object.entries(data.gongfa)) push('gongfa', id, v)
  for (const [id, v] of Object.entries(data.shentong)) push('shentong', id, v)
  for (const [id, v] of Object.entries(data.fuxiu)) push('fuxiu', id, v)
  for (const [id, v] of Object.entries(data.qiFlags)) push('qiFlag', id, v)
  for (const [id, v] of Object.entries(data.furnaces)) push('furnace', id, v)

  _dropPoolCache = pool
  return pool
}

/** 按权重抽类别 */
function pickCategory(weights: Record<string, number>, pool: CategoryPool): string | null {
  const entries = Object.entries(weights).filter(([k, w]) => w > 0 && (pool[k]?.length ?? 0) > 0)
  if (entries.length === 0) return null
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let r = Math.random() * total
  for (const [k, w] of entries) {
    r -= w
    if (r <= 0) return k
  }
  return entries[0][0]
}

/** 在类别内按物品 weight 抽 */
function pickItemInCategory(category: string, pool: CategoryPool): DropEntry | null {
  const items = pool[category] ?? []
  if (items.length === 0) return null
  const total = items.reduce((s, it) => s + it.weight, 0)
  let r = Math.random() * total
  for (const it of items) {
    r -= it.weight
    if (r <= 0) return it
  }
  return items[items.length - 1]
}

/** 从全局权重池抽 1 件物品（供悬赏令生成列表时调用） */
export function rollSingleDrop(categoryWeights: Record<string, number>): DropEntry | null {
  const pool = buildDropPool()
  const cat = pickCategory(categoryWeights, pool)
  if (!cat) return null
  return pickItemInCategory(cat, pool)
}

export async function getQiFlagBonus(ctx: Context, userId: string): Promise<QiFlagBonus> {
  const buff = await getBuff(ctx, userId)
  if (!buff.qiFlagBuff) return { cultivateMul: 1, herbTimeMul: 1, name: '' }
  const flag = data.qiFlags[String(buff.qiFlagBuff)]
  if (!flag) return { cultivateMul: 1, herbTimeMul: 1, name: '' }
  const cultivateMul = 1 + (flag.cultivateSpeed ?? 0) * QI_CULTIVATE_PER_LEVEL
  const herbTimeMul = 1 / (1 + (flag.herbSpeed ?? 0) * QI_HERB_PER_LEVEL)
  return { cultivateMul, herbTimeMul, name: flag.name ?? '' }
}

// ======================= 通用：物品 ID → 名称 =======================

/** 从全部物品表中按 ID 查名称，找不到返回 "#id" */
export function getItemNameById(goodsId: number | string): string {
  const id = String(goodsId)
  const sources: Array<Record<string, any>> = [
    data.pills, data.craftPills, data.herbs,
    data.weapons, data.armors,
    data.gongfa, data.shentong, data.fuxiu,
    data.qiFlags, data.furnaces,
  ]
  for (const s of sources) {
    const v = s[id]
    if (v?.name) return v.name
  }
  return `#${id}`
}

// ======================= 属性字段名中文映射 =======================

/**
 * 属性字段名 → 中文
 * 未来新增 stat 只需在此加一行；未收录的字段自动回退显示原 key
 */
const STAT_LABEL_MAP: Record<string, string> = {
  // 基础属性
  hp: '气血',
  mp: '真元',
  atk: '攻击',
  def: '防御',
  spd: '速度',
  // 战斗属性
  crit: '会心',
  critDmg: '暴伤',
  pen: '穿透',
  // 修炼 / 突破
  cultivateSpeed: '修炼速度',
  exp: '修为',
  breakthroughRate: '突破率',
  breakthroughBigRate: '大境界突破率',
}

/** 属性字段名转中文，未收录时返回原字段名 */
export function statLabel(stat: string): string {
  return STAT_LABEL_MAP[stat] ?? stat
}

// ======================= 通用：自增 ID 分配 =======================

import type { Tables } from 'koishi'

/**
 * 手动分配下一个自增 ID（从 1 开始，0 保留为无效值）。
 * 用于规避部分数据库 adapter 将 AUTO_INCREMENT 从 0 开始或未正确建表的问题。
 * 
 * @param ctx 上下文
 * @param table 表名（必须存在于 Tables 中）
 * @param idField 主键字段名
 */
export async function getNextId<K extends keyof Tables>(
  ctx: Context,
  table: K,
  idField: keyof Tables[K] & string,
): Promise<number> {
  const rows = await ctx.database.get(table, {}, { sort: { [idField]: 'desc' } as any, limit: 1 })
  const maxId = (rows[0] as any)?.[idField]
  return (maxId !== undefined && maxId >= 1) ? Number(maxId) + 1 : 1
}

// ======================= 通用：物品品阶反查 =======================

/** weight → 品阶名称 缓存 */
let _tierMapCache: Map<number, string> | null = null

function getTierMap(): Map<number, string> {
  if (_tierMapCache) return _tierMapCache
  const m = new Map<number, string>()
  for (const [name, info] of Object.entries(data.tiers as Record<string, { weight: number }>)) {
    m.set(info.weight, name)
  }
  _tierMapCache = m
  return m
}

/**
 * 按物品 ID 反查品阶名称（如：人阶下品）
 * 
 * 规则：
 * - 药材：返回 "N 阶药材"（tier 1~9）
 * - 丹药 / 炼丹丹药 / 聚灵旗 / 炼丹炉：无品阶概念，返回空串
 * - 功法 / 辅修 / 武器 / 防具 / 神通：通过 weight 反查品阶概率表
 */
export function getQualityLabel(goodsId: number | string): string {
  const id = String(goodsId)

  // 1. 药材：tier 1~9 显示为 "N 阶药材"
  const herb = data.herbs[id]
  if (herb && typeof herb.tier === 'number') {
    return `${herb.tier} 阶药材`
  }

  // 2. 无品阶物品：直接返回空
  if (data.pills[id] || data.craftPills[id] || data.qiFlags[id] || data.furnaces[id]) {
    return ''
  }

  // 3. 有 weight 的物品：按品阶概率表反查
  const qualityTables: Array<Record<string, any>> = [
    data.gongfa, data.fuxiu, data.weapons, data.armors, data.shentong,
  ]
  for (const t of qualityTables) {
    const item = t[id]
    if (item && typeof item.weight === 'number') {
      const name = getTierMap().get(item.weight)
      if (name) return name
    }
  }

  return ''
}

/**
 * 把剩余毫秒格式化为人类可读的单单位字符串。
 * 单位选择：≥1 小时 → 小时；≥1 分钟 → 分钟；否则 → 秒。
 * 向上取整，保证显示时间 ≥ 真实剩余量。
 */
export function formatRemainTime(remainMs: number): string {
  const remainSec = Math.max(0, remainMs) / 1000
  if (remainSec >= 3600) return `${Math.ceil(remainSec / 3600)} 小时`
  if (remainSec >= 60) {
    const m = Math.ceil(remainSec / 60)
    return m >= 60 ? `1 小时` : `${m} 分钟`
  }
  return `${Math.max(1, Math.ceil(remainSec))} 秒`
}

// ======================= 通用：物品估价 =======================

/**
 * 估算物品价格。
 * - 普通丹药优先使用 JSON 官方定价（price.buy）
 * - 其它物品按权重反推：BASE_PRICE / weight（权重越高越常见越便宜）
 * - 保底 100 灵石
 */
export function estimatePrice(goodsId: number | string): number {
  const id = String(goodsId)

  const pill = data.pills[id]
  if (pill?.price?.buy) return pill.price.buy

  let weight = 50 // 默认权重
  if (data.craftPills[id]) weight = data.craftPills[id].weight
  else if (data.herbs[id]) weight = data.herbs[id].weight
  else if (data.weapons[id]) weight = data.weapons[id].weight
  else if (data.armors[id]) weight = data.armors[id].weight
  else if (data.gongfa[id]) weight = data.gongfa[id].weight
  else if (data.shentong[id]) weight = data.shentong[id].weight
  else if (data.fuxiu[id]) weight = data.fuxiu[id].weight
  else if (data.qiFlags[id]) weight = data.qiFlags[id].weight
  else if (data.furnaces[id]) weight = data.furnaces[id].weight

  const BASE_PRICE = 1_000_000
  const safeWeight = Math.max(1, weight)
  return Math.max(100, Math.floor(BASE_PRICE / safeWeight))
}