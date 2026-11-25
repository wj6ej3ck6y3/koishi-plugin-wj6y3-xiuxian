import { $, Context, Session } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import type { ShenTongEntry } from '../types'
import {
  requirePlayer, addItem, removeItem, getOrCreateBuff, recomputeAndSaveStats,
  getLearnedSkillsAndMigrate,
  isOneShotBreakthroughPill, isOneShotPillUsed,
  getOneShotBreakthroughValue,
  getPillUseLimit, getPillUsedCount, addPillUsedCount,
  addPlayerExp,
  setEquipSlot, getEquippedIds, EquipSlot,
  getFuxiuBonus,
  floorRow,
  getQualityLabel,
  getTierRank,
  statLabel,
  formatModifiers,
  ALL_ITEM_TABLES,
  findItemInBackpack,
  formatPct,
  DUE_PILL_ID,
  formatCompact,
  sendSegments,
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

/** 辅修的实际加成文字：已实作的效果显示对应属性加成，尚未实作的显示「无加成」 */
function formatFuxiuBonus(entry: any): string {
  const b = getFuxiuBonus(entry)
  if (!b) return '无加成'
  return `${statLabel(b.stat)} +${(b.value * 100).toFixed(0)}%`
}

/**
 * 神通冷却的实际效果：施放后 cd = turnCost，每回合结束减 1，>0 时不可施放，
 * 因此施放后有 turnCost - 1 个回合无法再次施放（turnCost ≤ 1 即无冷却）。
 */
function formatShenTongCooldown(st: ShenTongEntry): string {
  const cd = (st.turnCost ?? 0) - 1
  return cd > 0 ? `施放后 ${cd} 回合不可再施放` : '无冷却'
}

/** 把神通的战斗效果格式化为多行字符串（供「我的神通」和「查看修仙界物品」共用） */
function formatShenTongEffect(st: ShenTongEntry | undefined): string[] {
  if (!st) return []
  const lines: string[] = []
  const mpPart = `耗真元 ${(st.mpCost * 100).toFixed(0)}%`
  const ratePart = `命中 ${st.rate}%`
  const cdPart = formatShenTongCooldown(st)

  // type 1：单次伤害
  if (st.type === 1) {
    const values = Array.isArray(st.atkValue) ? st.atkValue : [st.atkValue]
    const totalMul = values.reduce((s: number, v: number) => s + v, 0)
    const segPart = values.length > 1 ? `（${values.length} 段）` : ''
    lines.push(`  · 总伤害 ×${totalMul.toFixed(2)}${segPart}`)
    lines.push(`  · ${mpPart}｜${ratePart}｜${cdPart}`)
    return lines
  }

  // type 2：持续伤害
  if (st.type === 2) {
    const per = Number(st.atkValue)
    lines.push(`  · 每回合伤害 ×${per.toFixed(2)}，持续 ${st.turnCost} 回合`)
    lines.push(`  · ${mpPart}｜${ratePart}｜${cdPart}`)
    return lines
  }

  // type 3：增减益
  if (st.type === 3) {
    const buffVal = ((st.buffValue ?? 0) * 100).toFixed(0)
    let buffDesc = ''
    if (st.buffType === 1) buffDesc = `攻击提升 ${buffVal}%`
    else if (st.buffType === 2) buffDesc = `减伤提升 ${buffVal}%（原减伤 × ${buffVal}%）`
    else buffDesc = `增益 ${buffVal}%`
    lines.push(`  · ${buffDesc}｜持续 ${st.turnCost} 回合`)
    lines.push(`  · ${mpPart}｜${ratePart}｜${cdPart}`)
    return lines
  }

  // type 4：单次伤害 + 吸血
  if (st.type === 4) {
    const values = Array.isArray(st.atkValue) ? st.atkValue : [st.atkValue]
    const totalMul = values.reduce((s: number, v: number) => s + v, 0)
    const segPart = values.length > 1 ? `（${values.length} 段）` : ''
    const lsPart = st.lifestealPct ? `吸血 ${(st.lifestealPct * 100).toFixed(0)}%` : ''
    lines.push(`  · 总伤害 ×${totalMul.toFixed(2)}${segPart}${lsPart ? '｜' + lsPart : ''}`)
    lines.push(`  · ${mpPart}｜${ratePart}｜${cdPart}`)
    return lines
  }

  lines.push(`  · 类型 ${st.type}（未知机制）`)
  return lines
}

/** 单条消息的最大字符数（超出则继续分段） */
const SEGMENT_MAX_CHARS = 1500

/** 把一组行按字数拆成若干段，每段都带标题（续段加「续」） */
function chunkLines(title: string, lines: string[]): string[] {
  const out: string[] = []
  let cur: string[] = []
  let len = title.length
  for (const line of lines) {
    if (cur.length && len + line.length + 1 > SEGMENT_MAX_CHARS) {
      out.push(`${title}${out.length ? '（续）' : ''}\n` + cur.join('\n'))
      cur = []
      len = title.length
    }
    cur.push(line)
    len += line.length + 1
  }
  if (cur.length) out.push(`${title}${out.length ? '（续）' : ''}\n` + cur.join('\n'))
  return out
}

/**
 * 按品阶分组分段：先按品阶由低到高排序（同品阶按名称），再按大品阶（人/黄/玄/地/天/仙）分段。
 * titleOf(group, count) 生成每段标题。
 */
function segmentByTier<T>(
  entries: T[],
  idOf: (e: T) => number,
  nameOf: (e: T) => string,
  lineOf: (e: T) => string,
  titleOf: (group: string, count: number) => string,
  rankOf: (id: number) => { group: string; order: number[] } = id => {
    const r = getTierRank(id)
    return { group: r.group, order: [r.order] }
  },
): string[] {
  const cmpOrder = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0)
      if (d) return d
    }
    return 0
  }
  const ranked = entries
    .map(e => ({ e, r: rankOf(idOf(e)), name: nameOf(e) }))
    .sort((a, b) => cmpOrder(a.r.order, b.r.order) || a.name.localeCompare(b.name, 'zh'))
  const groups: { group: string; items: T[] }[] = []
  for (const x of ranked) {
    const last = groups[groups.length - 1]
    if (last && last.group === x.r.group) last.items.push(x.e)
    else groups.push({ group: x.r.group, items: [x.e] })
  }
  return groups.flatMap(g => chunkLines(titleOf(g.group, g.items.length), g.items.map(lineOf)))
}

/** 丹药 tag → [合并段名, 段内排序序号] */
const PILL_TAG_GROUP: Record<string, [string, number]> = {
  '回复丹': ['回复丹', 0],
  '突破丹': ['突破丹・大突破丹', 1],
  '大突破丹': ['突破丹・大突破丹', 2],
  '修为丹': ['修为丹・攻击丹', 3],
  '攻击丹': ['修为丹・攻击丹', 4],
}

/** 背包中不同类型的分段/排序规则：丹药、药材合并分段，其余仅按类型分组（组内按品阶排序） */
function bagRankOf(type: string, all: Record<string, any>) {
  return (id: number): { group: string; order: number[] } => {
    if (type === 'herb') {
      const tier = Number(all[id]?.tier) || 1
      const base = Math.floor((tier - 1) / 3) * 3 + 1
      return { group: `${base}~${base + 2} 阶`, order: [tier] }
    }
    if (type === 'pill') {
      const meta = all[id]
      const [group, idx] = PILL_TAG_GROUP[meta?.tag] ?? ['其他丹药', 9]
      return { group, order: [idx, -(Number(meta?.weight) || 0)] }
    }
    return { group: '', order: [getTierRank(id).order] }
  }
}

/** 背包分类显示顺序 */
const BACKPACK_TYPE_ORDER: Array<[string, string]> = [
  ['gongfa', '功法'], ['fuxiu', '辅修'], ['shentong', '神通'],
  ['weapon', '武器'], ['armor', '防具'], ['pill', '丹药'],
  ['herb', '药材'], ['furnace', '炼丹炉'], ['qiflag', '聚灵旗'],
]

/** 「我的背包」分类参数 → 要显示的物品类型（_type）集合，简繁均可 */
const BACKPACK_CATEGORY_MAP: Record<string, { label: string; types: string[] }> = {
  '武器': { label: '武器', types: ['weapon'] },
  '防具': { label: '防具', types: ['armor'] },
  '功法': { label: '功法', types: ['gongfa', 'fuxiu'] },
  '神通': { label: '神通', types: ['shentong'] },
  '丹药': { label: '丹药', types: ['pill'] },
  '丹藥': { label: '丹药', types: ['pill'] },
  '药材': { label: '药材', types: ['herb'] },
  '藥材': { label: '药材', types: ['herb'] },
  '聚灵旗': { label: '聚灵旗', types: ['qiflag'] },
  '聚靈旗': { label: '聚灵旗', types: ['qiflag'] },
  '炼丹炉': { label: '炼丹炉', types: ['furnace'] },
  '煉丹爐': { label: '炼丹炉', types: ['furnace'] },
}

export function findItemByName(name: string): [string, any] | null {
  const all = ALL_ITEM_TABLES()
  for (const [id, v] of Object.entries(all)) {
    if ((v as any).name === name) return [id, v]
  }
  return null
}

export function registerBackpackCommands(ctx: Context) {
  // ===== 我的背包 =====
  ctx.command('我的背包 [category:string]', '查看背包，可选分类：武器/防具/功法/神通/丹药/药材/聚灵旗/炼丹炉')
    .alias('我的物品').alias('修仙物品').alias('查看背包')
    .action(async ({ session }, category) => {
      const p = await requirePlayer(ctx, session)
      const items = await ctx.database.get(TABLE.back, { uid: p.uid })
      const visible = items.filter(it => (it.goodsNum ?? 0) > 0)
      if (!visible.length) return '背包空空如也'

      const buff = await getOrCreateBuff(ctx, p.uid)
      const equippedIds = getEquippedIds(buff)

      const all = ALL_ITEM_TABLES()
      const nameOf = (it: any) => (all[it.goodsId] as any)?.name ?? `未知#${it.goodsId}`
      const lineOf = (it: any) => {
        const meta = all[it.goodsId]
        const mark = equippedIds.has(it.goodsId) ? ' [已装备]' : ''
        const quality = getQualityLabel(it.goodsId)
        const qualityStr = quality ? `[${quality}] ` : ''
        const tag = (meta as any)?.tag
        const tagStr = tag ? `【${tag}】` : ''
        return `· ${qualityStr}${tagStr}${nameOf(it)} ×${it.goodsNum}${mark}`
      }

      const known = new Set(BACKPACK_TYPE_ORDER.map(([t]) => t))
      const cat = category ? BACKPACK_CATEGORY_MAP[category.trim()] : undefined
      // 分类参数命中则只显示该分类；未输入或参数无效 → 显示全部
      let pool = visible
      let types: Array<[string, string]> = [...BACKPACK_TYPE_ORDER, ['__other', '其他']]
      if (cat) {
        pool = visible.filter(it => cat.types.includes((all[it.goodsId] as any)?._type))
        if (!pool.length) return `背包中没有${cat.label}类道具`
        types = BACKPACK_TYPE_ORDER.filter(([t]) => cat.types.includes(t))
      }
      const segments: string[] = [
        `🎒 ${p.userName} 的背包${cat ? ' · ' + cat.label : ''}（共 ${pool.length} 类）`,
      ]
      for (const [type, label] of types) {
        const group = pool.filter(it => {
          const t = (all[it.goodsId] as any)?._type
          return type === '__other' ? !known.has(t) : t === type
        })
        if (!group.length) continue
        segments.push(...segmentByTier(
          group, it => it.goodsId, nameOf, lineOf,
          (g, n) => `🎒 ${label}${g ? ' · ' + g : ''}（${n}）`,
          bagRankOf(type, all as any),
        ))
      }
      await sendSegments(session, segments)
    })

  // ===== 卸下 =====
  ctx.command('卸下 <slot:string>', '卸下装备')
    .action(async ({ session }, slot) => {
      if (!slot) return '请输入槽位：武器 / 防具 / 炼丹炉 / 聚灵旗'
      const p = await requirePlayer(ctx, session)
      const buff = await getOrCreateBuff(ctx, p.uid)

      const map: Record<string, { key: EquipSlot; label: string }> = {
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

      await setEquipSlot(ctx, p.uid, target.key, 0)
      await recomputeAndSaveStats(ctx, p)

      const all = ALL_ITEM_TABLES()
      const name = (all[curId] as any)?.name ?? `#${curId}`
      return `📤 已卸下${target.label}「${name}」（物品仍在背包中）`
    })

  // ===== 使用（每次固定 1 份） =====
  ctx.command('使用 <name:string>', '使用 / 学习物品，每次使用 1 份')
    .action(async ({ session }, name) => {
      if (!name) return '请输入要使用的物品名称'
      const p = await requirePlayer(ctx, session)
      const found = await findItemInBackpack(ctx, p.uid, name)
      if (!found) return `背包中未找到「${name}」`
      const [idStr, meta] = found
      const goodsId = parseInt(idStr, 10)

      // ===== 学习制：功法 / 辅修 / 神通 =====
      if (meta._type === 'gongfa' || meta._type === 'fuxiu' || meta._type === 'shentong') {
        const typeName = meta._type === 'gongfa' ? '功法'
          : meta._type === 'fuxiu' ? '辅修功法' : '神通'
        const learned = await getLearnedSkillsAndMigrate(ctx, p.uid)
        const learnedArr = meta._type === 'gongfa' ? learned.gongfa
          : meta._type === 'fuxiu' ? learned.fuxiu : learned.shentong
        if (learnedArr.includes(goodsId)) return `已学会「${meta.name}」，无需重复学习`

        // 先扣物品，扣除成功才学习
        if (!(await removeItem(ctx, p.uid, goodsId, 1))) return '物品数量不足'
        await ctx.database.upsert(TABLE.skill, [{ uid: p.uid, skillId: goodsId }], ['uid', 'skillId'])
        await recomputeAndSaveStats(ctx, p)
        return `📖 成功学习${typeName}「${meta.name}」！`
      }

      // ===== 丹药 =====
      if (meta._type === 'pill') {
        if (goodsId === DUE_PILL_ID) return '「渡厄丹」需在「渡厄突破」时自动使用，请直接发送「渡厄突破」'

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

          if (!(await removeItem(ctx, p.uid, goodsId, 1))) return '物品数量不足'
          await ctx.database.upsert(TABLE.pillUsed, [{
            uid: p.uid, pillId: goodsId,
            targetLevelId, usedAt: new Date(),
          }], ['uid', 'pillId'])

          const btValue = getOneShotBreakthroughValue(meta)
          return `💊 服用「${meta.name}」，突破「${targetLv.name}」时成功率 +${btValue}%（成功突破此境界前一直有效，飞升后重置）`
        }

        if (meta.realm && parseInt(p.level, 10) < Number(meta.realm)) {
          return `境界不足，需达到「${data.levels[String(meta.realm)]?.name}」`
        }

        // 整局限服次数（目前仅攻击丹每种 5 次），记录在独立表中，与背包行无关
        const limit = getPillUseLimit(meta)
        if (limit !== undefined) {
          const used = await getPillUsedCount(ctx, p.uid, goodsId)
          if (used >= limit) return `「${meta.name}」整局限服 ${limit} 次，你已服用 ${used} 次`
        }

        // 先扣物品，扣除成功才生效
        if (!(await removeItem(ctx, p.uid, goodsId, 1))) return '物品数量不足'
        if (limit !== undefined) await addPillUsedCount(ctx, p.uid, goodsId, 1)

        let expGain = 0
        let atkGain = 0
        for (const m of meta.modifiers ?? []) {
          if (m.stat === 'exp' && m.mode === 'flat') {
            expGain += m.value
          } else if (m.stat === 'breakthroughRate') {
            p.levelUpRate = (p.levelUpRate || 0) + Math.round(m.value * 100)
          } else if (m.stat === 'hp') {
            // 回复气血（受 maxhp 封顶）
            p.hp = Math.min(p.maxhp, p.hp + Math.floor(p.maxhp * (m.value ?? 0)))

            // ✅ 回复丹：按「回血比例的一半」回复真元（基于 maxmp，不扣当前气血是否满）
            if (meta.tag === '回复丹') {
              const isPct = (m.mode ?? 'pct') === 'pct'
              const mpHeal = isPct
                ? Math.floor(p.maxmp * (m.value ?? 0) / 2)
                : Math.floor((m.value ?? 0) / 2)
              if (mpHeal > 0) p.mp = Math.min(p.maxmp, p.mp + mpHeal)
            }
          } else if (m.stat === 'mp') {
            p.mp = Math.min(p.maxmp, p.mp + Math.floor(p.maxmp * (m.value ?? 0)))
          } else if (m.stat === 'atk' && m.mode === 'flat') {
            atkGain += m.value
          }
        }

        if (atkGain) {
          await getOrCreateBuff(ctx, p.uid)
          const add = Math.floor(atkGain)
          await ctx.database.set(TABLE.buff, { uid: p.uid }, row => ({ atkBuff: $.add(row.atkBuff, add) }))
        }
        await ctx.database.set(TABLE.player, { uid: p.uid }, floorRow(TABLE.player, {
          hp: p.hp, mp: p.mp, levelUpRate: p.levelUpRate,
        }))
        if (expGain) {
          await addPlayerExp(ctx, p.uid, expGain)
          p.exp += Math.floor(expGain)
        }
        await recomputeAndSaveStats(ctx, p)

        // ✅ 判断是不是回复类丹药
        const hasHpRecovery = (meta.modifiers ?? []).some((m: any) => m.stat === 'hp')
        const hasMpRecovery = (meta.modifiers ?? []).some((m: any) => m.stat === 'mp')

        let msg = `✅ 使用了 1 个「${meta.name}」`
        if (limit !== undefined) {
          msg += `（整局已服 ${await getPillUsedCount(ctx, p.uid, goodsId)}/${limit} 次）`
        }
        if (hasHpRecovery || hasMpRecovery) {
          msg += `\n🩸 当前气血：${formatCompact(p.hp)}/${formatCompact(p.maxhp)}（${formatPct(p.hp, p.maxhp)}%）` +
            `\n💧 当前真元：${formatCompact(p.mp)}/${formatCompact(p.maxmp)}（${formatPct(p.mp, p.maxmp)}%）`
        }
        return msg
      }

      // ===== 武器 / 防具 =====
      if (meta._type === 'weapon' || meta._type === 'armor') {
        const slot = meta._type === 'weapon' ? 'faqiBuff' : 'armorBuff'
        await setEquipSlot(ctx, p.uid, slot, goodsId)
        await recomputeAndSaveStats(ctx, p)
        return `⚔️ 已装备「${meta.name}」`
      }

      // ===== 聚灵旗 =====
      if (meta._type === 'qiflag') {
        await setEquipSlot(ctx, p.uid, 'qiFlagBuff', goodsId)
        const cultPct = ((meta.cultivateSpeed ?? 0) * 10).toFixed(0)
        const herbPct = ((meta.herbSpeed ?? 0) * 20).toFixed(0)
        return `🚩 已装备聚灵旗「${meta.name}」（闭关修为 +${cultPct}% / 灵田增速 +${herbPct}%）`
      }

      // ===== 炼丹炉 =====
      if (meta._type === 'furnace' || (meta as any).bonusQuantity !== undefined) {
        await setEquipSlot(ctx, p.uid, 'furnaceBuff', goodsId)
        return `⚗️ 已装备炼丹炉「${meta.name}」（多产 ${meta.bonusQuantity ?? 0} 枚 / 成功率 +${((meta.bonusSuccess ?? 0) * 100).toFixed(0)}%）`
      }

      return '该物品暂不可使用'
    })

  // ===== 我的功法 =====
  ctx.command('我的功法', '查看已学功法/辅修')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const learned = await getLearnedSkillsAndMigrate(ctx, p.uid)

      // 格式化功法列表（带品阶），按品阶由低到高、大品阶分段
      const buildSegments = (
        ids: number[], table: Record<string, any>, label: string, bonusOf: (item: any) => string,
      ): string[] => {
        const valid = ids.filter(id => table[String(id)])
        return segmentByTier(
          valid, id => id, id => table[String(id)].name,
          id => {
            const item = table[String(id)]
            const quality = getQualityLabel(id)
            const qualityStr = quality ? `[${quality}] ` : ''
            const desc = item.desc ? `（${item.desc}）` : ''
            return `· ${qualityStr}${item.name}${desc}\n   加成：${bonusOf(item)}`
          },
          (g, n) => `${label}${g ? ' · ' + g : ''}（${n}）`,
        )
      }

      const segments = [
        ...buildSegments(learned.gongfa, data.gongfa, '📖 主功法', item => formatModifiers(item.modifiers)),
        ...buildSegments(learned.fuxiu, data.fuxiu, '📚 辅修功法', item => formatFuxiuBonus(item)),
      ]
      if (!segments.length) return '尚未学习任何功法'
      await sendSegments(session, segments)
    })

  // ===== 我的神通 =====
  ctx.command('我的神通', '查看已学神通')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const learned = await getLearnedSkillsAndMigrate(ctx, p.uid)
      if (!learned.shentong.length) return '尚未学习任何神通'
      const valid = learned.shentong.filter(id => data.shentong[String(id)])
      if (!valid.length) return '尚未学习任何神通'
      const segments = segmentByTier(
        valid, id => id, id => data.shentong[String(id)].name,
        id => {
          const st = data.shentong[String(id)]
          const quality = getQualityLabel(id)
          const qualityStr = quality ? `（${quality}）` : ''
          return `· ${st.name}${qualityStr}\n${formatShenTongEffect(st).join('\n')}`
        },
        (g, n) => `✨ 神通${g ? ' · ' + g : ''}（${n}）`,
      )
      await sendSegments(session, segments)
    })

  // ===== 查看物品 =====
  ctx.command('查看修仙物品 <query:string>', '查询物品详情')
    .alias('查看修仙物品信息').alias('查看物品').alias('物品查看').alias('查看修仙道具信息').alias('修仙道具信息').alias('查看修仙道具').alias('查看道具信息').alias('道具信息').alias('查看道具').alias('查看')
    .action(async (_, query) => {
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
        lines.push(`效果：${effName} +${found.value}%`)
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
      // 数据格式：主药 [冷热, 类型, 药力] / 药引 [冷热, 类型, 药力] / 辅药 [类型, 药力]
      if (found._type === 'herb') {
        lines.push('类型：炼丹药材')
        if (found.tier) lines.push(`阶位：${found.tier} 阶`)
        if (Array.isArray(found.main)) lines.push(`主药：${found.main[0] >= 0 ? '+' : ''}${found.main[0]} 温（类型 ${found.main[1]} / 药力 ${found.main[2]}）`)
        if (Array.isArray(found.guide)) lines.push(`药引：${found.guide[0] >= 0 ? '+' : ''}${found.guide[0]} 温（类型 ${found.guide[1]} / 药力 ${found.guide[2]}）`)
        if (Array.isArray(found.aux)) {
          const auxTypeLabel: Record<number, string> = { 3: '主药辅', 4: '药引辅', 6: '攻伐辅' }
          lines.push(`辅药：${auxTypeLabel[found.aux[0]] ?? `类型 ${found.aux[0]}`}（药力 ${found.aux[1]}）`)
        }
      }

      // ===== 普通丹药的特殊类型说明 =====
      const hasBT = found.modifiers?.some((m: any) => m.stat === 'breakthroughBigRate')
      const hasRate = found.modifiers?.some((m: any) => m.stat === 'breakthroughRate')
      if (hasBT) lines.push('效果：大境界突破丹（整局限服一次，成功突破对应境界前一直有效，飞升后重置）')
      if (hasRate) lines.push('效果：通用突破丹（临时累积加成，突破成功后清零）')
      if (found._type === 'pill' && getPillUseLimit(found) !== undefined) {
        lines.push(`限制：每种整局限服 ${getPillUseLimit(found)} 次（飞升 / 重入仙途后重置）`)
      }

      return lines.join('\n')
    })
}
