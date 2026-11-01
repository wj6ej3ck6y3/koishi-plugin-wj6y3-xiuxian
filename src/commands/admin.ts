import { Context } from 'koishi'
import { TABLE } from '../models'
import { addStone, formatPct, } from '../utils'

export function registerAdminCommands(ctx: Context) {
  ctx.command('神秘力量 <amount:number>', '赠送灵石')
    .action(async ({ session }, amount) => {
      if (!amount) return '请输入数量'
      const target = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
      if (target) {
        const rows = await ctx.database.get(TABLE.player, { userId: target })
        if (!rows[0]) return '目标不存在'
        await addStone(ctx, rows[0].uid, amount)
        return `💎 已向 ${rows[0].userName} 发放 ${amount} 灵石`
      }
      const all = await ctx.database.get(TABLE.player, {})
      for (const p of all) await addStone(ctx, p.uid, amount)
      return `💎 已向全服 ${all.length} 人各发放 ${amount} 灵石`
    })

  ctx.command('重置状态', '重置气血真元')
    .action(async ({ session }) => {
      const target = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
      if (target) {
        const p = await ctx.database.get(TABLE.player, { userId: target })
        if (!p[0]) return '目标不存在'
        await ctx.database.set(TABLE.player, { userId: target }, { hp: p[0].maxhp, mp: p[0].maxmp })
        return `✅ 已重置 ${p[0].userName} 状态\n🩸 气血：${p[0].maxhp}/${p[0].maxhp}（${formatPct(p[0].maxhp, p[0].maxhp)}%）  💧 真元：${p[0].maxmp}/${p[0].maxmp}（${formatPct(p[0].maxmp, p[0].maxmp)}%）`
      }
      const all = await ctx.database.get(TABLE.player, {})
      for (const p of all) await ctx.database.set(TABLE.player, { userId: p.userId }, { hp: p.maxhp, mp: p.maxmp })
      return `✅ 已重置全服 ${all.length} 人状态（气血/真元已回满）`
    })
}