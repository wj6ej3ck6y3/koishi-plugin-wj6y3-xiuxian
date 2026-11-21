import { Context, Session } from 'koishi'
import { Config } from '../config'
import { data, getLevel } from '../data'
import { TABLE } from '../models'

import {
  requirePlayer, getOrCreateBuff, recomputeAndSaveStats,
  checkBreakthrough, removeItem, costStone,
  computeCultivateSpeed,
  computeOneShotBreakthroughBonus,
  getOneShotBreakthroughValue,
  getQiFlagBonus,
  getBusyKind,
  claimByRemove,
  addPlayerExp,
  floorRow,
  formatRemainTime,
  formatPct,
  DUE_PILL_ID,
} from '../utils'

export function registerCultivateCommands(ctx: Context, config: Config) {
  // ---------- 闭关 ----------
  ctx.command('闭关', '进入闭关状态')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const busy = await getBusyKind(ctx, p.uid)
      if (busy === 'closed') return '你已在闭关中'
      if (busy === 'bounty') return '你正在进行悬赏令，无法闭关'
      await ctx.database.remove(TABLE.cd, { uid: p.uid })
      await ctx.database.create(TABLE.cd, {
        uid: p.uid, type: 1, createTime: new Date(), scheduledTime: 0,
      })
      return '🧘 你已进入闭关状态，发送「出关」结算修为。'
    })

  // ---------- 出关 ----------
  ctx.command('出关', '结束闭关结算修为')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const rows = await ctx.database.get(TABLE.cd, { uid: p.uid })
      if (!rows[0] || rows[0].type !== 1) return '你不在闭关状态'
      // 先删除闭关记录作为占用：同一次闭关只能结算一次
      if (!(await claimByRemove(ctx, TABLE.cd, { uid: p.uid, type: 1 }))) return '你不在闭关状态'
      const minutes = Math.floor((Date.now() - +new Date(rows[0].createTime)) / 60000)

      const buff = await getOrCreateBuff(ctx, p.uid)
      const spotBonus = 1 + (buff.blessedSpot || 0) * 0.05
      const cultSpeed = await computeCultivateSpeed(ctx, p.uid)
      const base = config.closeExpPerMinute
      const lv = getLevel(p.level)!

      const qiBonus = await getQiFlagBonus(ctx, p.uid)
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
      await addPlayerExp(ctx, p.uid, gain)
      await ctx.database.set(TABLE.player, { uid: p.uid }, floorRow(TABLE.player, { hp: p.hp, mp: p.mp }))

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
      const actualSpend = Math.floor(count / 10) * 10
      if (actualSpend < 10) return '至少需要 10 灵石才能修炼'
      const p = await requirePlayer(ctx, session)
      if (!(await costStone(ctx, p.uid, actualSpend))) return '灵石不足'
      const gain = Math.floor(actualSpend / 10)
      await addPlayerExp(ctx, p.uid, gain)
      return `💠 消耗 ${actualSpend} 灵石，获得修为 +${gain}。`
    })

  // ---------- 突破信息查询 ----------
  ctx.command('突破', '查看突破信息').alias('突破信息')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const info = checkBreakthrough(p)
      if (!info.nextLevelId) return info.message
      const oneShot = await computeOneShotBreakthroughBonus(ctx, p.uid, p.level)
      const finalRate = Math.min(100, info.rate + oneShot.bonus)
      const lines = [
        `当前境界：${info.currentName}`,
        `下一境界：${getLevel(info.nextLevelId)?.name}`,
        `突破概率：${finalRate}% ${info.big ? ' 大境界突破' : ''}`,
      ]
      lines.push(`修为：${Math.floor(p.exp)} / ${info.expRequired}`)
      if (info.requirePill.length) {
        const names = info.requirePill.map(id => (data.pills[id] ?? data.craftPills[id])?.name ?? id)
        lines.push(`推荐丹药：${names.join('、')}（服用可提升突破率）`)
      }

      // 持有且本次突破可服用的突破丹：普通突破丹（不限次数）持有即列出；
      // 大突破丹只列「丹药境界 = 当前境界（作用于本次突破）且尚未服用」的
      const back = await ctx.database.get(TABLE.back, { uid: p.uid })
      const usedRows = await ctx.database.get(TABLE.pillUsed, { uid: p.uid })
      const usedIds = new Set(usedRows.map(r => r.pillId))
      const curLv = parseInt(p.level, 10)
      const usable: string[] = []
      for (const it of back) {
        if ((it.goodsNum ?? 0) <= 0) continue
        const id = String(it.goodsId)
        const pill = data.pills[id] ?? data.craftPills[id]
        if (!pill?.modifiers) continue
        const mods = pill.modifiers as Array<{ stat: string }>
        if (mods.some(m => m.stat === 'breakthroughBigRate')) {
          if (Number(pill.realm) !== curLv || usedIds.has(it.goodsId)) continue
          usable.push(`${pill.name}×${it.goodsNum}（大境界突破率 +${getOneShotBreakthroughValue(pill)}%）`)
        } else if (mods.some(m => m.stat === 'breakthroughRate')) {
          usable.push(`${pill.name}×${it.goodsNum}`)
        }
      }
      if (usable.length) lines.push(`可服用突破丹：${usable.join('、')}（发送「使用 丹药名」服用）`)

      const hasDue = back.find(it => it.goodsId === DUE_PILL_ID && it.goodsNum > 0)
      if (hasDue) lines.push(`💊 持有渡厄丹 ×${hasDue.goodsNum}，可用「渡厄突破」避免修为跌落`)
      const cdMinutes = Math.max(0, config.breakthroughCooldownMinutes)
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
    .action(async ({ session }) => doBreakthrough(ctx, config, session, false))

  // ---------- 渡厄突破 ----------
  ctx.command('渡厄突破', '消耗渡厄丹突破（失败不扣修为）')
    .action(async ({ session }) => doBreakthrough(ctx, config, session, true))

  // ---------- 抑制黑暗动乱 ----------
  ctx.command('抑制黑暗动乱', '取整修为')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const before = p.exp
      p.exp = Math.floor(p.exp)
      await ctx.database.set(TABLE.player, { uid: p.uid }, { exp: p.exp })
      return `修为已整理：${before.toFixed(2)} → ${p.exp}`
    })
}

async function doBreakthrough(ctx: Context, config: Config, session: Session | undefined, useDue: boolean) {
  const p = await requirePlayer(ctx, session)
  const info = checkBreakthrough(p)
  if (!info.nextLevelId) return info.message
  if (!info.canBreak) return info.message

  // 突破 CD
  const cdMinutes = Math.max(0, config.breakthroughCooldownMinutes)
  const cdMs = cdMinutes * 60_000
  if (cdMs > 0 && p.levelUpCd && Date.now() - +new Date(p.levelUpCd) < cdMs) {
    const remainMs = cdMs - (Date.now() - +new Date(p.levelUpCd))
    return `⏳ 突破冷却中，还需 ${formatRemainTime(remainMs)}`
  }

  // 渡厄丹保护（可选）
  let dueProtect = false
  if (useDue) {
    const ok = await removeItem(ctx, p.uid, DUE_PILL_ID, 1)
    if (!ok) return '背包中没有渡厄丹，请改用「直接突破」'
    dueProtect = true
  }

  // 单次限定突破丹加成（从独立表读，不写 levelUpRate）
  const oneShot = await computeOneShotBreakthroughBonus(ctx, p.uid, p.level)
  const finalRate = Math.min(100, info.rate + oneShot.bonus)

  const success = Math.random() * 100 < finalRate
  const cdStamp = new Date()

  const oneShotNote = oneShot.bonus > 0 ? `（单次丹 +${oneShot.bonus}%）` : ''
  const dueNote = dueProtect ? '【渡厄丹保护】' : ''

  if (success) {
    p.level = info.nextLevelId
    p.levelUpRate = 0
    await ctx.database.set(TABLE.player, { uid: p.uid }, {
      level: p.level, levelUpRate: 0, levelUpCd: cdStamp,
    })
    await recomputeAndSaveStats(ctx, p)
    return `✨ 突破成功！晋升「${getLevel(p.level)?.name}」！${oneShotNote}${dueNote}`
  }

  // 失败：扣修为 + 加累计概率
  const maxGain = Math.max(1, Math.floor(config.breakthroughFailRateGain))
  const rateGain = 1 + Math.floor(Math.random() * maxGain)
  const rawLoss = dueProtect ? 0 : Math.floor(info.expRequired * config.breakthroughFailLossRatio)
  const loss = Math.min(rawLoss, Math.max(0, Math.floor(p.exp)))
  p.exp = Math.max(0, p.exp - loss)
  p.levelUpRate = (p.levelUpRate || 0) + rateGain

  // ✅ B3：失败也写入 levelUpCd，避免零间隔反复刷突破
  await addPlayerExp(ctx, p.uid, -loss)
  await ctx.database.set(TABLE.player, { uid: p.uid }, {
    levelUpRate: p.levelUpRate, levelUpCd: cdStamp,
  })

  // 失败后重新计算总突破率（基础 + 新累计 + 单次丹）
  const newInfo = checkBreakthrough(p)
  const newTotalRate = Math.min(100, newInfo.rate + oneShot.bonus)

  return `💥 突破失败！损失修为 ${loss}，突破率 +${rateGain}%（总突破率 ${newTotalRate}%）${oneShotNote}${dueNote}`
}
