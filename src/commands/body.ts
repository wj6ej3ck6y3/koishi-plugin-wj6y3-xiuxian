import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import { requirePlayer, costStone, recomputeAndSaveStats, formatModifiers, formatCompact } from '../utils'

export function registerBodyCommands(ctx: Context) {
  ctx.command('炼体帮助', '炼体说明').action(() => [
    '🗿 炼体，查看当前炼体境界',
    '炼体突破，冲击下一层，消耗灵石，有概率成功',
  ].join('\n'))

  ctx.command('炼体', '查看炼体信息').alias('查看炼体').alias('炼体信息')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const cur = p.exercisesLevel ? data.bodyLevels[p.exercisesLevel] : null
      const nextId = String(Number(p.exercisesLevel || 0) + 1).padStart(5, '0')
      const next = data.bodyLevels[nextId]

      const lines: string[] = []

      if (cur) {
        lines.push(`当前炼体：${cur.name}`)
        if (cur.modifiers && cur.modifiers.length > 0) {
          lines.push(`  当前加成：${formatModifiers(cur.modifiers, 2)}`)
        }
      } else {
        lines.push('尚未开始炼体')
      }
      lines.push('')

      if (next) {
        const costPart = next.costStone != null ? `消耗 ${formatCompact(next.costStone)} 灵石，` : ''
        const probPart = next.probability != null ? `成功率 ${next.probability}%` : ''
        lines.push(`下一层：${next.name}（${costPart}${probPart}）`)
        if (next.modifiers && next.modifiers.length > 0) {
          lines.push(`  达成后加成：${formatModifiers(next.modifiers, 2)}`)
        }
      } else {
        lines.push('已至炼体巅峰')
      }

      return lines.join('\n')
    })

  ctx.command('炼体突破', '冲击下一层')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const curId = p.exercisesLevel || '0'
      const nextId = String(Number(curId) + 1).padStart(5, '0')
      const next = data.bodyLevels[nextId]
      if (!next || next.costStone == null) return '已至炼体巅峰'
      if (!(await costStone(ctx, p.uid, next.costStone))) return `需 ${formatCompact(next.costStone)} 灵石`
      const success = Math.random() * 100 < (next.probability ?? 0)
      if (!success) return `💥 炼体失败，损失 ${formatCompact(next.costStone)} 灵石`
      await ctx.database.set(TABLE.player, { uid: p.uid }, { exercisesLevel: nextId })
      // 先更新内存中的炼体境界，再按新境界重算属性与战力
      p.exercisesLevel = nextId
      await recomputeAndSaveStats(ctx, p)
      return `🗿 炼体成功！晋升「${next.name}」（战力 ${formatCompact(p.power)}）`
    })
}
