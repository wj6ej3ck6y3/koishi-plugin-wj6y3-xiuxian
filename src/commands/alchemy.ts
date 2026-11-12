import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import { requirePlayer, addItem, removeItem, getBuff } from '../utils'

interface CraftResult { index: number; pillId: string; name: string; mainId: string; auxId: string }

// ✅ key 从 userId(string) 改为 uid(number)
const recipeCache = new Map<number, CraftResult[]>()

export function registerAlchemyCommands(ctx: Context) {
  ctx.command('炼丹帮助', '炼丹指令').action(() => [
    '炼丹          扫描背包列出可炼制丹方',
    '炼制 <序号>   炼制指定丹方',
    '炼丹配方帮助   冷热调和机制'
  ].join('\n'))

  ctx.command('炼丹配方帮助', '机制说明').action(() => [
    '📖 主药 + 药引需冷热调和（主药性 + 药引性 ≈ 0）',
    '辅药决定丹药类型。持有炼丹炉方可炼丹。',
  ].join('\n'))

  ctx.command('炼丹', '列出可炼丹方')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const buff = await getBuff(ctx, p.uid)
      if (!buff.furnaceBuff) return '⚠️ 尚未装备炼丹炉，无法炼丹'
      const items = await ctx.database.get(TABLE.back, { uid: p.uid })
      const have = new Map(items.map(it => [String(it.goodsId), it.goodsNum]))
      const list: CraftResult[] = []

      for (const [pid, pill] of Object.entries<any>(data.craftPills)) {
        if (!pill.craft) continue
        const { mainType, mainCount, auxType, auxCount } = pill.craft

        // ✅ 主药 / 辅药分别按「类型 + 持有量」筛候选
        const mainCandidates: string[] = []
        const auxCandidates: string[] = []
        for (const [hid, num] of have) {
          const herb = data.herbs[hid]
          if (!herb) continue
          if (herb.main?.[0] === mainType && num >= mainCount) mainCandidates.push(hid)
          if (herb.aux?.[0] === auxType && num >= auxCount) auxCandidates.push(hid)
        }

        // ✅ 主药 ≠ 辅药：同一株药材不能同时兼任两者
        let picked: { mainId: string; auxId: string } | null = null
        for (const mid of mainCandidates) {
          const aid = auxCandidates.find(a => a !== mid)
          if (aid) { picked = { mainId: mid, auxId: aid }; break }
        }
        if (!picked) continue

        // 每种丹方只列出一条可用组合，避免同一丹方占满列表
        list.push({
          index: list.length + 1, pillId: pid, name: pill.name,
          mainId: picked.mainId, auxId: picked.auxId,
        })
        if (list.length >= 20) break
      }

      recipeCache.set(p.uid, list)
      if (!list.length) return '背包中没有可炼制的丹方'
      return '⚗️ 可炼制丹方（发送「炼制 <序号>」）\n' +
        list.slice(0, 20).map(r => {
          const mn = (data.herbs as any)[r.mainId]?.name ?? r.mainId
          const an = (data.herbs as any)[r.auxId]?.name ?? r.auxId
          return `${r.index}. ${r.name}（主药：${mn} / 辅药：${an}）`
        }).join('\n')
    })

  ctx.command('炼制 <no:number>', '炼制')
    .action(async ({ session }, no) => {
      if (!no) return '请输入序号'
      const p = await requirePlayer(ctx, session)
      const list = recipeCache.get(p.uid) || []
      const r = list[no - 1]
      if (!r) return '序号不存在'

      // ✅ 防御 1：旧 recipe（修复前缓存）中 mainId === auxId，必须拒绝
      if (r.mainId === r.auxId) {
        return '⚠️ 丹方数据异常（主辅药材冲突），请重新发送「炼丹」刷新后再试'
      }

      const pill = data.craftPills[r.pillId]
      if (!pill?.craft) return '丹方数据异常，请重新发送「炼丹」刷新'
      const herb = data.herbs[r.mainId]
      const aux = data.herbs[r.auxId]
      if (!herb || !aux) return '药材数据异常，请重新发送「炼丹」刷新'

      const { mainCount, auxCount } = pill.craft

      // ✅ 防御 2：主药 / 辅药独立检查（mainId !== auxId 已在上面保证）
      const items = await ctx.database.get(TABLE.back, { uid: p.uid })
      const haveMain = items.find(i => String(i.goodsId) === r.mainId)?.goodsNum || 0
      const haveAux = items.find(i => String(i.goodsId) === r.auxId)?.goodsNum || 0
      if (haveMain < mainCount) {
        return `主药「${herb.name}」不足（需 ${mainCount}，持有 ${haveMain}）`
      }
      if (haveAux < auxCount) {
        return `辅药「${aux.name}」不足（需 ${auxCount}，持有 ${haveAux}）`
      }

      // 冷热调和（暂沿用原逻辑：主药温度 + 主药自身药引温度）
      if (herb.main?.[0] !== 0) {
        const guideSum = herb.main[0] + (herb.guide?.[0] ?? 0)
        if (guideSum !== 0) {
          return '❌ 冷热失和，炼制失败（不消耗药材）'
        }
      }

      // 成功率
      let rate = 60 + (pill.craft.successCap - 60) * 0.5
      const buff = await getBuff(ctx, p.uid)
      const furnace = buff.furnaceBuff ? data.furnaces[String(buff.furnaceBuff)] : undefined
      if (furnace?.bonusSuccess) rate += furnace.bonusSuccess * 100
      if (rate > 100) rate = 100

      // ✅ 防御 3：统一扣料封装；用 { ok: boolean; reason?: string } 避开判别联合窄化问题
      const consumeMaterials = async (): Promise<{ ok: boolean; reason?: string }> => {
        const okMain = await removeItem(ctx, p.uid, Number(r.mainId), mainCount)
        if (!okMain) {
          return { ok: false, reason: `主药「${herb.name}」扣除失败（库存变动）` }
        }
        const okAux = await removeItem(ctx, p.uid, Number(r.auxId), auxCount)
        if (!okAux) {
          await addItem(ctx, p.uid, Number(r.mainId), mainCount)   // 回滚主药
          return { ok: false, reason: `辅药「${aux.name}」扣除失败（库存变动）` }
        }
        return { ok: true }
      }

      // ===== 失败分支：失败也扣料，但扣料失败不吞材料 =====
      if (Math.random() * 100 > rate) {
        const consumed = await consumeMaterials()
        if (!consumed.ok) return `⚠️ 炼制中止：${consumed.reason ?? '未知错误'}`
        return `❌ 炼制失败！损失药材 ${mainCount} 主药 + ${auxCount} 辅药`
      }

      // ===== 成功分支：先扣料，再发丹 =====
      const consumed = await consumeMaterials()
      if (!consumed.ok) return `⚠️ 炼制中止：${consumed.reason ?? '未知错误'}`

      const qty = 1 + (furnace?.bonusQuantity ?? 0)
      await addItem(ctx, p.uid, Number(r.pillId), qty)
      return `⚗️ 炼制成功！获得「${pill.name}」×${qty}（主药：${herb.name} / 辅药：${aux.name}）`
    })
}