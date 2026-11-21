import { Context } from 'koishi'
import { Config } from '../config'
import { getLevel, rollRoot, rollRootExcluding } from '../data'
import { TABLE, Player } from '../models'
import { data } from '../data'
import {
  requirePlayer, costStone, recomputeAndSaveStats,
  getPlayer, getStone,
  addPlayerExp,
  isSameDay,
  formatRemainTime,
  getAffectedRows,
  resolveAtUid,
} from '../utils'

/**
 * 重入仙途 / 飞升转世共用的进度重置。
 * - full = true （重入仙途）：连同洞府、灵田、签到与参悟冷却一并清空；槽位行与灵庄行直接删除。
 * - full = false（飞升转世）：保留洞府与灵田、签到与参悟冷却；槽位只清装备与攻击加成（保留洞府灵气），灵庄保留等级、存款清零。
 * 两者都会清空：功法神通、背包、单次丹与攻击丹服用记录、进行中活动、持有灵石。
 */
async function resetPlayerProgress(
  ctx: Context, p: Player,
  opts: { full: boolean; rebirth: number; rootId: string },
): Promise<void> {
  const lv1 = getLevel('1')!

  await ctx.database.set(TABLE.player, { uid: p.uid }, {
    level: '1', exp: 0, rebirth: opts.rebirth,
    levelUpRate: 0, levelUpCd: new Date(0),
    exercisesLevel: '20001',
    hp: lv1.hp, maxhp: lv1.hp, mp: lv1.mp, maxmp: lv1.mp, atk: lv1.atk,
    power: lv1.power,
    atkPractice: 0,
    dualCultivation: 0, dualCultivationTime: new Date(0),
    riftCd: new Date(0), riftDailyCount: 0,
    workRefreshCount: 0, workRefreshCountTime: 0,
    sectContribution: 0,
    sectMissionId: 0, sectMissionDoneAt: new Date(0),
    sectOfferingGet: new Date(0),
    root: opts.rootId,
    ...(opts.full ? {
      blessedSpotFlag: 0, blessedSpotName: '', plotCount: 0,
      isSign: new Date(0),
      insightCd: new Date(0),
    } : {}),
  })

  await ctx.database.remove(TABLE.skill, { uid: p.uid })

  if (opts.full) {
    await ctx.database.remove(TABLE.buff, { uid: p.uid })
  } else {
    await ctx.database.set(TABLE.buff, { uid: p.uid }, {
      mainBuff: 0, secBuff: 0, subBuff: 0,
      faqiBuff: 0, armorBuff: 0, atkBuff: 0,
      furnaceBuff: 0, qiFlagBuff: 0,
    })
  }

  await ctx.database.remove(TABLE.pillUsed, { uid: p.uid })
  await ctx.database.remove(TABLE.pillLimit, { uid: p.uid })
  await ctx.database.remove(TABLE.back, { uid: p.uid })

  if (opts.full) {
    await ctx.database.remove(TABLE.bank, { uid: p.uid })
    await ctx.database.remove(TABLE.plot, { uid: p.uid })
  } else {
    const [bankRow] = await ctx.database.get(TABLE.bank, { uid: p.uid })
    if (bankRow) {
      await ctx.database.set(TABLE.bank, { uid: p.uid }, {
        saveStone: 0,
        saveTime: new Date(),
      })
    }
  }

  await ctx.database.remove(TABLE.cd, { uid: p.uid })
  await ctx.database.remove(TABLE.quest, { uid: p.uid })
  await ctx.database.remove(TABLE.work, { uid: p.uid })
  await ctx.database.remove(TABLE.bountyList, { uid: p.uid })

  const curStone = await getStone(ctx, p.uid)
  if (curStone > 0) await costStone(ctx, p.uid, curStone)

  const updated = await getPlayer(ctx, p.uid)
  if (updated) await recomputeAndSaveStats(ctx, updated)
}

export function registerLongtermCommands(ctx: Context, config: Config) {

  ctx.command('重入仙途 [confirm:string]', '彻底重置修仙之路（保留宗门与职位）')
    .action(async ({ session }, confirm) => {
      if (confirm !== '确认') {
        return [
          '⚠️ 重入仙途将清空除「宗门」与「职位」外的所有游戏进度！',
          '',
          '会清空：境界、修为、灵根、功法、神通、背包、灵石（持有 + 灵庄）、',
          '洞府、灵田、装备、每日次数、单次丹 / 攻击丹服用记录、进行中活动……',
          '',
          '如需继续，请发送「重入仙途 确认」',
        ].join('\n')
      }

      const p = await requirePlayer(ctx, session)
      const [rootId, root] = rollRoot()
      await resetPlayerProgress(ctx, p, { full: true, rebirth: 0, rootId })

      return [
        `🔄 你已重入仙途，一切归零（宗门与职位保留）`,
        `🌱 新灵根：${root.name}（${root.tier}）｜攻击倍率 ×${root.atk}`,
      ].join('\n')
    })

  // 传承（攻击修炼）
  ctx.command('传承帮助', '传承说明').action(() => [
    '🗿参悟传承（最高 9 重，每重 +4% 攻击）',
  ].join('\n'))
  ctx.command('参悟传承', '攻击修炼').alias('升级攻击修炼')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.atkPractice >= 9) return '攻击修炼已达 9 重'
      const cost = 1_000_000 * Math.pow(2, p.atkPractice)
      if (!(await costStone(ctx, p.uid, cost))) return `需 ${cost} 灵石`
      await ctx.database.set(TABLE.player, { uid: p.uid }, { atkPractice: p.atkPractice + 1 })
      await recomputeAndSaveStats(ctx, p)
      return `🗿 攻击修炼提升至 ${p.atkPractice + 1} 重（+${(p.atkPractice + 1) * 4}% 攻击）`
    })

  // ===== 参悟天机 =====
  ctx.command('参悟天机', '随机顿悟').alias('顿悟')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const now = Date.now()

      // 老数据懒迁移：insightCd 为空时补 new Date(0)
      if (!p.insightCd) {
        await ctx.database.set(TABLE.player, { uid: p.uid }, { insightCd: new Date(0) })
        p.insightCd = new Date(0)
      }

      const oldCd = +new Date(p.insightCd)
      if (now < oldCd) return `CD 中，还需 ${formatRemainTime(oldCd - now)}`

      const newCd = new Date(now + 60 * 60 * 1000)
      const writeRes = await ctx.database.set(TABLE.player, {
        uid: p.uid,
        insightCd: new Date(oldCd),
      }, { insightCd: newCd })

      const affected = getAffectedRows(writeRes)
      if (affected === 0) return 'CD 中，请稍后再试'

      if (Math.random() < 0.3) {
        return '🌫️ 参悟天机，却未能有所收获……'
      }

      const needExp = getLevel(p.level)?.expToNext ?? 1000
      const rate = 0.001 + Math.random() * 0.009
      const gainExp = Math.max(1, Math.floor(needExp * rate))

      const gainRate = Math.random() < 0.3 ? 1 + Math.floor(Math.random() * 5) : 0

      p.levelUpRate = (p.levelUpRate || 0) + gainRate
      await addPlayerExp(ctx, p.uid, gainExp)
      await ctx.database.set(TABLE.player, { uid: p.uid }, {
        levelUpRate: p.levelUpRate,
      })

      return `✨ 顿悟！修为 +${gainExp}${gainRate ? `，突破率 +${gainRate}%` : ''}`
    })

  // 飞升转世
  ctx.command('飞升转世', '飞升')
    .alias('飞升').alias('转世')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)

      const cfgMax = config.rebirthMaxLevel
      const maxLevelId = cfgMax && cfgMax !== ''
        ? cfgMax
        : String(Object.keys(data.levels).map(Number).reduce((a, b) => Math.max(a, b)))
      const maxLv = getLevel(maxLevelId)
      if (!maxLv) return '境界数据缺失'
      if (p.level !== maxLevelId) return `需达「${maxLv.name}」方可飞升`
      if (p.exp < maxLv.expToNext) return `修为不足（需 ${maxLv.expToNext}，当前 ${Math.floor(p.exp)}）`

      const newRebirth = (p.rebirth || 0) + 1
      const [rootId, root] = rollRootExcluding(newRebirth)
      await resetPlayerProgress(ctx, p, { full: false, rebirth: newRebirth, rootId })

      const excludedNote = newRebirth >= 29
        ? `（已排除 ${newRebirth} 个低阶灵根，仅剩最高阶）`
        : `（已排除前 ${newRebirth} 个低阶灵根）`
      return [
        `🌌 飞升成功！第 ${newRebirth} 次转世，称号：${getRebirthTitle(newRebirth)}`,
        `🌱 灵根重铸：${root.name}（${root.tier}）｜攻击倍率 ×${root.atk}`,
        `💡 ${excludedNote}`,
      ].join('\n')
    })

  ctx.command('我的转世', '查看转世').alias('查看转世')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      return `第 ${p.rebirth || 0} 次转世，称号：${getRebirthTitle(p.rebirth || 0)}`
    })

  // 双修
  ctx.command('双修', '与道侣双修（每日 3 次，只计发起者）')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const targetUid = await resolveAtUid(ctx, session)
      if (targetUid === null) return '请 @ 道侣（对方需在本平台使用过 bot）'
      if (targetUid === p.uid) return '不能与自己双修'

      const target = await getPlayer(ctx, targetUid)
      if (!target) return '对方尚未入仙途'

      const myLvNum = parseInt(p.level, 10) || 1
      const targetLvNum = parseInt(target.level, 10) || 1
      if (myLvNum < targetLvNum - 3) {
        return '对方看了你一眼，冷哼着离开了。'
      }

      let cnt = p.dualCultivation
      if (!isSameDay(p.dualCultivationTime)) cnt = 0
      if (cnt >= 3) return '今日双修次数已用尽'

      const baseExp = (p.exp + target.exp) / 200
      const gain = Math.floor(baseExp * (0.75 + Math.random() * 0.5))

      let rateMsg = ''
      if (Math.random() < 0.1) {
        p.levelUpRate = (p.levelUpRate || 0) + 2
        target.levelUpRate = (target.levelUpRate || 0) + 2
        rateMsg = '，双方突破率 +2%'
      }
      await addPlayerExp(ctx, p.uid, gain)
      await addPlayerExp(ctx, target.uid, gain)
      await ctx.database.set(TABLE.player, { uid: p.uid }, {
        dualCultivation: cnt + 1, dualCultivationTime: new Date(),
        levelUpRate: p.levelUpRate,
      })
      await ctx.database.set(TABLE.player, { uid: target.uid }, {
        levelUpRate: target.levelUpRate,
      })
      return `与 ${target.userName} 双修，双方修为 +${gain}${rateMsg}`
    })
}

function getRebirthTitle(n: number): string {
  if (n >= 10) return '转世道祖'
  if (n >= 5) return '转世真仙'
  if (n >= 1) return '转世散仙'
  return '凡人'
}
