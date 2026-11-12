import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import {
  requirePlayer, addItem, removeItem, getBuff, refreshPlayerStats,
  getLearnedSkills,
  isOneShotBreakthroughPill, isOneShotPillUsed,
  getOneShotBreakthroughValue,
  getQualityLabel,
  statLabel,
  ALL_ITEM_TABLES,
  findItemInBackpack,
  formatPct,
} from '../utils'


/** 辅修 effect → 中文名 */
const FUXIU_EFFECT_LABEL: Record<string, string> = {
  lifesteal: '吸血',
  stealQi: '夺灵',
  hpPct: '气血加成',
  longLife: '寿命',
  damageBoost: '伤害加成',
  stealth: '隐匿',
  gainBoost: '增益提升',
  poison: '中毒',
}

/** 把 modifiers 数组格式化为 "气血 +3%、攻击 +5%" */
function formatModifiers(mods: any[] | undefined, isFlat: boolean = false): string {
  if (!mods || mods.length === 0) return '无'
  return mods.map(m => {
    const isPct = (m.mode ?? 'pct') === 'pct'
    const val = isPct ? `${(m.value * 100).toFixed(isFlat ? 2 : 0)}%` : `${m.value}`
    return `${statLabel(m.stat)} +${val}`
  }).join('、')
}

/** 把神通的战斗效果格式化为多行字符串（供「我的神通」和「查看修仙界物品」共用） */
function formatShenTongEffect(st: any): string[] {
  if (!st) return []
  const lines: string[] = []
  const mpPart = `耗真元 ${(st.mpCost * 100).toFixed(0)}%`
  const ratePart = `命中 ${st.rate}%`

  // type 1：单次伤害
  if (st.type === 1) {
    const values = Array.isArray(st.atkValue) ? st.atkValue : [st.atkValue]
    const totalMul = values.reduce((s: number, v: number) => s + v, 0)
    const segPart = values.length > 1 ? `（${values.length} 段）` : ''
    const cdPart = st.turnCost && st.turnCost > 0 ? `冷却 ${st.turnCost} 回合` : '无冷却'
    lines.push(`  · 总伤害 ×${totalMul.toFixed(2)}${segPart}`)
    lines.push(`  · ${mpPart}｜${ratePart}｜${cdPart}`)
    return lines
  }

  // type 2：持续伤害
  if (st.type === 2) {
    const per = Number(st.atkValue)
    const total = per * (st.turnCost ?? 1)
    lines.push(`  · 每回合伤害 ×${per.toFixed(2)}，持续 ${st.turnCost} 回合`)
    lines.push(`  · ${mpPart}｜${ratePart}`)
    return lines
  }

  // type 3：增减益
  if (st.type === 3) {
    const buffVal = ((st.buffValue ?? 0) * 100).toFixed(0)
    let buffDesc = ''
    if (st.buffType === 1) buffDesc = `攻击提升 ${buffVal}%`
    else if (st.buffType === 2) buffDesc = `减伤提升 ${buffVal}%`
    else buffDesc = `增益 ${buffVal}%`
    lines.push(`  · ${buffDesc}｜持续 ${st.turnCost} 回合`)
    lines.push(`  · ${mpPart}｜${ratePart}`)
    return lines
  }

  // type 4：单次伤害 + 吸血
  if (st.type === 4) {
    const values = Array.isArray(st.atkValue) ? st.atkValue : [st.atkValue]
    const totalMul = values.reduce((s: number, v: number) => s + v, 0)
    const segPart = values.length > 1 ? `（${values.length} 段）` : ''
    const lsPart = st.lifestealPct ? `吸血 ${(st.lifestealPct * 100).toFixed(0)}%` : ''
    const cdPart = st.turnCost && st.turnCost > 0 ? `冷却 ${st.turnCost} 回合` : '无冷却'
    lines.push(`  · 总伤害 ×${totalMul.toFixed(2)}${segPart}${lsPart ? '｜' + lsPart : ''}`)
    lines.push(`  · ${mpPart}｜${ratePart}｜${cdPart}`)
    return lines
  }

  lines.push(`  · 类型 ${st.type}（未知机制）`)
  return lines
}

export function findItemByName(name: string): [string, any] | null {
  const all = ALL_ITEM_TABLES()
  for (const [id, v] of Object.entries(all)) {
    if ((v as any).name === name) return [id, v]
  }
  return null
}

// ===== 装备写入的统一入口 =====
/**
 * 只更新 buff 表里指定的单个槽位字段，绝不触及背包（back 表）。
 * 完整字段写回：即使 adapter 是"整行替换"也不会丢其它字段。
 */
async function equipSlot(
  ctx: Context,
  uid: number,
  slot: 'faqiBuff' | 'armorBuff' | 'furnaceBuff' | 'qiFlagBuff',
  goodsId: number,
) {
  const buff = await getBuff(ctx, uid)
  if ((buff as any)[slot] === goodsId) return

  await ctx.database.upsert(TABLE.buff, [{
    uid,
    mainBuff: buff.mainBuff ?? 0,
    secBuff: buff.secBuff ?? 0,
    subBuff: buff.subBuff ?? 0,
    faqiBuff: buff.faqiBuff ?? 0,
    armorBuff: buff.armorBuff ?? 0,
    atkBuff: buff.atkBuff ?? 0,
    blessedSpot: buff.blessedSpot ?? 0,
    furnaceBuff: buff.furnaceBuff ?? 0,
    qiFlagBuff: buff.qiFlagBuff ?? 0,
    [slot]: goodsId,
  }], ['uid'])
}

export function registerBackpackCommands(ctx: Context) {
  // ===== 我的背包 =====
  ctx.command('我的背包', '查看背包')
    .alias('我的物品').alias('修仙物品').alias('查看背包')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const items = await ctx.database.get(TABLE.back, { uid: p.uid })
      const visible = items.filter(it => (it.goodsNum ?? 0) > 0)
      if (!visible.length) return '背包空空如也'

      const buff = await getBuff(ctx, p.uid)
      const equippedIds = new Set(
        [buff.faqiBuff, buff.armorBuff, buff.furnaceBuff, buff.qiFlagBuff]
          .filter(id => !!id),
      )

      const all = ALL_ITEM_TABLES()
      const lines = visible.map(it => {
        const meta = all[it.goodsId]
        const name = meta?.name ?? `未知#${it.goodsId}`
        const mark = equippedIds.has(it.goodsId) ? ' [已装备]' : ''
        const quality = getQualityLabel(it.goodsId)
        const qualityStr = quality ? `[${quality}] ` : ''
        const tag = (meta as any)?.tag
        const tagStr = tag ? `【${tag}】` : ''
        return `· ${qualityStr}${tagStr}${name} ×${it.goodsNum}${mark}`
      })
      return `🎒 ${p.userName} 的背包（${visible.length} 类）\n` + lines.join('\n')
    })

  // ===== 卸下 =====
  ctx.command('卸下 <slot:string>', '卸下装备')
    .action(async ({ session }, slot) => {
      if (!slot) return '请输入槽位：武器 / 防具 / 炼丹炉 / 聚灵旗'
      const p = await requirePlayer(ctx, session)
      const buff = await getBuff(ctx, p.uid)

      const map: Record<string, { key: 'faqiBuff' | 'armorBuff' | 'furnaceBuff' | 'qiFlagBuff'; label: string }> = {
        '武器': { key: 'faqiBuff', label: '武器' },
        '防具': { key: 'armorBuff', label: '防具' },
        '炼丹炉': { key: 'furnaceBuff', label: '炼丹炉' },
        '炉': { key: 'furnaceBuff', label: '炼丹炉' },
        '聚灵旗': { key: 'qiFlagBuff', label: '聚灵旗' },
        '旗': { key: 'qiFlagBuff', label: '聚灵旗' },
      }
      const target = map[slot]
      if (!target) return '槽位无效：可用 武器 / 防具 / 炼丹炉 / 聚灵旗'

      const curId = buff[target.key]
      if (!curId) return `你当前没有装备${target.label}`

      await ctx.database.set(TABLE.buff, { uid: p.uid }, { [target.key]: 0 } as any)
      await refreshPlayerStats(ctx, p)

      const all = ALL_ITEM_TABLES()
      const name = all[curId]?.name ?? `#${curId}`
      return `📤 已卸下${target.label}「${name}」（物品仍在背包中）`
    })

  // ===== 使用 =====
  ctx.command('使用 <name:string> [count:number]', '使用 / 学习物品')
    .action(async ({ session }, name, count = 1) => {
      if (!name) return '请输入要使用的物品名称'
      const p = await requirePlayer(ctx, session)
      const found = await findItemInBackpack(ctx, p.uid, name)
      if (!found) return `背包中未找到「${name}」`
      const [idStr, meta] = found
      const goodsId = parseInt(idStr, 10)
      const rows = await ctx.database.get(TABLE.back, { uid: p.uid, goodsId })
      if (!rows[0] || rows[0].goodsNum < count) return `物品数量不足`
      const backRow = rows[0]

      // ===== 学习制：功法 / 辅修 / 神通 =====
      if (meta._type === 'gongfa' || meta._type === 'fuxiu' || meta._type === 'shentong') {
        const typeName = meta._type === 'gongfa' ? '功法'
          : meta._type === 'fuxiu' ? '辅修功法' : '神通'
        const learned = await getLearnedSkills(ctx, p.uid)
        const learnedArr = meta._type === 'gongfa' ? learned.gongfa
          : meta._type === 'fuxiu' ? learned.fuxiu : learned.shentong
        if (learnedArr.includes(goodsId)) return `已学会「${meta.name}」，无需重复学习`

        await ctx.database.upsert(TABLE.skill, [{ uid: p.uid, skillId: goodsId }], ['uid', 'skillId'])
        await removeItem(ctx, p.uid, goodsId, count)
        await refreshPlayerStats(ctx, p)
        return `📖 成功学习${typeName}「${meta.name}」！`
      }

      // ===== 丹药 =====
      if (meta._type === 'pill') {
        const isDue = meta.modifiers?.some((m: any) => m.stat === 'breakthroughLoss')
        if (isDue) return '「渡厄丹」需在「渡厄突破」时自动使用，请直接发送「渡厄突破」'

        if (isOneShotBreakthroughPill(meta)) {
          if (await isOneShotPillUsed(ctx, p.uid, goodsId)) {
            return `「${meta.name}」整局限服一次，你已服用过`
          }
          if (meta.realm && parseInt(p.level, 10) < Number(meta.realm)) {
            return `境界不足，需达到「${data.levels[String(meta.realm)]?.name}」才可服用「${meta.name}」`
          }

          // ✅ 目标境界与提示文本，以丹药设定的 realm + 1 为准
          const targetLevelId = meta.realm
            ? String(Number(meta.realm) + 1)
            : String(parseInt(p.level, 10) + 1)

          const targetLv = data.levels[targetLevelId]
          if (!targetLv) return '当前已是最高境界，无需服用突破丹'

          await ctx.database.upsert(TABLE.pillUsed, [{
            uid: p.uid, pillId: goodsId,
            targetLevelId, usedAt: new Date(),
          }], ['uid', 'pillId'])
          await removeItem(ctx, p.uid, goodsId, 1)

          const btValue = getOneShotBreakthroughValue(meta)
          return `💊 服用「${meta.name}」，突破「${targetLv.name}」时成功率 +${btValue}%（成功突破此境界前一直有效，飞升后重置）`
        }

        if (meta.realm && parseInt(p.level, 10) < Number(meta.realm)) {
          return `境界不足，需达到「${data.levels[String(meta.realm)]?.name}」`
        }
        const dailyLimit = (meta as any).dailyLimit ?? (meta as any).dayNum as number | undefined
        const rawTotalLimit = (meta as any).totalStock ?? (meta as any).allNum as number | undefined
        const totalLimit = rawTotalLimit !== undefined && rawTotalLimit < 999999 ? rawTotalLimit : undefined
        const perUse = (meta as any).usePerTime ?? (meta as any).maxUse ?? 999
        const actualCount = Math.min(count, perUse)
        if (actualCount < 1) return '请输入有效使用数量'
        if (dailyLimit !== undefined && backRow.dayNum + actualCount > dailyLimit) {
          return `「${meta.name}」今日使用次数已达上限（${dailyLimit}）`
        }
        if (totalLimit !== undefined && backRow.allNum + actualCount > totalLimit) {
          return `「${meta.name}」累计使用次数已达上限（整局限 ${totalLimit}）`
        }

        for (let i = 0; i < actualCount; i++) {
          for (const m of meta.modifiers ?? []) {
            if (m.stat === 'exp' && m.mode === 'flat') {
              p.exp += m.value
            } else if (m.stat === 'breakthroughRate') {
              p.levelUpRate = (p.levelUpRate || 0) + Math.round(m.value * 100)
            } else if (m.stat === 'hp') {
              p.hp = Math.min(p.maxhp, p.hp + Math.floor(p.maxhp * (m.value ?? 0)))
            } else if (m.stat === 'mp') {
              p.mp = Math.min(p.maxmp, p.mp + Math.floor(p.maxmp * (m.value ?? 0)))
            } else if (m.stat === 'atk' && m.mode === 'flat') {
              const buffNow = await getBuff(ctx, p.uid)
              const newBuff = {
                uid: p.uid,
                mainBuff: buffNow.mainBuff ?? 0,
                secBuff: buffNow.secBuff ?? 0,
                subBuff: buffNow.subBuff ?? 0,
                faqiBuff: buffNow.faqiBuff ?? 0,
                armorBuff: buffNow.armorBuff ?? 0,
                atkBuff: (buffNow.atkBuff ?? 0) + m.value,
                blessedSpot: buffNow.blessedSpot ?? 0,
                furnaceBuff: buffNow.furnaceBuff ?? 0,
                qiFlagBuff: buffNow.qiFlagBuff ?? 0,
              }
              await ctx.database.upsert(TABLE.buff, [newBuff], ['uid'])
            }
          }
        }

        const hasLimits = dailyLimit !== undefined || totalLimit !== undefined
        await removeItem(ctx, p.uid, goodsId, actualCount, hasLimits)
        if (hasLimits) {
          await ctx.database.set(TABLE.back, { uid: p.uid, goodsId }, {
            dayNum: backRow.dayNum + actualCount,
            allNum: backRow.allNum + actualCount,
          })
        }
        await ctx.database.set(TABLE.player, { uid: p.uid }, {
          exp: p.exp, hp: p.hp, mp: p.mp, levelUpRate: p.levelUpRate,
        })
        await refreshPlayerStats(ctx, p)

        // ✅ 判断是不是回复类丹药
        const hasHpRecovery = (meta.modifiers ?? []).some((m: any) => m.stat === 'hp')
        const hasMpRecovery = (meta.modifiers ?? []).some((m: any) => m.stat === 'mp')

        let msg = `✅ 使用了 ${actualCount} 个「${meta.name}」`
        if (hasHpRecovery || hasMpRecovery) {
          msg += `\n🩸 当前气血：${Math.floor(p.hp)}/${p.maxhp}（${formatPct(p.hp, p.maxhp)}%）\n💧 当前真元：${Math.floor(p.mp)}/${p.maxmp}（${formatPct(p.mp, p.maxmp)}%）`
        }
        return msg
      }

      // ===== 武器 / 防具 =====
      if (meta._type === 'weapon' || meta._type === 'armor') {
        const slot = meta._type === 'weapon' ? 'faqiBuff' : 'armorBuff'
        await equipSlot(ctx, p.uid, slot, goodsId)
        await refreshPlayerStats(ctx, p)
        return `⚔️ 已装备「${meta.name}」`
      }

      // ===== 聚灵旗 =====
      if (meta._type === 'qiflag') {
        await equipSlot(ctx, p.uid, 'qiFlagBuff', goodsId)
        const cultPct = ((meta.cultivateSpeed ?? 0) * 10).toFixed(0)
        const herbPct = ((meta.herbSpeed ?? 0) * 20).toFixed(0)
        return `🚩 已装备聚灵旗「${meta.name}」（闭关修为 +${cultPct}% / 灵田增速 +${herbPct}%）`
      }

      // ===== 炼丹炉 =====
      if (meta._type === 'furnace' || (meta as any).bonusQuantity !== undefined) {
        await equipSlot(ctx, p.uid, 'furnaceBuff', goodsId)
        return `⚗️ 已装备炼丹炉「${meta.name}」（多产 ${meta.bonusQuantity ?? 0} 枚 / 成功率 +${((meta.bonusSuccess ?? 0) * 100).toFixed(0)}%）`
      }

      return '该物品暂不可使用'
    })

  // ===== 我的功法 =====
  ctx.command('我的功法', '查看已学功法/辅修')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const learned = await getLearnedSkills(ctx, p.uid)

      // 格式化功法的加成描述
      const formatMods = (mods: any[]) => {
        if (!mods || mods.length === 0) return ''
        return mods.map(m => {
          // 处理百分比和固定值
          const val = m.mode === 'flat' ? m.value : (m.value * 100).toFixed(0) + '%'
          return `${statLabel(m.stat)} +${val}`
        }).join('、')
      }

      // 格式化功法列表（带品阶）
      const formatList = (ids: number[], table: any) => {
        return ids.map(id => {
          const item = table[String(id)]
          if (!item) return null
          const quality = getQualityLabel(id)
          const qualityStr = quality ? `[${quality}] ` : ''
          const modStr = formatMods(item.modifiers)
          const desc = item.desc ? `（${item.desc}）` : ''

          return `· ${qualityStr}${item.name}${desc}\n   加成：${modStr || '无'}`
        }).filter(Boolean)
      }

      const gongfaLines = formatList(learned.gongfa, data.gongfa)
      const fuxiuLines = formatList(learned.fuxiu, data.fuxiu)

      return [
        `📖 主功法（${learned.gongfa.length}）`,
        gongfaLines.length ? gongfaLines.join('\n') : '· 无',
        `\n📚 辅修功法（${learned.fuxiu.length}）`,
        fuxiuLines.length ? fuxiuLines.join('\n') : '· 无',
      ].join('\n')
    })

  // ===== 我的神通 =====
  ctx.command('我的神通', '查看已学神通')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const learned = await getLearnedSkills(ctx, p.uid)
      if (!learned.shentong.length) return '尚未学习任何神通'
      const lines = learned.shentong.map(id => {
        const st = data.shentong[String(id)]
        if (!st) return null
        const quality = getQualityLabel(id)
        const qualityStr = quality ? `（${quality}）` : ''
        const effectLines = formatShenTongEffect(st)
        return `· ${st.name}${qualityStr}\n${effectLines.join('\n')}`
      }).filter(Boolean)
      return `✨ 已学神通（${learned.shentong.length}）\n` + lines.join('\n')
    })

  // ===== 查看物品 =====
  ctx.command('查看修仙物品 <query:string>', '查询物品详情')
    .alias('查看修仙物品信息').alias('查看物品').alias('物品查看').alias('查看修仙道具信息').alias('修仙道具信息').alias('查看修仙道具').alias('查看道具信息').alias('道具信息').alias('查看道具').alias('查看')
    .action(async ({ session }, query) => {
      if (!query) return '请输入物品名称或编号'
      const all = ALL_ITEM_TABLES()

      // 支持按 ID 或名称查询
      let foundId: string | undefined = all[query] ? query : undefined
      let found: any = foundId ? all[foundId] : undefined

      if (!found) {
        const entry = Object.entries(all).find(([, v]) => (v as any).name === query)
        if (entry) {
          foundId = entry[0]
          found = entry[1]
        }
      }

      if (!found || !foundId) return '未找到该物品'

      const lines: string[] = [`📦 ${found.name}`]
      if (found.desc) lines.push(`说明：${found.desc}`)

      const quality = getQualityLabel(foundId)
      if (quality) lines.push(`品阶：${quality}`)

      // ===== 丹药标签 =====
      if (found._type === 'pill' && found.tag) {
        lines.push(`标签：${found.tag}`)
      }

      // ===== 功法 =====
      if (found._type === 'gongfa') {
        lines.push('类型：主功法（学习后永久累计加成）')
        lines.push(`加成：${formatModifiers(found.modifiers)}`)
      }

      // ===== 辅修功法 =====
      if (found._type === 'fuxiu') {
        const effName = FUXIU_EFFECT_LABEL[found.effect] ?? found.effect
        lines.push('类型：辅修功法（学习后永久累计加成）')
        lines.push(`效果：${effName} +${found.value}${found.effect === 'lifesteal' || found.effect === 'poison' ? '%' : ''}%`)
      }

      // ===== 神通 =====
      if (found._type === 'shentong') {
        lines.push('类型：神通（学习后战斗中按权重随机释放）')
        lines.push('战斗效果：')
        lines.push(...formatShenTongEffect(found))
      }

      // ===== 武器 / 防具 =====
      if (found._type === 'weapon' || found._type === 'armor') {
        lines.push(`类型：${found._type === 'weapon' ? '武器（装备后提升战斗属性）' : '防具（装备后提升战斗属性）'}`)
        lines.push(`加成：${formatModifiers(found.modifiers)}`)
      }

      // ===== 聚灵旗 =====
      if (found._type === 'qiflag') {
        lines.push('类型：聚灵旗（装备后提升闭关修为速度与灵田生长速度）')
        if (found.cultivateSpeed !== undefined) lines.push(`闭关修为 +${(found.cultivateSpeed * 10).toFixed(0)}%`)
        if (found.herbSpeed !== undefined) lines.push(`灵田增速 +${(found.herbSpeed * 20).toFixed(0)}%`)
      }

      // ===== 炼丹炉 =====
      if (found._type === 'furnace') {
        lines.push('类型：炼丹炉（装备后提升炼丹产出）')
        lines.push(`多产 +${found.bonusQuantity ?? 0} 枚 / 成功率 +${((found.bonusSuccess ?? 0) * 100).toFixed(0)}%`)
      }

      // ===== 药材 =====
      if (found._type === 'herb') {
        lines.push('类型：炼丹药材')
        if (found.tier) lines.push(`阶位：${found.tier} 阶`)
        if (Array.isArray(found.main)) lines.push(`主药：${found.main[0] >= 0 ? '+' : ''}${found.main[0]} 温（需求数 ${found.main[1]} / 可炼上限 ${found.main[2]}）`)
        if (Array.isArray(found.guide)) lines.push(`药引：${found.guide[0] >= 0 ? '+' : ''}${found.guide[0]} 温（需求数 ${found.guide[1]} / 可炼上限 ${found.guide[2]}）`)
        if (Array.isArray(found.aux)) {
          const auxTypeLabel: Record<number, string> = { 3: '主药辅', 4: '药引辅', 6: '攻伐辅' }
          lines.push(`辅药：${auxTypeLabel[found.aux[0]] ?? `类型 ${found.aux[0]}`}（需求数 ${found.aux[1]}）`)
        }
      }

      // ===== 普通丹药的特殊类型说明 =====
      const hasBT = found.modifiers?.some((m: any) => m.stat === 'breakthroughBigRate')
      const hasRate = found.modifiers?.some((m: any) => m.stat === 'breakthroughRate')
      if (hasBT) lines.push('效果：大境界突破丹（整局限服一次，成功突破对应境界前一直有效，飞升后重置）')
      if (hasRate) lines.push('效果：通用突破丹（临时累积加成，突破成功后清零）')

      return lines.join('\n')
    })
}