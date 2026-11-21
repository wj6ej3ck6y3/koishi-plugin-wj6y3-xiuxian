import { Context } from 'koishi'
import { Config } from '../config'
import { weightedPick } from '../data'
import { TABLE } from '../models'
import {
  requirePlayer, addStone, addItem, addPlayerExp, floorRow,
  getBusyKind, getDropCategoryWeights, rollDrops, mergeDrops, formatDropList,
  isSameDay, formatRemainTime,
} from '../utils'

// 秘境结果四档（掉落档不再是固定生骨丹）
const OUTCOMES = [
  { w: 40, kind: 'stone' as const },
  { w: 35, kind: 'exp' as const },
  { w: 15, kind: 'drop' as const },
  { w: 10, kind: 'hurt' as const },
]

export function registerRiftCommands(ctx: Context, config: Config) {
  ctx.command('秘境帮助', '说明').action(() => [
    '🌀 探索秘境：每日 3 次；同一天内两次探索需间隔 1 小时（跨日重置），随机获得灵石 / 修为 / 物品，或受伤。',
  ].join('\n'))

  ctx.command('探索秘境', '秘境探索')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)

      // ✅ 互斥检查（只对闭关/悬赏，不影响反向）
      const busy = await getBusyKind(ctx, p.uid)
      if (busy === 'closed') return '你正在闭关中，无法探索秘境'
      if (busy === 'bounty') return '你正在进行悬赏令，无法探索秘境'

      // ✅ 秘境自身 CD / 每日次数
      const now = new Date()
      const last = new Date(p.riftCd)
      const sameDay = isSameDay(last, now)
      if (!sameDay) {
        p.riftDailyCount = 0
      }
      if (p.riftDailyCount >= 3) return '今日探索次数已用尽'
      if (sameDay && Date.now() - +last < 3600 * 1000) {
        const remainMs = 3600 * 1000 - (Date.now() - +last)
        return `冷却中，还需 ${formatRemainTime(remainMs)}`
      }

      // 更新 CD + 次数
      await ctx.database.set(TABLE.player, { uid: p.uid }, {
        riftCd: now, riftDailyCount: p.riftDailyCount + 1,
      })

      // 抽取结果
      const chosen = weightedPick(OUTCOMES, o => o.w) ?? OUTCOMES[0]

      const weights = getDropCategoryWeights(config)
      const dropChance = config.riftDropChance
      const msg: string[] = []

      if (chosen.kind === 'stone') {
        const a = 200 + Math.floor(Math.random() * 800)
        await addStone(ctx, p.uid, a)
        msg.push(`🌀 探索秘境，发现灵石 ×${a}`)
        if (Math.random() * 100 < dropChance) {
          const drops = rollDrops(weights, 1)
          if (drops.length > 0) {
            for (const d of drops) await addItem(ctx, p.uid, d.id, 1)
            msg.push(`🎁 额外获得：${formatDropList(mergeDrops(drops))}`)
          }
        }
        return msg.join('\n')
      }

      if (chosen.kind === 'exp') {
        const a = 100 + Math.floor(Math.random() * 500)
        await addPlayerExp(ctx, p.uid, a)
        msg.push(`🌀 偶遇灵气漩涡，修为 +${a}`)
        if (Math.random() * 100 < dropChance) {
          const drops = rollDrops(weights, 1)
          if (drops.length > 0) {
            for (const d of drops) await addItem(ctx, p.uid, d.id, 1)
            msg.push(`🎁 额外获得：${formatDropList(mergeDrops(drops))}`)
          }
        }
        return msg.join('\n')
      }

      if (chosen.kind === 'drop') {
        const count = 1 + Math.floor(Math.random() * 2)
        const drops = rollDrops(weights, count)
        if (drops.length > 0) {
          for (const d of drops) await addItem(ctx, p.uid, d.id, 1)
          msg.push(`🌀 秘境深处发现：${formatDropList(mergeDrops(drops))}`)
        } else {
          msg.push('🌀 秘境探索，但一无所获')
        }
        return msg.join('\n')
      }

      // hurt
      const ratio = 0.15
      p.hp = Math.max(0, p.hp - Math.floor(p.maxhp * ratio))
      await ctx.database.set(TABLE.player, { uid: p.uid }, floorRow(TABLE.player, { hp: p.hp }))
      return `🌀 触发陷阱，损失 ${Math.floor(p.maxhp * ratio)} 气血`
    })
}
