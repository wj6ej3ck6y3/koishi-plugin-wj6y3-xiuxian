import { $, Context } from 'koishi'
import { data, getLevel, weightedPick } from '../data'
import { TABLE, BossRow } from '../models'
import {
  simulateBattle, addStone, addItem, recomputeAndSaveStats,
  getNextId,
  getPlayer,
  requireBattleReadyPlayer,
  recordBattle,
  claimByRemove,
  addPlayerExp,
  mergeDrops,
  formatDropList,
  getAffectedRows,
  CombatUnit,
  formatPct,
  formatCompact,
} from '../utils'

// ======================= 世界 BOSS 数值配置 =======================
const WORLD_BOSS_CONFIG = {
  MIN_LEVEL: 23,
  NAMES: ['远古魔龙', '混沌魔猿', '幽冥鬼帝', '天罡巨蟒', '万象魔象'],

  HP_MULT: 100,
  ATK_MULT: 50,
  MAX_DEF_CAP: 85,
  SPD: 0,
  CRIT: 0.05,
  CRIT_DMG: 1.5,
  PEN: 0,

  // 击杀按伤害占比发奖：
  //   修为 = ⌊伤害占比 × BOSS 境界 expToNext × KILL_EXP_RATIO⌋
  //   灵石 = ⌊伤害占比 × BOSS 境界 expToNext × KILL_STONE_RATIO⌋
  KILL_EXP_RATIO: 0.1,
  KILL_STONE_RATIO: 0.01,

  // 最后一击掉落：1~3 件，从下方掉落池按权重抽取
  KILL_DROP_MIN: 1,
  KILL_DROP_MAX: 3,
}

/** 依玩家最高境界随机生成世界 BOSS 的境界等级（数字） */
function rollWorldBossLevel(topPlayerLevelId: string): number {
  const topLvNum = Number(topPlayerLevelId) || WORLD_BOSS_CONFIG.MIN_LEVEL
  const maxLv = Math.max(WORLD_BOSS_CONFIG.MIN_LEVEL, topLvNum)
  return WORLD_BOSS_CONFIG.MIN_LEVEL
    + Math.floor(Math.random() * (maxLv - WORLD_BOSS_CONFIG.MIN_LEVEL + 1))
}

/**
 * 依世界 BOSS 配置构建战斗单位（战斗时再以数据库中的 hp / maxHp / atk 覆盖）。
 */
export function buildWorldBossUnit(name: string, levelId: string): CombatUnit {
  const lv = getLevel(levelId) ?? getLevel('1')!
  const hp = Math.floor(lv.hp * WORLD_BOSS_CONFIG.HP_MULT)
  const def = Math.min(WORLD_BOSS_CONFIG.MAX_DEF_CAP, lv.def)
  return {
    name,
    hp, maxhp: hp,
    mp: lv.mp, maxmp: lv.mp,
    atk: Math.floor(lv.atk * WORLD_BOSS_CONFIG.ATK_MULT),
    def,
    spd: WORLD_BOSS_CONFIG.SPD,
    crit: WORLD_BOSS_CONFIG.CRIT,
    critDmg: WORLD_BOSS_CONFIG.CRIT_DMG,
    pen: WORLD_BOSS_CONFIG.PEN,
  }
}

/** 生成一只世界 BOSS 并写入数据库（指令与定时任务共用） */
export async function spawnWorldBoss(ctx: Context): Promise<{ name: string; level: number; maxHp: number }> {
  const all = await ctx.database.get(TABLE.player, {}, { sort: { exp: 'desc' }, limit: 1 })
  const topLvId = all[0]?.level || String(WORLD_BOSS_CONFIG.MIN_LEVEL)
  const level = rollWorldBossLevel(topLvId)
  const name = WORLD_BOSS_CONFIG.NAMES[Math.floor(Math.random() * WORLD_BOSS_CONFIG.NAMES.length)]
  const unit = buildWorldBossUnit(name, String(level))

  const id = await getNextId(ctx, TABLE.boss, 'id')
  await ctx.database.create(TABLE.boss, {
    id,
    name, level,
    hp: unit.maxhp, maxHp: unit.maxhp, atk: unit.atk,
  })
  return { name, level, maxHp: unit.maxhp }
}

/** 是否存在存活（hp > 0）的世界 BOSS */
export async function hasAliveWorldBoss(ctx: Context): Promise<boolean> {
  const list = await ctx.database.get(TABLE.boss, {})
  return list.some(b => b.hp > 0)
}

// ======================= 最后一击掉落池 =======================

interface BossDropEntry { id: number; name: string; weight: number }

let _bossDropPoolCache: BossDropEntry[] | null = null

/**
 * 最后一击掉落池：
 *   · 主功法 / 神通 / 武器 / 防具 —— 仅天阶下品及以上（weight ≤ 25）
 *   · 多次突破丹（breakthroughRate 累积类，丹藥屬性中的 1500~1505）
 *   · 各级聚灵旗（5000~5004）
 *   · 各级炼丹炉（4001~4003）
 * 全部按物品自身的 weight 加权抽取
 */
function buildBossDropPool(): BossDropEntry[] {
  if (_bossDropPoolCache) return _bossDropPoolCache

  const pool: BossDropEntry[] = []
  const push = (id: string, v: any) => {
    if (!v?.name) return
    pool.push({
      id: Number(id),
      name: v.name,
      weight: Math.max(1, Number(v.weight) || 1),
    })
  }

  // 天阶下品以上 = weight ≤ 25（对应品階概率表：天阶下品=25 / 天阶上品=20 / 仙阶下品=15 / 仙阶上品=10）
  const HIGH_TIER_MAX_WEIGHT = 25

  for (const [id, v] of Object.entries(data.gongfa)) {
    if (v.weight <= HIGH_TIER_MAX_WEIGHT) push(id, v)
  }
  for (const [id, v] of Object.entries(data.shentong)) {
    if (v.weight <= HIGH_TIER_MAX_WEIGHT) push(id, v)
  }
  for (const [id, v] of Object.entries(data.weapons)) {
    if (v.weight <= HIGH_TIER_MAX_WEIGHT) push(id, v)
  }
  for (const [id, v] of Object.entries(data.armors)) {
    if (v.weight <= HIGH_TIER_MAX_WEIGHT) push(id, v)
  }

  // 多次突破丹：按 stat === 'breakthroughRate' 识别（1500~1505 冰心丹~天命炼心丹）
  for (const [id, v] of Object.entries(data.pills)) {
    const mods = (v.modifiers ?? []) as Array<{ stat: string }>
    if (mods.some(m => m.stat === 'breakthroughRate')) push(id, v)
  }

  // 各级聚灵旗
  for (const [id, v] of Object.entries(data.qiFlags)) push(id, v)

  // 各级炼丹炉
  for (const [id, v] of Object.entries(data.furnaces)) push(id, v)

  _bossDropPoolCache = pool
  return pool
}

/** 按权重随机抽 count 件（允许同名重复），返回 [{id, name}] */
function rollBossDrops(count: number): Array<{ id: number; name: string }> {
  const pool = buildBossDropPool()
  const out: Array<{ id: number; name: string }> = []
  for (let i = 0; i < count; i++) {
    const picked = weightedPick(pool, it => it.weight)
    if (picked) out.push({ id: picked.id, name: picked.name })
  }
  return out
}

// ======================= 击杀结算 =======================

/**
 * 结算一只已被击杀（hp ≤ 0）的 BOSS。
 * 先以「删除 BOSS 行」占用结算权（同一只 BOSS 只会被结算一次），
 * 每位参与者的奖励各自独立处理（单人出错只记日志、不影响其他人），最后一定清除参与记录。
 * @returns 结算公告；未抢到结算权（已被结算）时返回 null
 */
async function settleWorldBossKill(
  ctx: Context,
  boss: BossRow,
  lastHit?: { uid: number; name: string },
): Promise<string | null> {
  if (!(await claimByRemove(ctx, TABLE.boss, { id: boss.id, hp: { $lte: 0 } }))) return null

  const logger = ctx.logger('xiuxian')
  const bossLv = getLevel(String(boss.level))
  const baseExp = bossLv?.expToNext ?? 0
  const rewardLines: string[] = []
  let lastHitLine = ''
  let parts: Array<{ uid: number; damage: number }> = []

  try {
    parts = await ctx.database.get(TABLE.bossP, { bossId: boss.id })
    const totalDmg = parts.reduce((s, pt) => s + (pt.damage || 0), 0)

    for (const pt of parts) {
      try {
        const pl = await getPlayer(ctx, pt.uid)
        if (!pl) continue

        const ratio = totalDmg > 0 ? (pt.damage || 0) / totalDmg : 0
        const expReward = Math.floor(ratio * baseExp * WORLD_BOSS_CONFIG.KILL_EXP_RATIO)
        const stoneReward = Math.floor(ratio * baseExp * WORLD_BOSS_CONFIG.KILL_STONE_RATIO)

        if (expReward > 0) await addPlayerExp(ctx, pl.uid, expReward)
        if (stoneReward > 0) await addStone(ctx, pl.uid, stoneReward)

        rewardLines.push(
          `· ${pl.userName}（伤害 ${formatCompact(pt.damage)}，占比 ${(ratio * 100).toFixed(1)}%）` +
          ` → 修为 +${formatCompact(expReward)}｜灵石 +${formatCompact(stoneReward)}`,
        )
      } catch (e: any) {
        logger.warn(`世界 BOSS「${boss.name}」参与者 uid=${pt.uid} 奖励发放失败: ${e?.message ?? e}`)
      }
    }

    // 最后一击掉落：1~3 件，从掉落池按权重抽取（允许重复，同名自动合并显示）
    if (lastHit) {
      const dropRange = WORLD_BOSS_CONFIG.KILL_DROP_MAX - WORLD_BOSS_CONFIG.KILL_DROP_MIN + 1
      const dropCount = WORLD_BOSS_CONFIG.KILL_DROP_MIN + Math.floor(Math.random() * dropRange)
      const merged = mergeDrops(rollBossDrops(dropCount))
      if (merged.length > 0) {
        const dropStr = formatDropList(merged)
        try {
          for (const d of merged) await addItem(ctx, lastHit.uid, d.id, d.num)
          lastHitLine = `🎯 最后一击：${lastHit.name} 获得 ${dropStr}`
        } catch (e: any) {
          logger.warn(`最后一击奖励发放失败: ${e?.message ?? e}`)
          lastHitLine = `⚠️ 最后一击奖励发放失败（${dropStr}）`
        }
      }
    }

    const head = `🎉 击杀 ${boss.name}！（${bossLv?.name ?? '?'}｜参战 ${parts.length} 人｜总伤害 ${formatCompact(totalDmg)}）`
    const rewardBlock = rewardLines.length ? ['参战者奖励：', ...rewardLines].join('\n') : ''
    return [head, rewardBlock, lastHitLine].filter(Boolean).join('\n')
  } finally {
    await ctx.database.remove(TABLE.bossP, { bossId: boss.id })
  }
}

/** 结算并清理所有残留的已击杀（hp ≤ 0）BOSS（例如上次结算中途出错留下的），返回处理数量 */
export async function settleDeadWorldBosses(ctx: Context): Promise<number> {
  const dead = await ctx.database.get(TABLE.boss, { hp: { $lte: 0 } })
  let n = 0
  for (const b of dead) {
    if (await settleWorldBossKill(ctx, b)) n++
  }
  return n
}

/** 累加某玩家对 BOSS 的伤害（原子 $.add；首次参战则新建记录） */
async function addBossDamage(ctx: Context, bossId: number, uid: number, platform: string, damage: number) {
  const dmg = Math.floor(damage)
  const res = await ctx.database.set(TABLE.bossP, { bossId, uid }, row => ({ damage: $.add(row.damage, dmg) }))
  if (getAffectedRows(res) === 0) {
    await ctx.database.create(TABLE.bossP, { bossId, uid, platform, damage: dmg })
  }
}

// ======================= 命令注册 =======================

export function registerBossCommands(ctx: Context) {
  ctx.command('世界boss帮助', 'BOSS 说明').action(() => [
    '查看世界boss',
    '讨伐世界boss [编号]',
    '创建世界boss（管理）',
  ].join('\n'))

  ctx.command('创建世界boss', '生成BOSS', { authority: 5 })
    .action(async () => {
      const { name, level, maxHp } = await spawnWorldBoss(ctx)
      return `👹 世界 BOSS「${name}」已生成（境界 ${getLevel(String(level))?.name}，HP ${formatCompact(maxHp)}）`
    })

  ctx.command('查看世界boss', '查看当前世界 BOSS')
    .action(async () => {
      await settleDeadWorldBosses(ctx)
      const list = await ctx.database.get(TABLE.boss, {})
      if (!list.length) return '当前没有活跃的世界 BOSS'
      return '👹 世界 BOSS\n' + list.map((b, i) =>
        `${i + 1}. ${b.name}（境界 ${getLevel(String(b.level))?.name}｜气血 ${formatCompact(b.hp)}/${formatCompact(b.maxHp)}，${formatPct(b.hp, b.maxHp)}%）`
      ).join('\n')
    })

  ctx.command('讨伐世界boss [no:number]', '战斗')
    .action(async ({ session }, no) => {
      const prep = await requireBattleReadyPlayer(ctx, session)
      if (typeof prep === 'string') return prep
      const { player: p, unit: me } = prep

      await settleDeadWorldBosses(ctx)
      const list = await ctx.database.get(TABLE.boss, {})
      if (!list.length) return '暂无 BOSS'
      const idx = (no ?? 1) - 1
      const boss = list[idx]
      if (!boss) return '编号不存在'
      if (boss.hp <= 0) return '该 BOSS 已被击杀'

      // 用世界 BOSS 配置重建战斗单位（DB 内 hp/atk 覆盖为最新进度）
      const bossUnit = buildWorldBossUnit(boss.name, String(boss.level))
      bossUnit.hp = boss.hp
      bossUnit.maxhp = boss.maxHp
      bossUnit.atk = boss.atk
      const result = simulateBattle(me, bossUnit)
      const myDmg = Math.max(0, Math.floor(boss.hp - bossUnit.hp))

      // 累积参战伤害、扣减 BOSS 气血（均为原子增减，避免同时讨伐时互相覆盖）
      if (myDmg > 0) {
        await addBossDamage(ctx, boss.id, p.uid, session?.platform ?? '', myDmg)
        await ctx.database.set(TABLE.boss, { id: boss.id }, row => ({ hp: $.sub(row.hp, myDmg) }))
      }
      p.hp = me.hp
      p.mp = me.mp
      await recomputeAndSaveStats(ctx, p)

      recordBattle(p.uid, {
        ts: Date.now(),
        title: `讨伐世界 BOSS「${boss.name}」`,
        log: result.log,
        winner: result.winner,
        playerName: me.name,
        opponentName: boss.name,
      })

      const [after] = await ctx.database.get(TABLE.boss, { id: boss.id })
      const [myPart] = await ctx.database.get(TABLE.bossP, { bossId: boss.id, uid: p.uid })

      // ==================== 击杀结算 ====================
      if (!after || after.hp <= 0) {
        const settled = after
          ? await settleWorldBossKill(ctx, after, { uid: p.uid, name: me.name })
          : null
        if (settled) return settled
        return `⚔️ 你对 ${boss.name} 造成 ${formatCompact(myDmg)} 伤害，BOSS 已被击杀（由其他道友完成结算）`
      }

      // 未击杀
      return `⚔️ 你对 ${boss.name} 造成 ${formatCompact(myDmg)} 伤害，剩 ${formatCompact(after.hp)}/${formatCompact(after.maxHp)}（${formatPct(after.hp, after.maxHp)}%，你的累计：${formatCompact(myPart?.damage ?? myDmg)}）`
    })
}
