import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import { requirePlayer, addItem, removeItem, getOrCreateBuff } from '../utils'

/**
 * 药材数据格式：
 *   main  = [冷热, 类型, 药力]   作主药时：类型需与丹方 mainType 相符
 *   guide = [冷热, 类型, 药力]   药引（冷热调和预留）
 *   aux   = [类型, 药力]         作辅药时：类型需与丹方 auxType 相符
 * 丹方的 mainCount / auxCount 为所需「药力」：需扣除株数 = ⌈所需药力 ÷ 单株药力⌉。
 */
interface CraftResult {
  index: number; pillId: string; name: string
  mainId: string; auxId: string
  mainNeed: number; auxNeed: number
}

/** 所需药力 → 需扣除的株数（药力异常时视为 1） */
function herbsNeeded(requiredPower: number, herbPower: number): number {
  const power = Math.max(1, Number(herbPower) || 1)
  return Math.max(1, Math.ceil((Number(requiredPower) || 0) / power))
}

/**
 * 冷热调和检查（预留，暂未启用）：主药冷热 + 药引冷热 = 0 视为调和。
 * 未来升级时可在「炼制」中启用。
 */
export function checkTemperatureBalance(mainHerb: any, guideHerb: any = mainHerb): boolean {
  const mainTemp = Number(mainHerb?.main?.[0]) || 0
  if (mainTemp === 0) return true
  const guideTemp = Number(guideHerb?.guide?.[0]) || 0
  return mainTemp + guideTemp === 0
}

export function registerAlchemyCommands(ctx: Context) {
  // 每位玩家最近一次「炼丹」列出的丹方（随插件实例创建 / 释放，炼制后清除）
  const recipeCache = new Map<number, CraftResult[]>()
  ctx.on('dispose', () => recipeCache.clear())

  ctx.command('炼丹帮助', '炼丹指令').action(() => [
    '炼丹          扫描背包列出可炼制丹方',
    '炼制 <序号>   炼制指定丹方',
    '炼丹配方帮助   配方规则说明',
  ].join('\n'))

  ctx.command('炼丹配方帮助', '机制说明').action(() => [
    '📖 每张丹方需要「主药」与「辅药」各一种：',
    '· 主药的类型、辅药的类型都需与丹方相符',
    '· 所需株数 = ⌈丹方所需药力 ÷ 该药材的药力⌉，药材阶数越高药力越强',
    '· 主药与辅药不能是同一种药材',
    '装备炼丹炉方可炼丹；炼丹炉可提升成功率与产量。（冷热调和机制暂未启用）',
  ].join('\n'))

  ctx.command('炼丹', '列出可炼丹方')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const buff = await getOrCreateBuff(ctx, p.uid)
      if (!buff.furnaceBuff) return '⚠️ 尚未装备炼丹炉，无法炼丹'
      const items = await ctx.database.get(TABLE.back, { uid: p.uid })
      const have = new Map(items.map(it => [String(it.goodsId), it.goodsNum]))
      const list: CraftResult[] = []

      for (const [pid, pill] of Object.entries<any>(data.craftPills)) {
        if (!pill.craft) continue
        const { mainType, mainCount, auxType, auxCount } = pill.craft

        // ✅ 主药 / 辅药分别按「类型 + 药力换算后的株数」筛候选
        const mainCandidates: Array<{ id: string; need: number }> = []
        const auxCandidates: Array<{ id: string; need: number }> = []
        for (const [hid, num] of have) {
          const herb = data.herbs[hid]
          if (!herb) continue
          if (herb.main?.[1] === mainType) {
            const need = herbsNeeded(mainCount, herb.main[2])
            if (num >= need) mainCandidates.push({ id: hid, need })
          }
          if (herb.aux?.[0] === auxType) {
            const need = herbsNeeded(auxCount, herb.aux[1])
            if (num >= need) auxCandidates.push({ id: hid, need })
          }
        }

        // ✅ 主药 ≠ 辅药：同一株药材不能同时兼任两者
        let picked: { main: { id: string; need: number }; aux: { id: string; need: number } } | null = null
        for (const m of mainCandidates) {
          const a = auxCandidates.find(x => x.id !== m.id)
          if (a) { picked = { main: m, aux: a }; break }
        }
        if (!picked) continue

        // 每种丹方只列出一条可用组合，避免同一丹方占满列表
        list.push({
          index: list.length + 1, pillId: pid, name: pill.name,
          mainId: picked.main.id, auxId: picked.aux.id,
          mainNeed: picked.main.need, auxNeed: picked.aux.need,
        })
        if (list.length >= 20) break
      }

      recipeCache.set(p.uid, list)
      if (!list.length) return '背包中没有可炼制的丹方'
      return '⚗️ 可炼制丹方（发送「炼制 <序号>」）\n' +
        list.map(r => {
          const mn = (data.herbs as any)[r.mainId]?.name ?? r.mainId
          const an = (data.herbs as any)[r.auxId]?.name ?? r.auxId
          return `${r.index}. ${r.name}（主药：${mn}×${r.mainNeed} / 辅药：${an}×${r.auxNeed}）`
        }).join('\n')
    })

  ctx.command('炼制 <no:number>', '炼制')
    .action(async ({ session }, no) => {
      if (!no) return '请输入序号'
      const p = await requirePlayer(ctx, session)
      const list = recipeCache.get(p.uid) || []
      const r = list[no - 1]
      if (!r) return '序号不存在'

      // ✅ 防御 1：主辅药材不能相同
      if (r.mainId === r.auxId) {
        return '⚠️ 丹方数据异常（主辅药材冲突），请重新发送「炼丹」刷新后再试'
      }

      const pill = data.craftPills[r.pillId]
      if (!pill?.craft) return '丹方数据异常，请重新发送「炼丹」刷新'
      const herb = data.herbs[r.mainId]
      const aux = data.herbs[r.auxId]
      if (!herb || !aux) return '药材数据异常，请重新发送「炼丹」刷新'

      // 按当前数据重新换算所需株数（避免使用过期缓存）
      const mainNeed = herbsNeeded(pill.craft.mainCount, herb.main?.[2])
      const auxNeed = herbsNeeded(pill.craft.auxCount, aux.aux?.[1])

      // ✅ 防御 2：主药 / 辅药独立检查
      const items = await ctx.database.get(TABLE.back, { uid: p.uid })
      const haveMain = items.find(i => String(i.goodsId) === r.mainId)?.goodsNum || 0
      const haveAux = items.find(i => String(i.goodsId) === r.auxId)?.goodsNum || 0
      if (haveMain < mainNeed) {
        return `主药「${herb.name}」不足（需 ${mainNeed}，持有 ${haveMain}）`
      }
      if (haveAux < auxNeed) {
        return `辅药「${aux.name}」不足（需 ${auxNeed}，持有 ${haveAux}）`
      }

      // 冷热调和：保留 checkTemperatureBalance() 供未来升级启用，目前不检查

      // 成功率
      let rate = 60 + (pill.craft.successCap - 60) * 0.5
      const buff = await getOrCreateBuff(ctx, p.uid)
      const furnace = buff.furnaceBuff ? data.furnaces[String(buff.furnaceBuff)] : undefined
      if (furnace?.bonusSuccess) rate += furnace.bonusSuccess * 100
      if (rate > 100) rate = 100

      // ✅ 防御 3：统一扣料封装；用 { ok: boolean; reason?: string } 避开判别联合窄化问题
      const consumeMaterials = async (): Promise<{ ok: boolean; reason?: string }> => {
        const okMain = await removeItem(ctx, p.uid, Number(r.mainId), mainNeed)
        if (!okMain) {
          return { ok: false, reason: `主药「${herb.name}」扣除失败（库存变动）` }
        }
        const okAux = await removeItem(ctx, p.uid, Number(r.auxId), auxNeed)
        if (!okAux) {
          await addItem(ctx, p.uid, Number(r.mainId), mainNeed)   // 回滚主药
          return { ok: false, reason: `辅药「${aux.name}」扣除失败（库存变动）` }
        }
        return { ok: true }
      }

      // 本次丹方列表已使用，清除缓存（需重新「炼丹」获取最新组合）
      recipeCache.delete(p.uid)

      // ===== 失败分支：失败也扣料，但扣料失败不吞材料 =====
      if (Math.random() * 100 > rate) {
        const consumed = await consumeMaterials()
        if (!consumed.ok) return `⚠️ 炼制中止：${consumed.reason ?? '未知错误'}`
        return `❌ 炼制失败！损失药材：主药「${herb.name}」×${mainNeed} + 辅药「${aux.name}」×${auxNeed}`
      }

      // ===== 成功分支：先扣料，再发丹 =====
      const consumed = await consumeMaterials()
      if (!consumed.ok) return `⚠️ 炼制中止：${consumed.reason ?? '未知错误'}`

      const qty = 1 + (furnace?.bonusQuantity ?? 0)
      await addItem(ctx, p.uid, Number(r.pillId), qty)
      return `⚗️ 炼制成功！获得「${pill.name}」×${qty}（主药：${herb.name}×${mainNeed} / 辅药：${aux.name}×${auxNeed}）`
    })
}
