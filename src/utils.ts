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

export function truncateDecimal(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = Math.pow(10, digits)
  return Math.floor(value * factor) / factor
}

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

export async function getLearnedSkills(ctx: Context, userId: string): Promise<LearnedSkills> {
  const buff = await getBuff(ctx, userId)
  const existing = await ctx.database.get(TABLE.skill, { userId })
  const have = new Set(existing.map(r => r.skillId))

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

  for (const gid of learned.gongfa) {
    const g = getGongfa(gid)
    if (g?.modifiers) modifiers.push(...g.modifiers)
  }

  for (const fid of learned.fuxiu) {
    const sub = getFuXiu(fid)
    if (!sub) continue
    if (sub.effect === 'hpPct') modifiers.push({ stat: 'hp', value: sub.value / 100 })
    else if (sub.effect === 'damageBoost') modifiers.push({ stat: 'atk', value: sub.value / 100 })
  }

  const w = buff.faqiBuff ? getWeapon(buff.faqiBuff)?.modifiers : []
  if (w) modifiers.push(...w)
  const a = buff.armorBuff ? getArmor(buff.armorBuff)?.modifiers : []
  if (a) modifiers.push(...a)

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

export async function preparePlayerBattle(
  ctx: Context,
  session: Session,
): Promise<PlayerBattleReady | string> {
  const player = await requirePlayer(ctx, session)
  if (!Number.isFinite(player.hp)) {
    return '⚠️ 气血数据异常，请联系管理员'
  }
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
  shenTongIds?: number[]
  lifesteal?: number
  tempAtkMul?: number
  tempDefMul?: number
  tempBuffRemain?: number
  dotList?: Array<{
    multiplier: number
    remainTurns: number
    sourceName: string
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

export function calcOneHit(
  attacker: CombatUnit,
  defender: CombatUnit,
  multiplier: number,
  defFactor: number,
): { dmg: number; crit: boolean } {
  let raw = attacker.atk * (attacker.tempAtkMul ?? 1) * multiplier

  const crit = Math.random() < attacker.crit
  if (crit) raw *= attacker.critDmg

  raw *= (0.9 + Math.random() * 0.2)

  const defReduce = (defender.def / 100) * defFactor * (1 - attacker.pen)
  const appliedDefReduce = Math.min(0.95, Math.max(0, defReduce))

  const dmg = Math.max(1, Math.floor(raw * (1 - appliedDefReduce)))
  return { dmg, crit }
}

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
      if ((cdMap.get(id) ?? 0) > 0) continue
      const st = getShenTong(id)
      if (!st) continue
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

    const st = getShenTong(action.id)
    if (!st) return false
    att.mp -= Math.floor(st.mpCost * att.maxmp)
    cdMap.set(action.id, st.turnCost)

    if (Math.random() * 100 >= st.rate) {
      log.push({ round, text: `${att.name} 施展「${st.name}」但未命中` })
      return false
    }

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

    if (st.type === 2) {
      const mul = Number(st.atkValue) || 0

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

  for (let r = 1; r <= maxRound; r++) {
    const order: Array<[CombatUnit, CombatUnit, 'a' | 'b', Map<number, number>]> = a.spd >= b.spd
      ? [[a, b, 'a', cdA], [b, a, 'b', cdB]]
      : [[b, a, 'b', cdB], [a, b, 'a', cdA]]
    for (const [att, def, side, cd] of order) {
      if (doTurn(att, def, cd, r)) return { winner: side, log }
    }

    for (const [id, v] of cdA) if (v > 0) cdA.set(id, v - 1)
    for (const [id, v] of cdB) if (v > 0) cdB.set(id, v - 1)

    for (const u of [a, b]) {
      if (u.tempBuffRemain && u.tempBuffRemain > 0) {
        u.tempBuffRemain -= 1
        if (u.tempBuffRemain === 0) { u.tempAtkMul = undefined; u.tempDefMul = undefined }
      }
      if (u.dotList && u.dotList.length > 0) {
        for (const dot of u.dotList) {
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
  ts: number
  title: string
  log: BattleLogEntry[]
  winner: 'a' | 'b' | 'draw'
  playerName: string
  opponentName: string
}

export interface BattleRecordOptions {
  opponentUserId?: string
  opponentTitle?: string
}

const BATTLE_RECORD_TTL = 120_000
const _battleRecords = new Map<string, BattleRecord>()

export function recordBattle(
  userId: string,
  record: BattleRecord,
  options?: BattleRecordOptions,
): void {
  _battleRecords.set(userId, record)
  setTimeout(() => {
    const cur = _battleRecords.get(userId)
    if (cur && cur.ts === record.ts) _battleRecords.delete(userId)
  }, BATTLE_RECORD_TTL)

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

export function getBattleRecord(userId: string): BattleRecord | null {
  const rec = _battleRecords.get(userId)
  if (!rec) return null
  if (Date.now() - rec.ts > BATTLE_RECORD_TTL) {
    _battleRecords.delete(userId)
    return null
  }
  return rec
}

export function getBattleRecordTtl(): number {
  return BATTLE_RECORD_TTL
}

// ======================= 每日重置 =======================

/**
 * 每日重置（B10：已移除多余项）
 *
 * 说明：`riftDailyCount` / `workRefreshCount` / `dualCultivation` 三项
 * 完全依赖命令内的 toDateString() 日切判断自动清零（且还需要
 * `riftCd` / `workRefreshCountTime` / `dualCultivationTime` 保持原状，
 * 让 toDateString() 比较有效）。定时任务整批清空反而会破坏时间戳语义。
 *
 * 保留此函数作为未来可能新增「必须整批清空」的字段挂载点。
 */
export async function resetDaily(_ctx: Context) {
  // 目前无需整批重置的字段
}

// ======================= 单次限定突破丹 =======================

export function isOneShotBreakthroughPill(pill: any): boolean {
  return pill?.modifiers?.some((m: any) => m.stat === 'breakthroughBigRate')
}

export function getOneShotBreakthroughValue(pill: any): number {
  const bt = pill?.modifiers?.find((m: any) => m.stat === 'breakthroughBigRate')
  return bt?.value ?? 0
}

export async function isOneShotPillUsed(
  ctx: Context, userId: string, pillId: number,
): Promise<boolean> {
  const rows = await ctx.database.get('wj6y3_xiuxian_pill_used', { userId, pillId })
  return rows.length > 0
}

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

const QI_CULTIVATE_PER_LEVEL = 0.1
const QI_HERB_PER_LEVEL = 0.2

export interface QiFlagBonus {
  cultivateMul: number
  herbTimeMul: number
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

const STAT_LABEL_MAP: Record<string, string> = {
  hp: '气血',
  mp: '真元',
  atk: '攻击',
  def: '防御',
  spd: '速度',
  crit: '会心',
  critDmg: '暴伤',
  pen: '穿透',
  cultivateSpeed: '修炼速度',
  exp: '修为',
  breakthroughRate: '突破率',
  breakthroughBigRate: '大境界突破率',
}

export function statLabel(stat: string): string {
  return STAT_LABEL_MAP[stat] ?? stat
}

// ======================= 通用：自增 ID 分配 =======================

import type { Tables } from 'koishi'

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

export function getQualityLabel(goodsId: number | string): string {
  const id = String(goodsId)

  const herb = data.herbs[id]
  if (herb && typeof herb.tier === 'number') {
    return `${herb.tier} 阶药材`
  }

  if (data.pills[id] || data.craftPills[id] || data.qiFlags[id] || data.furnaces[id]) {
    return ''
  }

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

export function estimatePrice(goodsId: number | string): number {
  const id = String(goodsId)

  const pill = data.pills[id]
  if (pill?.price?.buy) return pill.price.buy

  let weight = 50
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

/**
 * 从 Koishi 的 WriteResult 中提取「受影响行数」。
 *
 * 不同数据库 adapter 的 WriteResult 字段不完全一致：
 *   - MySQL / SQLite：`{ matched, modified }`
 *   - PostgreSQL：`{ modified }`
 *   - 部分 adapter：`{ deleted }` / `{ inserted }`
 *
 * 只要任一字段存在即返回该数值；全都缺失时返回 `-1`，
 * 调用方应在 `-1` 时按「乐观成功」处理（即不因无法判断而误拦）。
 */
export function getAffectedRows(res: any): number {
  if (!res || typeof res !== 'object') return -1
  const v = res.modified ?? res.matched ?? res.deleted ?? res.inserted
  return typeof v === 'number' ? v : -1
}