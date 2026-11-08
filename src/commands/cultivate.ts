import { Context } from 'koishi'
import { data, getLevel } from '../data'
import { TABLE } from '../models'

import {
  requirePlayer, getBuff, refreshPlayerStats,
  checkBreakthrough, removeItem, costStone,
  computeCultivateSpeed,
  computeOneShotBreakthroughBonus,
  getQiFlagBonus,
  formatRemainTime,
  formatPct,
} from '../utils'

export function registerCultivateCommands(ctx: Context) {
  // ---------- 闭关 ----------
  ctx.command('闭关', '进入闭关状态')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const rows = await ctx.database.get(TABLE.cd, { userId: p.userId })
      if (rows[0] && rows[0].type === 1) return '你已在闭关中'
      if (rows[0] && rows[0].type === 2) return '你正在进行悬赏令，无法闭关'
      if (rows[0]) await ctx.database.remove(TABLE.cd, { userId: p.userId })
      await ctx.database.create(TABLE.cd, {
        userId: p.userId, type: 1, createTime: new Date(), scheduledTime: 0,
      })
      return '🧘 你已进入闭关状态，发送「出关」结算修为。'
    })

  // ---------- 出关（回复 + 上限） ----------
  ctx.command('出关', '结束闭关结算修为')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const rows = await ctx.database.get(TABLE.cd, { userId: p.userId })
      if (!rows[0] || rows[0].type !== 1) return '你不在闭关状态'
      const minutes = Math.floor((Date.now() - +new Date(rows[0].createTime)) / 60000)

      const buff = await getBuff(ctx, p.userId)
      const spotBonus = 1 + (buff.blessedSpot || 0) * 0.05
      const cultSpeed = await computeCultivateSpeed(ctx, p.userId)
      const base = ((ctx as any).config?.closeExpPerMinute ?? 10)
      const lv = getLevel(p.level)!

      const qiBonus = await getQiFlagBonus(ctx, p.userId)
      const rawGain = Math.floor(minutes * base * spotBonus * (1 + cultSpeed) * qiBonus.cultivateMul)
      const maxGain = Math.floor(lv.expToNext * 1.5)
      const gain = Math.min(rawGain, maxGain)
      const capped = rawGain > maxGain

      const healPct = Math.min(1, minutes * 0.01)
      const hpHeal = Math.floor(p.maxhp * healPct)
      const mpHeal = Math.floor(p.maxmp * healPct)

      p.exp += gain
      p.hp = Math.min(p.maxhp, p.hp + hpHeal)
      p.mp = Math.min(p.maxmp, p.mp + mpHeal)
      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        exp: p.exp, hp: p.hp, mp: p.mp,
      })
      await ctx.database.remove(TABLE.cd, { userId: p.userId })

      const notes: string[] = []
      if (cultSpeed > 0) notes.push(`功法 +${(cultSpeed * 100).toFixed(1)}%`)
      if (qiBonus.cultivateMul > 1) notes.push(`聚灵旗 ×${qiBonus.cultivateMul.toFixed(2)}`)
      const speedNote = notes.length ? `（${notes.join(' / ')}）` : ''
      const capNote = capped ? `\n⚠️ 本次修为已达闭关上限 ${maxGain}（1.5×突破需求）` : ''

      return [
        `🎉 出关！闭关 ${minutes} 分钟，修为 +${gain}${speedNote}`,
        `🩸 当前气血：${Math.floor(p.hp)}/${p.maxhp}（${formatPct(p.hp, p.maxhp)}%）`,
        `💧 当前真元：${Math.floor(p.mp)}/${p.maxmp}（${formatPct(p.mp, p.maxmp)}%）`,
        `📈 当前修为：${Math.floor(p.exp)}/${lv.expToNext}${capNote}`,
      ].join('\n')
    })

  // ---------- 灵石修炼 ----------
  ctx.command('灵石修炼 <count:number>', '用灵石直接换修为').alias('灵石修仙')
    .action(async ({ session }, count) => {
      if (!count || count <= 0) return '请输入大于 0 的灵石数量'
      // 向下取整到 10 的倍数
      const actualSpend = Math.floor(count / 10) * 10
      if (actualSpend < 10) return '至少需要 10 灵石才能修炼'
      const p = await requirePlayer(ctx, session)
      if (!(await costStone(ctx, p.uid, actualSpend))) return '灵石不足'
      const gain = Math.floor(actualSpend / 10)
      p.exp += gain
      await ctx.database.set(TABLE.player, { userId: p.userId }, { exp: p.exp })
      return `💠 消耗 ${actualSpend} 灵石，获得修为 +${gain}。`
    })

  // ---------- 突破信息查询 ----------
  ctx.command('突破', '查看突破信息').alias('突破信息')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const info = checkBreakthrough(p)
      if (!info.nextLevelId) return info.message
      const oneShot = await computeOneShotBreakthroughBonus(ctx, p.userId, p.level)
      const finalRate = Math.min(100, info.rate + oneShot.bonus)
      const lines = [
        `当前境界：${info.currentName}`,
        `下一境界：${getLevel(info.nextLevelId)?.name}`,
        `突破概率：${finalRate}% ${info.big ? ' 大境界突破' : ''}`,
      ]
      lines.push(`修为：${Math.floor(p.exp)} / ${info.expRequired}`)
      // 推荐丹药（仅提示）
      if (info.requirePill.length) {
        const names = info.requirePill.map(id => (data.pills[id] ?? data.craftPills[id])?.name ?? id)
        lines.push(`推荐丹药：${names.join('、')}（服用可提升突破率）`)
      }
      // 背包可用突破丹
      const back = await ctx.database.get(TABLE.back, { userId: p.userId })
      const usable: string[] = []
      for (const it of back) {
        const pill = data.pills[String(it.goodsId)]
        if (!pill?.modifiers) continue
        const hasBT = pill.modifiers.some(m => m.stat === 'breakthroughBigRate' || m.stat === 'breakthroughRate')
        if (hasBT) usable.push(`${pill.name}×${it.goodsNum}`)
      }
      if (usable.length) lines.push(`持有突破丹：${usable.join('、')}（发送「使用 丹药名」服用）`)

      // 渡厄丹提示
      const hasDue = back.find(it => it.goodsId === 1999 && it.goodsNum > 0)
      if (hasDue) lines.push(`💊 持有渡厄丹 ×${hasDue.goodsNum}，可用「渡厄突破」避免修为跌落`)
      const cdMinutes = Math.max(0, (ctx as any).config?.breakthroughCooldownMinutes ?? 60)
      const cdMs = cdMinutes * 60_000
      if (cdMs > 0 && p.levelUpCd) {
        const elapsed = Date.now() - +new Date(p.levelUpCd)
        if (elapsed < cdMs) {
          lines.push(`⏳ 冷却中：还需 ${formatRemainTime(cdMs - elapsed)}`)
          return lines.join('\n')
        }
      }
      lines.push('发送「直接突破」或「渡厄突破」开始。')
      return lines.join('\n')
    })

  // ---------- 直接突破 ----------
  ctx.command('直接突破', '不使用渡厄丹突破')
    .action(async ({ session }) => doBreakthrough(ctx, session, false))

  // ---------- 渡厄突破 ----------
  ctx.command('渡厄突破', '消耗渡厄丹突破（失败不扣修为）')
    .action(async ({ session }) => doBreakthrough(ctx, session, true))

  // ---------- 抑制黑暗动乱 ----------
  ctx.command('抑制黑暗动乱', '取整修为')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const before = p.exp
      p.exp = Math.floor(p.exp)
      await ctx.database.set(TABLE.player, { userId: p.userId }, { exp: p.exp })
      return `修为已整理：${before.toFixed(2)} → ${p.exp}`
    })
}

async function doBreakthrough(ctx: Context, session: any, useDue: boolean) {
  const p = await requirePlayer(ctx, session)
  const info = checkBreakthrough(p)
  if (!info.nextLevelId) return info.message
  if (!info.canBreak) return info.message

  // 突破 CD
  const cdMinutes = Math.max(0, (ctx as any).config?.breakthroughCooldownMinutes ?? 60)
  const cdMs = cdMinutes * 60_000
  if (cdMs > 0 && p.levelUpCd && Date.now() - +new Date(p.levelUpCd) < cdMs) {
    const remainMs = cdMs - (Date.now() - +new Date(p.levelUpCd))
    return `⏳ 突破冷却中，还需 ${formatRemainTime(remainMs)}`
  }

  // 渡厄丹保护（可选）
  let dueProtect = false
  if (useDue) {
    const ok = await removeItem(ctx, p.userId, 1999, 1)
    if (!ok) return '背包中没有渡厄丹，请改用「直接突破」'
    dueProtect = true
  }

  // ✅ 单次限定突破丹加成（从独立表读，不写 levelUpRate）
  const oneShot = await computeOneShotBreakthroughBonus(ctx, p.userId, p.level)
  const finalRate = Math.min(100, info.rate + oneShot.bonus)

  const success = Math.random() * 100 < finalRate
  const cdStamp = new Date()

  const oneShotNote = oneShot.bonus > 0 ? `（单次丹 +${oneShot.bonus}%）` : ''
  const dueNote = dueProtect ? '【渡厄丹保护】' : ''

  if (success) {
    p.level = info.nextLevelId
    p.levelUpRate = 0     // 通用临时加乘清零
    await ctx.database.set(TABLE.player, { userId: p.userId }, {
      level: p.level, exp: p.exp, levelUpRate: 0, levelUpCd: cdStamp,
    })
    await refreshPlayerStats(ctx, p)
    return `✨ 突破成功！晋升「${getLevel(p.level)?.name}」！${oneShotNote}${dueNote}`
  }

  // ✅ 新代码
  const maxGain = Math.max(1, Math.floor((ctx as any).config.breakthroughFailRateGain))
  const rateGain = 1 + Math.floor(Math.random() * maxGain)   // 1 ~ maxGain（含两端）
  const loss = dueProtect ? 0 : Math.floor(info.expRequired * ((ctx as any).config?.breakthroughFailLossRatio ?? 0.3))
  p.exp = Math.max(0, p.exp - loss)
  p.levelUpRate = (p.levelUpRate || 0) + rateGain

  // ✅ 失败后重新计算总突破率（基础 + 新累计 + 单次丹）
  const newInfo = checkBreakthrough(p)
  const newTotalRate = Math.min(100, newInfo.rate + oneShot.bonus)

  return `💥 突破失败！损失修为 ${loss}，突破率 +${rateGain}%（总突破率 ${newTotalRate}%）${oneShotNote}${dueNote}`
}