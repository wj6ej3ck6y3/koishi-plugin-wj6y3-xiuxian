import { Context } from 'koishi'
import { TABLE } from '../models'
import { requirePlayer, addStone, addItem, rollSingleDrop, DropEntry, formatRemainTime } from '../utils'

// 秘境结果四档（掉落档不再是固定生骨丹）
const OUTCOMES = [
  { w: 40, kind: 'stone' as const },
  { w: 35, kind: 'exp' as const },
  { w: 15, kind: 'drop' as const },
  { w: 10, kind: 'hurt' as const },
]

/** 复用悬赏令的类别权重 */
function getCategoryWeights(ctx: Context): Record<string, number> {
  const w = (ctx as any).config?.bountyDropCategoryWeights
  if (w && typeof w === 'object' && Object.keys(w).length > 0) return w
  return {
    pill: 20, craftPill: 8, herb: 25, weapon: 12, armor: 8,
    gongfa: 10, shentong: 10, fuxiu: 3, qiFlag: 2, furnace: 2,
  }
}

/** 从全局权重池抽 count 件 */
function rollDrops(ctx: Context, count: number): DropEntry[] {
  const weights = getCategoryWeights(ctx)
  const results: DropEntry[] = []
  for (let i = 0; i < count; i++) {
    const d = rollSingleDrop(weights)
    if (d) results.push(d)
  }
  return results
}

/** 掉落结果合并同名 + 格式化 */
function formatDrops(drops: DropEntry[]): string {
  const map = new Map<number, { name: string; num: number }>()
  for (const d of drops) {
    const cur = map.get(d.id)
    if (cur) cur.num += 1
    else map.set(d.id, { name: d.name, num: 1 })
  }
  return [...map.values()].map(x => `${x.name}×${x.num}`).join('、')
}

export function registerRiftCommands(ctx: Context) {
  ctx.command('秘境帮助', '说明').action(() =>[
      '🌀 探索秘境：每日 3 次、1 小时 CD，随机获得灵石 / 修为 / 物品，或受伤。',
    ].join('\n'))

  ctx.command('探索秘境', '秘境探索')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)

      // ✅ 互斥检查（只对闭关/悬赏，不影响反向）
      const cdRows = await ctx.database.get(TABLE.cd, { userId: p.userId })
      if (cdRows[0] && cdRows[0].type === 1) return '你正在闭关中，无法探索秘境'
      if (cdRows[0] && cdRows[0].type === 2) return '你正在进行悬赏令，无法探索秘境'

      // ✅ 秘境自身 CD / 每日次数
      const now = new Date()
      const dayKey = now.toDateString()
      const last = new Date(p.riftCd)
      if (last.toDateString() !== dayKey) {
        p.riftDailyCount = 0
      }
      if (p.riftDailyCount >= 3) return '今日探索次数已用尽'
      if (last && Date.now() - +last < 3600 * 1000 && last.toDateString() === dayKey) {
        const remainMs = 3600 * 1000 - (Date.now() - +last)
        return `冷却中，还需 ${formatRemainTime(remainMs)}`
      }

      // 更新 CD + 次数
      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        riftCd: now, riftDailyCount: p.riftDailyCount + 1,
      })

      // 抽取结果
      const total = OUTCOMES.reduce((s, o) => s + o.w, 0)
      let r = Math.random() * total
      let chosen = OUTCOMES[0]
      for (const o of OUTCOMES) { r -= o.w; if (r <= 0) { chosen = o; break } }

      const dropChance = (ctx as any).config?.riftDropChance ?? 40
      const msg: string[] = []

      if (chosen.kind === 'stone') {
        const a = 200 + Math.floor(Math.random() * 800)
        await addStone(ctx, p.uid, a)
        msg.push(`🌀 探索秘境，发现灵石 ×${a}`)
        if (Math.random() * 100 < dropChance) {
          const drops = rollDrops(ctx, 1)
          if (drops.length > 0) {
            for (const d of drops) await addItem(ctx, p.userId, d.id, 1)
            msg.push(`🎁 额外获得：${formatDrops(drops)}`)
          }
        }
        return msg.join('\n')
      }

      if (chosen.kind === 'exp') {
        const a = 100 + Math.floor(Math.random() * 500)
        p.exp += a
        await ctx.database.set(TABLE.player, { userId: p.userId }, { exp: p.exp })
        msg.push(`🌀 偶遇灵气漩涡，修为 +${a}`)
        if (Math.random() * 100 < dropChance) {
          const drops = rollDrops(ctx, 1)
          if (drops.length > 0) {
            for (const d of drops) await addItem(ctx, p.userId, d.id, 1)
            msg.push(`🎁 额外获得：${formatDrops(drops)}`)
          }
        }
        return msg.join('\n')
      }

      if (chosen.kind === 'drop') {
        // 掉落档：直接 1~2 件（原固定生骨丹 → 全局权重池）
        const count = 1 + Math.floor(Math.random() * 2)
        const drops = rollDrops(ctx, count)
        if (drops.length > 0) {
          for (const d of drops) await addItem(ctx, p.userId, d.id, 1)
          msg.push(`🌀 秘境深处发现：${formatDrops(drops)}`)
        } else {
          msg.push('🌀 秘境探索，但一无所获')
        }
        return msg.join('\n')
      }

      // hurt
      const ratio = 0.15
      p.hp = Math.max(0, p.hp - Math.floor(p.maxhp * ratio))
      await ctx.database.set(TABLE.player, { userId: p.userId }, { hp: p.hp })
      return `🌀 触发陷阱，损失 ${Math.floor(p.maxhp * ratio)} 气血`
    })
}