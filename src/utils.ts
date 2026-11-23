import { $, Context, Session } from 'koishi'
import type { Query, Tables } from 'koishi'
import {
  data, getLevel, getRoot, getGongfa, getFuXiu, getWeapon, getArmor,
  getBodyLevel, computeResonance, getShenTong, getSkillType, getShenTongWeight,
  weightedPick,
} from './data'
import { TABLE, Player, BuffRow, FLOORED_FIELDS } from './models'
import type { ComputedStats, Modifier, FuXiuEntry } from './types'
import { Config, getPluginConfig, DEFAULT_DROP_WEIGHTS } from './config'

export { getShenTong, weightedPick }

// ======================= 常量 =======================

/** 渡厄丹物品 ID（渡厄丹的唯一判定依据） */
export const DUE_PILL_ID = 1999

/** 攻击丹：每种整局限服 5 次（飞升 / 重入仙途时重置） */
export const ATK_PILL_TAG = '攻击丹'
export const ATK_PILL_USE_LIMIT = 5

// ======================= 通用小工具 =======================

/** 两个时间是否为同一天（服务器本地时区） */
export function isSameDay(
  a: Date | number | string | null | undefined,
  b: Date | number | string = new Date(),
): boolean {
  if (a === null || a === undefined) return false
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** 气血低于上限的 1%（或数据异常）视为重伤 */
export function isBadlyInjured(hp: number, maxhp: number): boolean {
  if (!Number.isFinite(hp)) return true
  return hp < Math.max(1, Math.floor(maxhp * 0.01))
}

/** 写库前把指定表的「长整数 / 双精度」字段向下取整（返回新对象，不修改原对象） */
export function floorRow<T extends object>(table: keyof typeof FLOORED_FIELDS, row: T): T {
  const out = { ...row } as Record<string, unknown>
  for (const f of FLOORED_FIELDS[table] as readonly string[]) {
    const v = out[f]
    if (typeof v === 'number' && Number.isFinite(v)) out[f] = Math.floor(v)
  }
  return out as T
}

// ======================= Session → uid =======================

/** 从 session 解析 uid（Koishi 用户 ID）。优先走 session.user.id，兜底走 database.getUser。 */
export async function getSessionUid(ctx: Context, session: Session | undefined): Promise<number | null> {
  if (!session) return null
  const direct = (session as any).user?.id
  if (typeof direct === 'number') return direct
  if (!session.userId) return null
  try {
    const user = await ctx.database.getUser(session.platform as any, session.userId)
    return typeof user?.id === 'number' ? user.id : null
  } catch {
    return null
  }
}

/** 从 `@` 元素解析 uid。`@` 中的 id 是平台 userId，需通过 getUser 转 uid。 */
export async function resolveAtUid(ctx: Context, session: Session | undefined): Promise<number | null> {
  if (!session) return null
  const targetPlatformId = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
  if (!targetPlatformId) return null
  try {
    const user = await ctx.database.getUser(session.platform as any, targetPlatformId)
    return typeof user?.id === 'number' ? user.id : null
  } catch {
    return null
  }
}

// ======================= 玩家读取 =======================

export async function getPlayer(ctx: Context, uid: number): Promise<Player | null> {
  const rows = await ctx.database.get(TABLE.player, { uid })
  return rows[0] ?? null
}

export async function requirePlayer(ctx: Context, session: Session | undefined): Promise<Player> {
  const uid = await getSessionUid(ctx, session)
  if (uid === null) throw new Error('账号未同步，请稍后重试或联系管理员')
  const p = await getPlayer(ctx, uid)
  if (!p) throw new Error('尚未踏入仙途，请先发送「我要修仙」')
  return p
}

// ======================= 装备 / 洞府槽位 =======================

/** 读取玩家的槽位行（装备 / 洞府灵气 / 攻击丹加成）；不存在时先建立默认行再返回 */
export async function getOrCreateBuff(ctx: Context, uid: number): Promise<BuffRow> {
  const rows = await ctx.database.get(TABLE.buff, { uid })
  if (rows[0]) return rows[0]
  const row: BuffRow = {
    uid, mainBuff: 0, secBuff: 0, subBuff: 0,
    faqiBuff: 0, armorBuff: 0, atkBuff: 0, blessedSpot: 0,
    furnaceBuff: 0,
    qiFlagBuff: 0,
  }
  await ctx.database.create(TABLE.buff, row)
  return row
}

export type EquipSlot = 'faqiBuff' | 'armorBuff' | 'furnaceBuff' | 'qiFlagBuff'
export const EQUIP_SLOTS: readonly EquipSlot[] = ['faqiBuff', 'armorBuff', 'furnaceBuff', 'qiFlagBuff']

/** 装备槽写入的唯一入口：只改指定槽位（goodsId = 0 表示卸下），绝不触及背包 */
export async function setEquipSlot(ctx: Context, uid: number, slot: EquipSlot, goodsId: number): Promise<void> {
  const buff = await getOrCreateBuff(ctx, uid)
  if (buff[slot] === goodsId) return
  const patch: Partial<BuffRow> = {}
  patch[slot] = goodsId
  await ctx.database.set(TABLE.buff, { uid }, patch)
}

/** 当前装备中的物品 ID 集合 */
export function getEquippedIds(buff: BuffRow): Set<number> {
  return new Set(EQUIP_SLOTS.map(s => buff[s]).filter(id => !!id))
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

/** 国际单位制前缀（1000 进制），K 起至 Q（10^30） */
const COMPACT_UNITS = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'] as const

/**
 * 大数值缩写显示：
 * - 小于 1000：原样整数（向下取整）
 * - 1000 起只显示最大一档，保留 1 位小数（四舍五入），如 9521 → 9.5K、52174525 → 52.2M
 * - 四舍五入后达 1000 则升档（999950 → 1.0M）
 * - ≥ 1000Q 改用科学记号（2.5e33 → 2.5e33）
 * 仅用于显示，不影响存储与计算。
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 1000) return sign + String(Math.floor(abs))
  let idx = Math.min(Math.floor(Math.log10(abs) / 3), COMPACT_UNITS.length - 1)
  // log10 浮点误差修正
  while (idx > 1 && abs < 1000 ** idx) idx--
  while (idx < COMPACT_UNITS.length - 1 && abs >= 1000 ** (idx + 1)) idx++
  let scaled = Math.round(abs / 1000 ** idx * 10) / 10
  if (scaled >= 1000 && idx < COMPACT_UNITS.length - 1) { idx++; scaled = Math.round(abs / 1000 ** idx * 10) / 10 }
  if (scaled >= 1000) {
    const [m, e] = abs.toExponential(1).split('e')
    return `${sign}${m}e${e.replace('+', '')}`
  }
  return `${sign}${scaled.toFixed(1)}${COMPACT_UNITS[idx]}`
}

// ======================= 学习制核心 =======================

export interface LearnedSkills {
  gongfa: number[]
  fuxiu: number[]
  shentong: number[]
}

/** 读取已学的功法 / 辅修 / 神通；同时把旧版 buff 槽位（mainBuff/subBuff/secBuff）里的技能迁移进技能表 */
export async function getLearnedSkillsAndMigrate(ctx: Context, uid: number): Promise<LearnedSkills> {
  const buff = await getOrCreateBuff(ctx, uid)
  const existing = await ctx.database.get(TABLE.skill, { uid })
  const have = new Set(existing.map(r => r.skillId))

  const legacy: number[] = []
  if (buff.mainBuff && !have.has(buff.mainBuff)) legacy.push(buff.mainBuff)
  if (buff.subBuff && !have.has(buff.subBuff)) legacy.push(buff.subBuff)
  if (buff.secBuff && !have.has(buff.secBuff)) legacy.push(buff.secBuff)
  if (legacy.length > 0) {
    await ctx.database.upsert(
      TABLE.skill,
      legacy.map(id => ({ uid, skillId: id })),
      ['uid', 'skillId'],
    )
    await ctx.database.set(TABLE.buff, { uid }, { mainBuff: 0, subBuff: 0, secBuff: 0 })
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
  const c = getPluginConfig(ctx).currency
  if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  return '灵石'
}

/** monetary 为必需服务（index.ts inject.required），此处必然存在 */
function getMonetary(ctx: Context): any {
  return ctx.get('monetary')
}

export async function getStone(ctx: Context, uid: number): Promise<number> {
  try {
    const rows = await ctx.database.get('monetary', { uid, currency: getCurrency(ctx) }, ['value'])
    return Number(rows[0]?.value) || 0
  } catch (e) {
    ctx.logger('xiuxian').warn('getStone error:', e)
    return 0
  }
}

export async function addStone(ctx: Context, uid: number, amount: number) {
  const cur = getCurrency(ctx)
  try {
    if (amount > 0) await getMonetary(ctx).gain(uid, amount, cur)
    else if (amount < 0) await getMonetary(ctx).cost(uid, -amount, cur)
  } catch (e) {
    ctx.logger('xiuxian').warn('addStone error:', e)
  }
}

/** 灵石持有量排行：直接按 monetary 表排序取前 limit 名（只含本货币） */
export async function getTopStoneHolders(ctx: Context, limit: number): Promise<Array<{ uid: number; value: number }>> {
  const rows = await ctx.database.get('monetary', { currency: getCurrency(ctx) }, {
    sort: { value: 'desc' }, limit,
  })
  return rows.map(r => ({ uid: r.uid, value: Number(r.value) || 0 }))
}

export async function costStone(ctx: Context, uid: number, amount: number): Promise<boolean> {
  const cur = await getStone(ctx, uid)
  if (cur < amount) return false
  await addStone(ctx, uid, -amount)
  return true
}

// ======================= 原子更新 =======================

/**
 * 删除即占用（悬赏令结算的写法）：只有真正删除了目标行的那次请求返回 true。
 * remove 在各数据库驱动上都是原子的，用于「同一份东西只能被处理一次」的场景。
 */
export async function claimByRemove<K extends keyof Tables>(
  ctx: Context, table: K, query: Query<Tables[K]>,
): Promise<boolean> {
  const res = await ctx.database.remove(table, query)
  return getAffectedRows(res) !== 0
}

/** 原子增减玩家修为（delta 先向下取整，0 则忽略） */
export async function addPlayerExp(ctx: Context, uid: number, delta: number): Promise<void> {
  const d = Math.floor(delta)
  if (!Number.isFinite(d) || d === 0) return
  await ctx.database.set(TABLE.player, { uid }, row => ({ exp: $.add(row.exp, d) }))
}

/** 原子增减玩家宗门贡献（delta 先向下取整，0 则忽略） */
export async function addPlayerContribution(ctx: Context, uid: number, delta: number): Promise<void> {
  const d = Math.floor(delta)
  if (!Number.isFinite(d) || d === 0) return
  await ctx.database.set(TABLE.player, { uid }, row => ({ sectContribution: $.add(row.sectContribution, d) }))
}

/** 条件扣减（签到的写法）：仅当贡献 ≥ amount 时原子扣减，返回是否成功 */
export async function subPlayerContributionIfEnough(ctx: Context, uid: number, amount: number): Promise<boolean> {
  const a = Math.floor(amount)
  if (!(a > 0)) return false
  const res = await ctx.database.set(
    TABLE.player,
    { uid, sectContribution: { $gte: a } },
    row => ({ sectContribution: $.sub(row.sectContribution, a) }),
  )
  return getAffectedRows(res) !== 0
}

// ======================= 属性计算 =======================

function sumModifiers(mods: readonly Modifier[] | undefined, field: string): number {
  if (!mods) return 0
  return mods.filter(m => m.stat === field && (m.mode ?? 'pct') === 'pct')
    .reduce((s, m) => s + m.value, 0)
}

/** 已实作的辅修效果 → 属性加成（value 为比例，0.05 = 5%）；尚未实作的效果返回 null */
export function getFuxiuBonus(entry: FuXiuEntry | undefined): { stat: 'hp' | 'atk' | 'lifesteal'; value: number } | null {
  if (!entry) return null
  if (entry.effect === 'hpPct') return { stat: 'hp', value: entry.value / 100 }
  if (entry.effect === 'damageBoost') return { stat: 'atk', value: entry.value / 100 }
  if (entry.effect === 'lifesteal') return { stat: 'lifesteal', value: entry.value / 100 }
  return null
}

/**
 * 减伤公式：原减伤 + 原减伤×练体% + 原减伤×防具% + 原减伤×生效中减伤神通总和%，上限 100%。
 * @param baseDef     原减伤%（境界 def）
 * @param defBonusPct 练体% + 防具%（比例，0.15 = 15%）
 * @param tempDefSum  战斗中生效的减伤神通总和（比例）
 */
export function calcDefensePct(baseDef: number, defBonusPct: number, tempDefSum = 0): number {
  return Math.min(100, Math.max(0, baseDef * (1 + defBonusPct + tempDefSum)))
}

/** 读取装备 / 功法 / 练体等数据并计算玩家属性（会查询数据库，不写库） */
export async function loadAndComputeStats(ctx: Context, player: Player): Promise<ComputedStats> {
  const lv = getLevel(player.level)
  if (!lv) return { hp: 0, mp: 0, atk: 0, def: 0, spd: 0, crit: 0, critDmg: 0, pen: 0, baseDef: 0, defBonusPct: 0 }

  const buff = await getOrCreateBuff(ctx, player.uid)
  const learned = await getLearnedSkillsAndMigrate(ctx, player.uid)
  const modifiers: Modifier[] = []

  for (const gid of learned.gongfa) {
    const g = getGongfa(gid)
    if (g?.modifiers) modifiers.push(...g.modifiers)
  }

  for (const fid of learned.fuxiu) {
    const b = getFuxiuBonus(getFuXiu(fid))
    if (b && b.stat !== 'lifesteal') modifiers.push({ stat: b.stat, value: b.value })
  }

  const weaponMods = (buff.faqiBuff ? getWeapon(buff.faqiBuff)?.modifiers : undefined) ?? []
  modifiers.push(...weaponMods)
  const armorMods = (buff.armorBuff ? getArmor(buff.armorBuff)?.modifiers : undefined) ?? []
  modifiers.push(...armorMods)

  const body = player.exercisesLevel ? getBodyLevel(player.exercisesLevel) : undefined
  const bodyMods = (body?.modifiers ?? []) as Modifier[]
  modifiers.push(...bodyMods)

  const bodyName = body?.name || ''
  const res = computeResonance(lv.name, bodyName)
  if (res.buff) modifiers.push(...(res.buff as Modifier[]))

  const root = getRoot(player.root)
  const rootAtkMul = root?.atk ?? 1

  const hpMul = 1 + sumModifiers(modifiers, 'hp')
  const mpMul = 1 + sumModifiers(modifiers, 'mp')
  const spdMul = 1 + sumModifiers(modifiers, 'spd')

  const atkFlatBonus = buff.atkBuff || 0
  const atkPracticeMul = 1 + (player.atkPractice || 0) * 0.04
  const baseAtk = lv.atk * rootAtkMul + atkFlatBonus
  const atk = baseAtk * (1 + sumModifiers(modifiers, 'atk')) * atkPracticeMul

  const crit = 0.05 + sumModifiers(modifiers, 'crit')
  const critDmg = 1.5 + sumModifiers(modifiers, 'critDmg')
  const pen = sumModifiers(modifiers, 'pen')

  // 减伤：只取练体与防具的减伤加乘（各自独立乘区，均乘原减伤）
  const defBonusPct = sumModifiers(bodyMods, 'def') + sumModifiers(armorMods, 'def')

  return {
    hp: Math.round(lv.hp * hpMul),
    mp: Math.round(lv.mp * mpMul),
    atk: Math.round(atk),
    def: calcDefensePct(lv.def, defBonusPct),
    spd: Math.round(lv.spd * spdMul),
    crit, critDmg, pen,
    baseDef: lv.def,
    defBonusPct,
  }
}

export async function computeCultivateSpeed(ctx: Context, uid: number): Promise<number> {
  const learned = await getLearnedSkillsAndMigrate(ctx, uid)
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

/**
 * 重新计算玩家属性并写回数据库。
 * 会直接修改传入的 player 对象（maxhp / maxmp / atk / hp / mp / power），调用后可沿用该对象。
 */
export async function recomputeAndSaveStats(ctx: Context, player: Player): Promise<ComputedStats> {
  const st = await loadAndComputeStats(ctx, player)
  const lv = getLevel(player.level)
  if (!lv) return st
  player.maxhp = Math.floor(st.hp)
  player.maxmp = Math.floor(st.mp)
  player.atk = Math.floor(st.atk)
  player.hp = Math.floor(Math.min(player.hp, st.hp))
  player.mp = Math.floor(Math.min(player.mp, st.mp))
  player.power = Math.round(lv.power * (1 + (st.atk / (lv.atk || 1) - 1) * 0.5))
  await ctx.database.set(TABLE.player, { uid: player.uid }, floorRow(TABLE.player, {
    maxhp: player.maxhp, maxmp: player.maxmp,
    atk: player.atk, hp: player.hp, mp: player.mp,
    power: player.power,
  }))
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
    message: hasExp ? undefined : `修为不足（${formatCompact(player.exp)}/${formatCompact(expRequired)}）`,
  }
}

// ======================= 丹藥tag =======================

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

export async function addItem(ctx: Context, uid: number, goodsId: number, num = 1) {
  const exist = await ctx.database.get(TABLE.back, { uid, goodsId })
  if (exist[0]) {
    await ctx.database.set(TABLE.back, { uid, goodsId }, {
      goodsNum: exist[0].goodsNum + num,
      updateTime: new Date(),
    })
  } else {
    await ctx.database.create(TABLE.back, {
      uid, goodsId, goodsNum: num,
      createTime: new Date(), updateTime: new Date(),
      dayNum: 0, allNum: 0, actionTime: new Date(0),
      state: 0, bindNum: 0,
    })
  }
}

export async function findItemInBackpack(
  ctx: Context, uid: number, name: string,
): Promise<[string, any] | null> {
  const backRows = await ctx.database.get(TABLE.back, { uid })
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
  uid: number,
  goodsId: number,
  num = 1,
  keepEmptyRow = false,
): Promise<boolean> {
  const rows = await ctx.database.get(TABLE.back, { uid, goodsId })
  if (!rows[0] || rows[0].goodsNum < num) return false

  if (rows[0].goodsNum === num) {
    if (keepEmptyRow) {
      await ctx.database.set(TABLE.back, { uid, goodsId }, { goodsNum: 0 })
    } else {
      await ctx.database.remove(TABLE.back, { uid, goodsId })
    }
  } else {
    await ctx.database.set(TABLE.back, { uid, goodsId }, {
      goodsNum: rows[0].goodsNum - num,
    })
  }
  return true
}

// ======================= 整局限次丹药（攻击丹） =======================

/** 该丹药的整局限服次数：目前仅攻击丹（每种 5 次），其余丹药返回 undefined（不限次数） */
export function getPillUseLimit(meta: { tag?: string } | undefined): number | undefined {
  return meta?.tag === ATK_PILL_TAG ? ATK_PILL_USE_LIMIT : undefined
}

export async function getPillUsedCount(ctx: Context, uid: number, pillId: number): Promise<number> {
  const rows = await ctx.database.get(TABLE.pillLimit, { uid, pillId })
  return rows[0]?.usedCount ?? 0
}

export async function addPillUsedCount(ctx: Context, uid: number, pillId: number, n = 1): Promise<void> {
  const res = await ctx.database.set(TABLE.pillLimit, { uid, pillId }, row => ({ usedCount: $.add(row.usedCount, n) }))
  if (getAffectedRows(res) === 0) {
    await ctx.database.create(TABLE.pillLimit, { uid, pillId, usedCount: n })
  }
}

/** 一次性迁移：把旧版记在背包行 allNum 上的攻击丹服用次数搬进 pill_limit 表（取较大值），并把旧值清零 */
export async function migrateLegacyPillCounts(ctx: Context): Promise<number> {
  const atkPillIds = [...Object.entries(data.pills), ...Object.entries(data.craftPills)]
    .filter(([, v]) => (v as any)?.tag === ATK_PILL_TAG)
    .map(([id]) => Number(id))
  if (!atkPillIds.length) return 0
  const rows = await ctx.database.get(TABLE.back, { goodsId: { $in: atkPillIds }, allNum: { $gt: 0 } })
  for (const r of rows) {
    const used = await getPillUsedCount(ctx, r.uid, r.goodsId)
    if (r.allNum > used) {
      await ctx.database.upsert(TABLE.pillLimit, [{ uid: r.uid, pillId: r.goodsId, usedCount: r.allNum }], ['uid', 'pillId'])
    }
    await ctx.database.set(TABLE.back, { uid: r.uid, goodsId: r.goodsId }, { allNum: 0 })
  }
  return rows.length
}

// ======================= 忙碌状态（闭关 / 悬赏令） =======================

export type BusyKind = 'closed' | 'bounty'

/** 读取玩家当前的忙碌状态：闭关中 / 悬赏令进行中；空闲返回 null */
export async function getBusyKind(ctx: Context, uid: number): Promise<BusyKind | null> {
  const rows = await ctx.database.get(TABLE.cd, { uid })
  if (rows[0]?.type === 1) return 'closed'
  if (rows[0]?.type === 2) return 'bounty'
  return null
}

// ======================= 战斗前置 =======================

export interface PlayerBattleReady {
  player: Player
  stats: ComputedStats
  unit: CombatUnit
}

/**
 * 要求玩家已建号（否则与 requirePlayer 一样抛错），并检查能否参战：
 * 能战斗时返回玩家 / 属性 / 战斗单位，不能战斗时返回提示字符串。
 */
export async function requireBattleReadyPlayer(
  ctx: Context,
  session: Session | undefined,
): Promise<PlayerBattleReady | string> {
  const player = await requirePlayer(ctx, session)
  if (!Number.isFinite(player.hp)) {
    return '⚠️ 气血数据异常，请联系管理员'
  }
  if (isBadlyInjured(player.hp, player.maxhp)) {
    return `你身受重伤，请服丹或出关疗伤后再战`
  }
  const stats = await loadAndComputeStats(ctx, player)
  const unit = await buildPlayerUnit(ctx, player, stats)
  return { player, stats, unit }
}

// ======================= 战斗引擎 =======================

export interface CombatUnit {
  name: string
  hp: number; maxhp: number
  mp: number; maxmp: number
  atk: number; def: number; spd: number
  crit: number; critDmg: number; pen: number
  /** 玩家专用：原减伤%（境界 def）；怪物 / BOSS 不设，直接使用 def */
  baseDef?: number
  /** 玩家专用：练体% + 防具%（比例） */
  defBonusPct?: number
  shenTongIds?: number[]
  lifesteal?: number
  tempAtkMul?: number
  /** 生效中的减伤神通增益总和（比例） */
  tempDefSum?: number
  tempBuffRemain?: number
  dotList?: Array<{
    multiplier: number
    remainTurns: number
    sourceName: string
    source: CombatUnit
  }>
  uid?: number
}

export interface BattleLogEntry { round: number; text: string }

export async function buildPlayerUnit(ctx: Context, p: Player, st: ComputedStats, name = ''): Promise<CombatUnit> {
  const learned = await getLearnedSkillsAndMigrate(ctx, p.uid)
  let lifesteal = 0
  for (const fid of learned.fuxiu) {
    const b = getFuxiuBonus(getFuXiu(fid))
    if (b?.stat === 'lifesteal') lifesteal += b.value
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
    baseDef: st.baseDef,
    defBonusPct: st.defBonusPct,
    shenTongIds: learned.shentong,
    lifesteal,
    uid: p.uid,
  }
}

/** 战斗单位当前的减伤%：玩家按减伤公式（含生效中的减伤神通），怪物 / BOSS 沿用自身 def */
export function getCombatDefensePct(u: CombatUnit): number {
  if (u.baseDef === undefined) return Math.min(100, Math.max(0, u.def))
  return calcDefensePct(u.baseDef, u.defBonusPct ?? 0, u.tempDefSum ?? 0)
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
  const defReduce = (getCombatDefensePct(defender) / 100) * defFactor * (1 - attacker.pen)
  const appliedDefReduce = Math.min(1, Math.max(0, defReduce))
  const dmg = Math.max(1, Math.floor(raw * (1 - appliedDefReduce)))
  return { dmg, crit }
}

const BASIC_ATTACK_WEIGHT = 200

type BattleAction = { kind: 'basic' } | { kind: 'shentong'; id: number }

function pickAction(
  unit: CombatUnit,
  cdMap: Map<number, number>,
): BattleAction {
  const pool: Array<{ action: BattleAction; weight: number }> = [
    { action: { kind: 'basic' }, weight: BASIC_ATTACK_WEIGHT },
  ]
  if (unit.shenTongIds && unit.shenTongIds.length > 0) {
    for (const id of unit.shenTongIds) {
      if ((cdMap.get(id) ?? 0) > 0) continue
      const st = getShenTong(id)
      if (!st) continue
      if (unit.mp < st.mpCost * unit.maxmp) continue
      pool.push({ action: { kind: 'shentong', id }, weight: getShenTongWeight(id) })
    }
  }
  return weightedPick(pool, x => x.weight)?.action ?? { kind: 'basic' }
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
      log.push({ round, text: `${att.name} 攻击 ${def.name} 造成 ${formatCompact(dmg)}${crit ? '（暴击！）' : ''}，剩 ${formatCompact(def.hp)}/${formatCompact(def.maxhp)}` })
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
        // 减伤神通：增益按「总和」累加，计入减伤公式（原减伤 × 总和）
        att.tempDefSum = (att.tempDefSum ?? 0) + (st.buffValue ?? 0)
        att.tempBuffRemain = Math.max(att.tempBuffRemain ?? 0, st.turnCost)
        log.push({ round, text: `${att.name} 施展「${st.name}」，减伤提升 ${Math.floor((st.buffValue ?? 0) * 100)}%（${st.turnCost} 回合）` })
      }
      return false
    }

    if (st.type === 2) {
      const mul = Number(st.atkValue) || 0
      const first = calcOneHit(att, def, mul, 0.5)
      def.hp = Math.max(0, def.hp - first.dmg)
      log.push({ round, text: `${att.name} 施展「${st.name}」造成 ${formatCompact(first.dmg)}${first.crit ? '（暴击！）' : ''} 伤害，剩 ${formatCompact(def.hp)}/${formatCompact(def.maxhp)}` })

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
        log.push({ round, text: `${def.name} 陷入「${st.name}」持续伤害（每回合 ×${mul.toFixed(2)} 重算，共 ${st.turnCost} 次）` })
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
    log.push({ round, text: `${att.name} 施展「${st.name}」（${values.length} 段）造成 ${formatCompact(totalDmg)} 伤害${anyCrit ? '（暴击！）' : ''}，剩 ${formatCompact(def.hp)}/${formatCompact(def.maxhp)}` })

    if (st.lifestealPct) {
      const heal = Math.floor(totalDmg * st.lifestealPct)
      if (heal > 0) {
        att.hp = Math.min(att.maxhp, att.hp + heal)
        log.push({ round, text: `${att.name} 吸取 ${formatCompact(heal)} 气血` })
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
        if (u.tempBuffRemain === 0) { u.tempAtkMul = undefined; u.tempDefSum = undefined }
      }
      if (u.dotList && u.dotList.length > 0) {
        for (const dot of u.dotList) {
          const { dmg, crit } = calcOneHit(dot.source, u, dot.multiplier, 0.5)
          u.hp = Math.max(0, u.hp - dmg)
          log.push({ round: r, text: `${u.name} 受到「${dot.sourceName}」持续伤害 ${formatCompact(dmg)}${crit ? '（暴击！）' : ''}，剩 ${formatCompact(u.hp)}/${formatCompact(u.maxhp)}` })
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

// ======================= 战斗记录 =======================

export interface BattleRecord {
  ts: number
  title: string
  log: BattleLogEntry[]
  winner: 'a' | 'b' | 'draw'
  playerName: string
  opponentName: string
}

export interface BattleRecordOptions {
  opponentUid?: number
  opponentTitle?: string
}

const BATTLE_RECORD_TTL = 120_000
const _battleRecords = new Map<number, BattleRecord>()

/** 记录最近一次战斗（120 秒内可查）；过期记录在读取时或由定时清理移除，不再使用全局 setTimeout */
export function recordBattle(
  uid: number,
  record: BattleRecord,
  options?: BattleRecordOptions,
): void {
  _battleRecords.set(uid, record)

  const oppUid = options?.opponentUid
  if (!oppUid) return
  const flipped: BattleRecord = {
    ts: record.ts,
    title: options?.opponentTitle ?? record.title,
    log: record.log,
    winner: record.winner === 'a' ? 'b' : record.winner === 'b' ? 'a' : 'draw',
    playerName: record.opponentName,
    opponentName: record.playerName,
  }
  _battleRecords.set(oppUid, flipped)
}

export function getBattleRecord(uid: number): BattleRecord | null {
  const rec = _battleRecords.get(uid)
  if (!rec) return null
  if (Date.now() - rec.ts > BATTLE_RECORD_TTL) {
    _battleRecords.delete(uid)
    return null
  }
  return rec
}

export function getBattleRecordTtl(): number {
  return BATTLE_RECORD_TTL
}

/** 依序发送多段消息（平台限制单条消息长度时使用） */
export async function sendSegments(session: Session | undefined, segments: string[]) {
  if (!session) return
  for (const seg of segments) await session.send(seg)
}

/** 战斗详情每段包含的回合数（30 回合上限 → 最多 3 段） */
export const BATTLE_LOG_ROUNDS_PER_SEGMENT = 10

/**
 * 把战斗记录按回合切成多段文本：每段 BATTLE_LOG_ROUNDS_PER_SEGMENT 个回合。
 * 首段带标题与胜者；多于一段时每段首行标出「第 x/y 段｜第 a~b 回合」。
 */
export function segmentBattleLog(rec: BattleRecord): string[] {
  const winnerName = rec.winner === 'a' ? rec.playerName
    : rec.winner === 'b' ? rec.opponentName
      : '平局'

  const grouped = new Map<number, string[]>()
  for (const e of rec.log) {
    if (!grouped.has(e.round)) grouped.set(e.round, [])
    grouped.get(e.round)!.push(e.text)
  }
  const rounds = [...grouped.entries()].sort((a, b) => a[0] - b[0])
  const total = Math.max(1, Math.ceil(rounds.length / BATTLE_LOG_ROUNDS_PER_SEGMENT))

  const segments: string[] = []
  for (let i = 0; i < total; i++) {
    const chunk = rounds.slice(i * BATTLE_LOG_ROUNDS_PER_SEGMENT, (i + 1) * BATTLE_LOG_ROUNDS_PER_SEGMENT)
    const lines: string[] = []
    if (i === 0) lines.push(`⚔️ ${rec.title}`, `🏆 ${winnerName} 获胜`, '')
    if (total > 1 && chunk.length) {
      lines.push(`📜 战斗详情（第 ${i + 1}/${total} 段｜第 ${chunk[0][0]}~${chunk[chunk.length - 1][0]} 回合）`)
    }
    for (const [round, texts] of chunk) {
      lines.push(`【第 ${round} 回合】`, ...texts.map(t => '  ' + t))
    }
    segments.push(lines.join('\n'))
  }
  return segments
}

/** 清理已过期的战斗记录（由定时任务调用） */
export function cleanupBattleRecords(now = Date.now()): void {
  for (const [uid, rec] of _battleRecords) {
    if (now - rec.ts > BATTLE_RECORD_TTL) _battleRecords.delete(uid)
  }
}

/** 插件卸载时清空全部战斗记录 */
export function clearBattleRecords(): void {
  _battleRecords.clear()
}

// ======================= 每日重置 =======================

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
  ctx: Context, uid: number, pillId: number,
): Promise<boolean> {
  const rows = await ctx.database.get(TABLE.pillUsed, { uid, pillId })
  return rows.length > 0
}

export async function computeOneShotBreakthroughBonus(
  ctx: Context, uid: number, currentLevel: string,
): Promise<{ bonus: number; pillIds: number[] }> {
  const targetNext = String(parseInt(currentLevel, 10) + 1)
  const rows = await ctx.database.get(TABLE.pillUsed, { uid, targetLevelId: targetNext })
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

export const QI_CULTIVATE_PER_LEVEL = 0.1
export const QI_HERB_PER_LEVEL = 0.2

export interface QiFlagBonus {
  cultivateMul: number
  herbTimeMul: number
  name: string
}

export async function getQiFlagBonus(ctx: Context, uid: number): Promise<QiFlagBonus> {
  const buff = await getOrCreateBuff(ctx, uid)
  if (!buff.qiFlagBuff) return { cultivateMul: 1, herbTimeMul: 1, name: '' }
  const flag = data.qiFlags[String(buff.qiFlagBuff)]
  if (!flag) return { cultivateMul: 1, herbTimeMul: 1, name: '' }
  const cultivateMul = 1 + (flag.cultivateSpeed ?? 0) * QI_CULTIVATE_PER_LEVEL
  const herbTimeMul = 1 / (1 + (flag.herbSpeed ?? 0) * QI_HERB_PER_LEVEL)
  return { cultivateMul, herbTimeMul, name: flag.name ?? '' }
}

// ======================= 悬赏令 / 秘境掉落池 =======================

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

export function rollSingleDrop(categoryWeights: Record<string, number>): DropEntry | null {
  const pool = buildDropPool()
  const categories = Object.entries(categoryWeights).filter(([k, w]) => w > 0 && (pool[k]?.length ?? 0) > 0)
  const picked = weightedPick(categories, ([, w]) => w)
  if (!picked) return null
  return weightedPick(pool[picked[0]], it => it.weight) ?? null
}

/** 掉落类别权重（悬赏令 / 秘境共用）：未配置时使用默认权重 */
export function getDropCategoryWeights(config: Config): Record<string, number> {
  const w = config.bountyDropCategoryWeights
  if (w && typeof w === 'object' && Object.keys(w).length > 0) return w
  return DEFAULT_DROP_WEIGHTS
}

/** 按类别权重从全局掉落池抽 count 件 */
export function rollDrops(categoryWeights: Record<string, number>, count: number): DropEntry[] {
  const results: DropEntry[] = []
  for (let i = 0; i < count; i++) {
    const d = rollSingleDrop(categoryWeights)
    if (d) results.push(d)
  }
  return results
}

/** 合并同 ID 的掉落，得到 [{ id, name, num }] */
export function mergeDrops(drops: Array<{ id: number; name: string }>): Array<{ id: number; name: string; num: number }> {
  const map = new Map<number, { id: number; name: string; num: number }>()
  for (const d of drops) {
    const cur = map.get(d.id)
    if (cur) cur.num += 1
    else map.set(d.id, { id: d.id, name: d.name, num: 1 })
  }
  return [...map.values()]
}

/** 格式化合并后的掉落：「名称×数量、名称×数量」 */
export function formatDropList(drops: Array<{ name: string; num: number }>): string {
  return drops.map(d => `${d.name}×${d.num}`).join('、')
}

// ======================= 物品名称 =======================

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

// ======================= 属性中文名 / 加成格式化 =======================

const STAT_LABEL_MAP: Record<string, string> = {
  hp: '气血', mp: '真元', atk: '攻击', def: '防御', spd: '速度',
  crit: '会心', critDmg: '暴伤', pen: '穿透',
  cultivateSpeed: '修炼速度', exp: '修为',
  breakthroughRate: '突破率', breakthroughBigRate: '大境界突破率',
  lifesteal: '吸血',
}

/** flat 加成中属于大数值、需缩写显示的属性（突破率等比率类保持原样） */
const FLAT_COMPACT_STATS: ReadonlySet<string> = new Set(['atk', 'exp', 'hp', 'mp'])

export function statLabel(stat: string): string {
  return STAT_LABEL_MAP[stat] ?? stat
}

/**
 * 把 modifiers 格式化为「气血 +3%、攻击 +5%」。
 * pct 模式按 digits 位小数显示百分比，flat 模式显示原值；为空时返回 empty。
 */
export function formatModifiers(mods: readonly Modifier[] | undefined, digits = 0, empty = '无'): string {
  if (!mods || mods.length === 0) return empty
  return mods.map(m => {
    const isPct = (m.mode ?? 'pct') === 'pct'
    const val = isPct
      ? `${(m.value * 100).toFixed(digits)}%`
      : (FLAT_COMPACT_STATS.has(m.stat) ? formatCompact(m.value) : `${m.value}`)
    return `${statLabel(m.stat)} +${val}`
  }).join('、')
}

// ======================= 宗门职位 =======================

/** 宗门职位名（下标 = 职位值，0 = 散修），由 data/宗門職位.json 生成 */
export const POSITION_NAMES: readonly string[] = (() => {
  const names: string[] = ['散修']
  for (const [name, v] of Object.entries(data.sectPositions)) names[v.position] = name
  return names
})()

export function getPositionName(pos: number): string {
  return POSITION_NAMES[pos] || '未知错误'
}

// ======================= 自增 ID =======================

export async function getNextId<K extends keyof Tables>(
  ctx: Context,
  table: K,
  idField: keyof Tables[K] & string,
): Promise<number> {
  const rows = await ctx.database.get(table, {}, { sort: { [idField]: 'desc' } as any, limit: 1 })
  const maxId = (rows[0] as any)?.[idField]
  return (maxId !== undefined && maxId >= 1) ? Number(maxId) + 1 : 1
}

// ======================= 品阶反查 =======================

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

/**
 * 品阶排序信息：order 升序 = 品阶由低（人）到高（仙）；
 * group 为分段用的分组名（如「黄阶」「3 阶药材」，无品阶为空串）。
 */
export function getTierRank(goodsId: number | string): { group: string; order: number } {
  const id = String(goodsId)
  const herb = data.herbs[id]
  if (herb && typeof herb.tier === 'number') {
    return { group: `${herb.tier} 阶药材`, order: herb.tier }
  }
  const label = getQualityLabel(id)
  if (!label) return { group: '', order: 0 }
  const info = (data.tiers as Record<string, { weight: number }>)[label]
  return { group: label.charAt(0) + '阶', order: info ? -info.weight : 0 }
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

// ======================= 估价 =======================

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

/** 读取写入结果的影响行数；驱动未提供时返回 -1（调用方按「未知 = 成功」处理） */
export function getAffectedRows(res: any): number {
  if (!res || typeof res !== 'object') return -1
  const v = res.modified ?? res.matched ?? res.removed ?? res.inserted
  return typeof v === 'number' ? v : -1
}

// ======================= 启动时数据归整 =======================

const FLOORED_PRIMARY: Record<keyof typeof FLOORED_FIELDS, readonly string[]> = {
  wj6y3_xiuxian_player: ['uid'],
  wj6y3_xiuxian_sect: ['sectId'],
  wj6y3_xiuxian_buff: ['uid'],
  wj6y3_xiuxian_boss: ['id'],
  wj6y3_xiuxian_boss_participant: ['bossId', 'uid'],
  wj6y3_xiuxian_bank: ['uid'],
  wj6y3_xiuxian_shop: ['id'],
}

/** 一次性把各表既有的小数值向下取整（字段改为整数型后，旧数据仍可能残留小数） */
export async function normalizeFlooredFields(ctx: Context): Promise<number> {
  let fixed = 0
  for (const table of Object.keys(FLOORED_FIELDS) as Array<keyof typeof FLOORED_FIELDS>) {
    const fields = FLOORED_FIELDS[table] as readonly string[]
    // 表名在此为动态值，minato 无法静态推导行类型，因此以宽松类型读写
    const db = ctx.database as any
    const rows: Array<Record<string, unknown>> = await db.get(table, {})
    for (const row of rows) {
      const patch: Record<string, number> = {}
      for (const f of fields) {
        const v = row[f]
        if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) patch[f] = Math.floor(v)
      }
      if (!Object.keys(patch).length) continue
      const query = Object.fromEntries(FLOORED_PRIMARY[table].map(k => [k, row[k]]))
      await db.set(table, query, patch)
      fixed++
    }
  }
  return fixed
}
