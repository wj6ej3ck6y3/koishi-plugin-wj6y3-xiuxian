import { Context } from 'koishi'
import { getLevel } from '../data'
import { TABLE } from '../models'
import {
  simulateBattle, addStone, addItem, refreshPlayerStats,
  getNextId,
  preparePlayerBattle,
  recordBattle,
  CombatUnit,
  formatPct,
  getItemNameById,
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

  KILL_EXP: 500,
  KILL_STONE: 1000,
  KILL_DROP_ID: 1101,
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

      const bossUnit = buildWorldBossUnit(boss.name, String(boss.level))
      bossUnit.hp = boss.hp
      bossUnit.maxhp = boss.maxHp
      bossUnit.atk = boss.atk
      const result = simulateBattle(me, bossUnit)
      const myDmg = Math.floor(boss.hp - bossUnit.hp)

      const exist = await ctx.database.get(TABLE.bossP, { bossId: boss.id, uid: p.uid })
      const oldDmg = exist[0]?.damage ?? 0
      if (exist[0]) {
        await ctx.database.set(TABLE.bossP, { bossId: boss.id, uid: p.uid }, {
          damage: oldDmg + myDmg,
        })
      } else {
        await ctx.database.create(TABLE.bossP, {
          bossId: boss.id, uid: p.uid, platform: session.platform, damage: myDmg,
        })
      }

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

      if (bossUnit.hp <= 0) {
        const parts = await ctx.database.get(TABLE.bossP, { bossId: boss.id })
        const rewards: string[] = []
        for (const pt of parts) {
          const pl = (await ctx.database.get(TABLE.player, { uid: pt.uid }))[0]
          if (!pl) continue
          pl.exp += WORLD_BOSS_CONFIG.KILL_EXP
          await ctx.database.set(TABLE.player, { uid: pl.uid }, { exp: pl.exp })
          await addStone(ctx, pl.uid, WORLD_BOSS_CONFIG.KILL_STONE)
          rewards.push(`${pl.userName}（累计伤害 ${Math.floor(pt.damage)}）`)
        }

        // ✅ 最后一击奖励：本次执行命令、且 battle winner === 'a' 即为击杀者
        let lastHitLine = ''
        if (result.winner === 'a') {
          const dropRange = WORLD_BOSS_CONFIG.KILL_DROP_MAX - WORLD_BOSS_CONFIG.KILL_DROP_MIN + 1
          const dropCount = WORLD_BOSS_CONFIG.KILL_DROP_MIN + Math.floor(Math.random() * dropRange)
          const dropName = getItemNameById(WORLD_BOSS_CONFIG.KILL_DROP_ID)
          try {
            await addItem(ctx, p.uid, WORLD_BOSS_CONFIG.KILL_DROP_ID, dropCount)
            lastHitLine = `\n🎯 最后一击：${me.name} 获得「${dropName}」×${dropCount}`
          } catch (e: any) {
            ctx.logger('xiuxian').warn(`最后一击奖励发放失败: ${e?.message ?? e}`)
            lastHitLine = `\n⚠️ 最后一击奖励发放失败（物品 #${WORLD_BOSS_CONFIG.KILL_DROP_ID} ×${dropCount}）`
          }
        }

        await ctx.database.remove(TABLE.boss, { id: boss.id })
        await ctx.database.remove(TABLE.bossP, { bossId: boss.id })
        return `🎉 击杀 ${boss.name}！\n参战：${rewards.join('、')}\n每人 +${WORLD_BOSS_CONFIG.KILL_EXP} 修为 +${WORLD_BOSS_CONFIG.KILL_STONE} 灵石${lastHitLine}`
      }
      return `⚔️ 你对 ${boss.name} 造成 ${myDmg} 伤害，剩 ${bossUnit.hp}/${boss.maxHp}（${formatPct(bossUnit.hp, boss.maxHp)}%，你的累计：${oldDmg + myDmg}）`
    })
}