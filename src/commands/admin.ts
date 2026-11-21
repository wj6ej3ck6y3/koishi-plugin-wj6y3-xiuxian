import { Context } from 'koishi'
import { TABLE } from '../models'
import { addStone, formatPct, getPlayer, resolveAtUid, formatCompact } from '../utils'

export function registerAdminCommands(ctx: Context) {
  ctx.command('神秘力量 <amount:number>', '赠送灵石', { authority: 5 })
    .action(async ({ session }, amount) => {
      if (!amount) return '请输入数量'

      // ✅ 显式区分「有 @」和「没 @」两种情况：
      //   - 没 @ 人 → 全服发放
      //   - 有 @ 人但 resolveAtUid 失败（对方在本平台无账号）→ 报错，绝不走全服分支
      const atElement = session?.elements?.find(e => e.type === 'at')

      if (atElement) {
        const targetUid = await resolveAtUid(ctx, session)
        if (targetUid === null) {
          return '⚠️ 目标用户未在本平台绑定账号，无法定向发放（如需全服发放请不要 @ 任何人）'
        }
        const target = await getPlayer(ctx, targetUid)
        if (!target) return '目标尚未踏入仙途'
        await addStone(ctx, target.uid, amount)
        return `💎 已向 ${target.userName} 发放 ${formatCompact(amount)} 灵石`
      }

      // 没有 @ → 全服发放
      const all = await ctx.database.get(TABLE.player, {})
      if (!all.length) return '当前没有任何玩家'
      for (const p of all) await addStone(ctx, p.uid, amount)
      return `💎 已向全服 ${all.length} 人各发放 ${formatCompact(amount)} 灵石`
    })

  ctx.command('重置状态', '重置气血真元', { authority: 5 })
    .action(async ({ session }) => {
      // ✅ 与「神秘力量」一致：区分「有 @」和「没 @」
      const atElement = session?.elements?.find(e => e.type === 'at')

      if (atElement) {
        const targetUid = await resolveAtUid(ctx, session)
        if (targetUid === null) {
          return '⚠️ 目标用户未在本平台绑定账号，无法定向重置（如需全服重置请不要 @ 任何人）'
        }
        const target = await getPlayer(ctx, targetUid)
        if (!target) return '目标尚未踏入仙途'
        await ctx.database.set(TABLE.player, { uid: targetUid }, {
          hp: target.maxhp, mp: target.maxmp,
        })
        return [
          `✅ 已重置 ${target.userName} 状态`,
          `🩸 气血：${formatCompact(target.maxhp)}/${formatCompact(target.maxhp)}（${formatPct(target.maxhp, target.maxhp)}%）  ` +
          `💧 真元：${formatCompact(target.maxmp)}/${formatCompact(target.maxmp)}（${formatPct(target.maxmp, target.maxmp)}%）`,
        ].join('\n')
      }

      // 没有 @ → 全服重置
      const all = await ctx.database.get(TABLE.player, {})
      if (!all.length) return '当前没有任何玩家'
      for (const p of all) {
        await ctx.database.set(TABLE.player, { uid: p.uid }, { hp: p.maxhp, mp: p.maxmp })
      }
      return `✅ 已重置全服 ${all.length} 人状态（气血/真元已回满）`
    })
}
