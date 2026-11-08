import { Context } from 'koishi'
import { getLevel, rollRoot, rollRootExcluding } from '../data'
import { TABLE } from '../models'
import { data } from '../data'
import {
  requirePlayer, costStone, refreshPlayerStats,
  getPlayer, getStone,
  formatRemainTime,
  getAffectedRows,
} from '../utils'

export function registerLongtermCommands(ctx: Context) {

  ctx.command('重入仙途 [confirm:string]', '彻底重置修仙之路（保留宗门与职位）')
    .action(async ({ session }, confirm) => {
      if (confirm !== '确认') {
        return [
          '⚠️ 重入仙途将清空除「宗门」与「职位」外的所有游戏进度！',
          '',
          '会清空：境界、修为、灵根、功法、神通、背包、灵石（持有 + 灵庄）、',
          '洞府、灵田、装备、每日次数、单次丹记录、进行中活动……',
          '',
          '如需继续，请发送「重入仙途 确认」',
        ].join('\n')
      }

      const p = await requirePlayer(ctx, session)
      if (p.uid === null) return '灵石服务未同步'

      const lv1 = getLevel('1')!
      const [rootId, root] = rollRoot()

      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        level: '1', exp: 0, rebirth: 0,
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
        blessedSpotFlag: 0, blessedSpotName: '', plotCount: 0,
        root: rootId,
        isSign: new Date(0),
        insightCd: new Date(0),
      })

      await ctx.database.remove(TABLE.skill, { userId: p.userId })
      await ctx.database.remove(TABLE.buff, { userId: p.userId })
      await ctx.database.remove(TABLE.pillUsed, { userId: p.userId })
      await ctx.database.remove(TABLE.back, { userId: p.userId })
      await ctx.database.remove(TABLE.bank, { userId: p.userId })
      await ctx.database.remove(TABLE.plot, { userId: p.userId })
      await ctx.database.remove(TABLE.cd, { userId: p.userId })
      await ctx.database.remove(TABLE.quest, { userId: p.userId })
      await ctx.database.remove(TABLE.work, { userId: p.userId })
      await ctx.database.remove(TABLE.bountyList, { userId: p.userId })

      const curStone = await getStone(ctx, p.uid)
      if (curStone > 0) await costStone(ctx, p.uid, curStone)

      const updated = await getPlayer(ctx, p.userId)
      if (updated) await refreshPlayerStats(ctx, updated)

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
      await ctx.database.set(TABLE.player, { userId: p.userId }, { atkPractice: p.atkPractice + 1 })
      await refreshPlayerStats(ctx, p)
      return `🗿 攻击修炼提升至 ${p.atkPractice + 1} 重（+${(p.atkPractice + 1) * 4}% 攻击）`
    })

  // ===== 参悟天机（B8：内存 CD → 落库 insightCd + 原子占位） =====
  ctx.command('参悟天机', '随机顿悟').alias('顿悟')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const now = Date.now()

      // 老数据懒迁移：insightCd 为空时补 new Date(0)
      if (!p.insightCd) {
        await ctx.database.set(TABLE.player, { userId: p.userId }, { insightCd: new Date(0) })
        p.insightCd = new Date(0)
      }

      const oldCd = +new Date(p.insightCd)
      if (now < oldCd) return `CD 中，还需 ${formatRemainTime(oldCd - now)}`

      // ✅ 原子占位：只有旧 insightCd 仍是本次读到的值时才成功，防并发双触发
      const newCd = new Date(now + 60 * 60 * 1000)
      const writeRes: any = await ctx.database.set(TABLE.player, {
        userId: p.userId,
        insightCd: new Date(oldCd),
      }, { insightCd: newCd })

      const affected = getAffectedRows(writeRes)
      // ✅ 只有明确「修改 0 行」才判定被并发抢走；-1（adapter 不提供行数）按乐观处理
      if (affected === 0) return 'CD 中，请稍后再试'

      // 30% 失败无事发生
      if (Math.random() < 0.3) {
        return '🌫️ 参悟天机，却未能有所收获……'
      }

      const needExp = getLevel(p.level)?.expToNext ?? 1000
      const rate = 0.001 + Math.random() * 0.009
      const gainExp = Math.max(1, Math.floor(needExp * rate))

      const gainRate = Math.random() < 0.3 ? 1 + Math.floor(Math.random() * 3) : 0

      p.exp += gainExp
      p.levelUpRate = (p.levelUpRate || 0) + gainRate
      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        exp: p.exp, levelUpRate: p.levelUpRate,
      })

      return `✨ 顿悟！修为 +${gainExp}${gainRate ? `，突破率累计 +${gainRate}%` : ''}`
    })

  // 飞升转世
  ctx.command('飞升转世', '飞升')
    .alias('飞升').alias('转世')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.uid === null) return '灵石服务未同步'

      const cfgMax = (ctx as any).config?.rebirthMaxLevel
      const maxLevelId = cfgMax && cfgMax !== ''
        ? cfgMax
        : String(Object.keys(data.levels).map(Number).reduce((a, b) => Math.max(a, b)))
      const maxLv = getLevel(maxLevelId)
      if (!maxLv) return '境界数据缺失'
      if (p.level !== maxLevelId) return `需达「${maxLv.name}」方可飞升`
      if (p.exp < maxLv.expToNext) return `修为不足（需 ${maxLv.expToNext}，当前 ${Math.floor(p.exp)}）`

      const newRebirth = (p.rebirth || 0) + 1
      const lv1 = getLevel('1')!

      const [rootId, root] = rollRootExcluding(newRebirth)

      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        level: '1', exp: 0, rebirth: newRebirth,
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
        root: rootId,
      })

      await ctx.database.remove(TABLE.skill, { userId: p.userId })

      await ctx.database.set(TABLE.buff, { userId: p.userId }, {
        mainBuff: 0, secBuff: 0, subBuff: 0,
        faqiBuff: 0, armorBuff: 0, atkBuff: 0,
        furnaceBuff: 0, qiFlagBuff: 0,
      } as any)

      await ctx.database.remove(TABLE.pillUsed, { userId: p.userId })
      await ctx.database.remove(TABLE.back, { userId: p.userId })

      const [bankRow] = await ctx.database.get(TABLE.bank, { userId: p.userId })
      if (bankRow) {
        await ctx.database.set(TABLE.bank, { userId: p.userId }, {
          saveStone: 0,
          saveTime: new Date(),
        })
      }

      const curStone = await getStone(ctx, p.uid)
      if (curStone > 0) await costStone(ctx, p.uid, curStone)

      await ctx.database.remove(TABLE.cd, { userId: p.userId })
      await ctx.database.remove(TABLE.quest, { userId: p.userId })
      await ctx.database.remove(TABLE.work, { userId: p.userId })
      await ctx.database.remove(TABLE.bountyList, { userId: p.userId })

      const updated = await getPlayer(ctx, p.userId)
      if (updated) await refreshPlayerStats(ctx, updated)

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
  ctx.command('双修', '与道侣双修')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const target = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
      if (!target) return '请 @ 道侣'
      if (target === p.userId) return '不能与自己双修'

      const t = await ctx.database.get(TABLE.player, { userId: target })
      if (!t[0]) return '对方尚未入仙途'

      const myLvNum = parseInt(p.level, 10) || 1
      const targetLvNum = parseInt(t[0].level, 10) || 1
      if (myLvNum < targetLvNum - 3) {
        return '对方看了你一眼，冷哼着离开了。'
      }

      const dayKey = new Date().toDateString()
      const last = new Date(p.dualCultivationTime)
      let cnt = p.dualCultivation
      if (last.toDateString() !== dayKey) cnt = 0
      if (cnt >= 3) return '今日双修次数已用尽'

      const baseExp = (p.exp + t[0].exp) / 200
      const gain = Math.floor(baseExp * (0.75 + Math.random() * 0.5))

      p.exp += gain
      t[0].exp += gain
      let rateMsg = ''
      if (Math.random() < 0.1) {
        p.levelUpRate = (p.levelUpRate || 0) + 2
        t[0].levelUpRate = (t[0].levelUpRate || 0) + 2
        rateMsg = '，双方突破率 +2%'
      }
      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        exp: p.exp, dualCultivation: cnt + 1, dualCultivationTime: new Date(),
        levelUpRate: p.levelUpRate,
      })
      await ctx.database.set(TABLE.player, { userId: target }, {
        exp: t[0].exp, levelUpRate: t[0].levelUpRate,
      })
      return `与 ${t[0].userName} 双修，双方修为 +${gain}${rateMsg}`
    })
}

function getRebirthTitle(n: number): string {
  if (n >= 10) return '转世道祖'
  if (n >= 5) return '转世真仙'
  if (n >= 1) return '转世散仙'
  return '凡人'
}