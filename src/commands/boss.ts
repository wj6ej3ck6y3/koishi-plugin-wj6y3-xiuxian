import { Context } from 'koishi'
import { data, getLevel } from '../data'
import { TABLE } from '../models'
import {
  simulateBattle, addStone, addItem, refreshPlayerStats,
  getNextId,
  preparePlayerBattle,
  recordBattle,
  CombatUnit,
  formatPct,
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
 * 依世界 BOSS 配置构建战斗单位。
 * 每次战斗都用它重建（DB 只存进度），因此改配置后所有活跃 BOSS 立即生效。
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
    if ((v as any).weight <= HIGH_TIER_MAX_WEIGHT) push(id, v)
  }
  for (const [id, v] of Object.entries(data.shentong)) {
    if ((v as any).weight <= HIGH_TIER_MAX_WEIGHT) push(id, v)
  }
  for (const [id, v] of Object.entries(data.weapons)) {
    if ((v as any).weight <= HIGH_TIER_MAX_WEIGHT) push(id, v)
  }
  for (const [id, v] of Object.entries(data.armors)) {
    if ((v as any).weight <= HIGH_TIER_MAX_WEIGHT) push(id, v)
  }

  // 多次突破丹：按 stat === 'breakthroughRate' 识别（1500~1505 冰心丹~天命炼心丹）
  for (const [id, v] of Object.entries(data.pills)) {
    const mods = ((v as any).modifiers ?? []) as Array<{ stat: string }>
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
  if (pool.length === 0) return []

  const total = pool.reduce((s, it) => s + it.weight, 0)
  const out: Array<{ id: number; name: string }> = []

  for (let i = 0; i < count; i++) {
    let r = Math.random() * total
    let picked = pool[pool.length - 1]
    for (const it of pool) {
      r -= it.weight
      if (r <= 0) { picked = it; break }
    }
    out.push({ id: picked.id, name: picked.name })
  }
  return out
}

// ======================= 命令注册 =======================

export function registerBossCommands(ctx: Context) {
  ctx.command('世界boss帮助', 'BOSS 说明').action(() => [
    '查看世界boss',
    '讨伐世界boss [编号]',
    '创建世界boss（管理）',
  ].join('\n'))

  ctx.command('创建世界boss', '生成BOSS')
    .action(async () => {
      const all = await ctx.database.get(TABLE.player, {}, { sort: { exp: 'desc' }, limit: 1 })
      const topLvId = all[0]?.level || String(WORLD_BOSS_CONFIG.MIN_LEVEL)
      const bossLv = rollWorldBossLevel(topLvId)
      const name = WORLD_BOSS_CONFIG.NAMES[Math.floor(Math.random() * WORLD_BOSS_CONFIG.NAMES.length)]
      const unit = buildWorldBossUnit(name, String(bossLv))

      const id = await getNextId(ctx, TABLE.boss, 'id')
      await ctx.database.create(TABLE.boss, {
        id,
        name, level: bossLv,
        hp: unit.maxhp, maxHp: unit.maxhp, atk: unit.atk,
      })
      return `👹 世界 BOSS「${name}」已生成（境界 ${getLevel(String(bossLv))?.name}，HP ${unit.maxhp}）`
    })

  ctx.command('查看世界boss', '查看当前世界 BOSS')
    .action(async () => {
      const list = await ctx.database.get(TABLE.boss, {})
      if (!list.length) return '当前没有活跃的世界 BOSS'
      return '👹 世界 BOSS\n' + list.map((b, i) =>
        `${i + 1}. ${b.name}（境界 ${getLevel(String(b.level))?.name}｜气血 ${b.hp}/${b.maxHp}，${formatPct(b.hp, b.maxHp)}%）`
      ).join('\n')
    })

  ctx.command('讨伐世界boss [no:number]', '战斗')
    .action(async ({ session }, no) => {
      const prep = await preparePlayerBattle(ctx, session)
      if (typeof prep === 'string') return prep
      const { player: p, unit: me } = prep

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
      const myDmg = Math.floor(boss.hp - bossUnit.hp)

      // 累积参战伤害
      const exist = await ctx.database.get(TABLE.bossP, { bossId: boss.id, uid: p.uid })
      const oldDmg = exist[0]?.damage ?? 0
      await ctx.database.upsert(
        TABLE.bossP,
        [{ bossId: boss.id, uid: p.uid, platform: session.platform, damage: oldDmg + myDmg }],
        ['bossId', 'uid'],
      )

      await ctx.database.set(TABLE.boss, { id: boss.id }, { hp: Math.max(0, bossUnit.hp) })
      p.hp = me.hp
      p.mp = me.mp
      await refreshPlayerStats(ctx, p)

      recordBattle(p.uid, {
        ts: Date.now(),
        title: `讨伐世界 BOSS「${boss.name}」`,
        log: result.log,
        winner: result.winner,
        playerName: me.name,
        opponentName: boss.name,
      })

      // ==================== 击杀结算 ====================
      if (bossUnit.hp <= 0) {
        const parts = await ctx.database.get(TABLE.bossP, { bossId: boss.id })
        const totalDmg = parts.reduce((s, pt) => s + (pt.damage || 0), 0)
        const bossLv = getLevel(String(boss.level))
        const baseExp = bossLv?.expToNext ?? 0

        const rewardLines: string[] = []
        for (const pt of parts) {
          const pl = (await ctx.database.get(TABLE.player, { uid: pt.uid }))[0]
          if (!pl) continue

          const ratio = totalDmg > 0 ? (pt.damage || 0) / totalDmg : 0
          const expReward = Math.floor(ratio * baseExp * WORLD_BOSS_CONFIG.KILL_EXP_RATIO)
          const stoneReward = Math.floor(ratio * baseExp * WORLD_BOSS_CONFIG.KILL_STONE_RATIO)

          if (expReward > 0) {
            pl.exp += expReward
            await ctx.database.set(TABLE.player, { uid: pl.uid }, { exp: pl.exp })
          }
          if (stoneReward > 0) await addStone(ctx, pl.uid, stoneReward)

          rewardLines.push(
            `· ${pl.userName}（伤害 ${Math.floor(pt.damage)}，占比 ${(ratio * 100).toFixed(1)}%）` +
            ` → 修为 +${expReward}｜灵石 +${stoneReward}`,
          )
        }

        // 最后一击掉落：1~3 件，从掉落池按权重抽取（允许重复，同名自动合并显示）
        let lastHitLine = ''
        if (result.winner === 'a') {
          const dropRange = WORLD_BOSS_CONFIG.KILL_DROP_MAX - WORLD_BOSS_CONFIG.KILL_DROP_MIN + 1
          const dropCount = WORLD_BOSS_CONFIG.KILL_DROP_MIN + Math.floor(Math.random() * dropRange)
          const drops = rollBossDrops(dropCount)

          const merged = new Map<number, { name: string; num: number }>()
          for (const d of drops) {
            const cur = merged.get(d.id)
            if (cur) cur.num += 1
            else merged.set(d.id, { name: d.name, num: 1 })
          }

          if (merged.size > 0) {
            const dropStr = [...merged.values()].map(x => `${x.name}×${x.num}`).join('、')
            try {
              for (const [id, info] of merged) {
                await addItem(ctx, p.uid, id, info.num)
              }
              lastHitLine = `\n🎯 最后一击：${me.name} 获得 ${dropStr}`
            } catch (e: any) {
              ctx.logger('xiuxian').warn(`最后一击奖励发放失败: ${e?.message ?? e}`)
              lastHitLine = `\n⚠️ 最后一击奖励发放失败（${dropStr}）`
            }
          }
        }

        await ctx.database.remove(TABLE.boss, { id: boss.id })
        await ctx.database.remove(TABLE.bossP, { bossId: boss.id })

        const head = `🎉 击杀 ${boss.name}！（${bossLv?.name ?? '?'}｜参战 ${parts.length} 人｜总伤害 ${Math.floor(totalDmg)}）`
        const rewardBlock = rewardLines.length ? ['参战者奖励：', ...rewardLines].join('\n') : ''
        return [head, rewardBlock, lastHitLine].filter(Boolean).join('\n')
      }

      // 未击杀
      return `⚔️ 你对 ${boss.name} 造成 ${myDmg} 伤害，剩 ${bossUnit.hp}/${boss.maxHp}（${formatPct(bossUnit.hp, boss.maxHp)}%，你的累计：${oldDmg + myDmg}）`
    })
}