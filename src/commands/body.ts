import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import { requirePlayer, costStone, refreshPlayerStats,statLabel } from '../utils'
// 注意：utils 中已有 getBodyLevel re-export

export function registerBodyCommands(ctx: Context) {
  ctx.command('炼体帮助', '炼体说明').action(() => [
    '🗿 炼体      查看当前炼体境界',
    '炼体突破    冲击下一层（消耗灵石 + 概率成功）',
  ].join('\n'))

  ctx.command('炼体', '查看炼体信息').alias('查看炼体').alias('炼体信息')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const cur = p.exercisesLevel ? data.bodyLevels[p.exercisesLevel] : null
      const nextId = String(Number(p.exercisesLevel || 0) + 1).padStart(5, '0')
      const next = data.bodyLevels[nextId]

      const lines: string[] = []

      // ✅ 当前境界 + 当前加成
      if (cur) {
        lines.push(`当前炼体：${cur.name}`)
        if (cur.modifiers && cur.modifiers.length > 0) {
          lines.push(`  当前加成：${cur.modifiers.map(m => `${statLabel(m.stat)} +${(m.value * 100).toFixed(2)}%`).join('、')}`)
        }
      } else {
        lines.push('尚未开始炼体')
      }
      lines.push('')

      // ✅ 下一层：消耗 / 成功率 / 达成后的总加成
      if (next) {
        const costPart = next.costStone != null ? `消耗 ${next.costStone} 灵石，` : ''
        const probPart = next.probability != null ? `成功率 ${next.probability}%` : ''
        lines.push(`下一层：${next.name}（${costPart}${probPart}）`)
        if (next.modifiers && next.modifiers.length > 0) {
          lines.push(`  达成后加成：${next.modifiers.map(m => `${statLabel(m.stat)} +${(m.value * 100).toFixed(2)}%`).join('、')}`)
        }
      } else {
        lines.push('已至炼体巅峰')
      }

      return lines.join('\n')
    })

  ctx.command('炼体突破', '冲击下一层')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      let curId = p.exercisesLevel || '0'
      const nextId = String(Number(curId) + 1).padStart(5, '0')
      const next = data.bodyLevels[nextId]
      if (!next || next.costStone == null) return '已至炼体巅峰'
      if (!(await costStone(ctx, p.uid, next.costStone))) return `需 ${next.costStone} 灵石`
      const success = Math.random() * 100 < next.probability
      if (!success) return `💥 炼体失败，损失 ${next.costStone} 灵石`
      await ctx.database.set(TABLE.player, { userId: p.userId }, { exercisesLevel: nextId })
      await refreshPlayerStats(ctx, p)
      return `🗿 炼体成功！晋升「${next.name}」`
    })
}