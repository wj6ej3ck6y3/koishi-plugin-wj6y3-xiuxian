import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import { requirePlayer, addItem, removeItem, getBuff } from '../utils'

interface CraftResult { index: number; pillId: string; name: string; mainId: string; auxId: string }

const recipeCache = new Map<string, CraftResult[]>()

export function registerAlchemyCommands(ctx: Context) {
  ctx.command('炼丹帮助', '炼丹指令').action(() =>[
    '炼丹          扫描背包列出可炼制丹方',
    '炼制 <序号>   炼制指定丹方',
    '炼丹配方帮助   冷热调和机制'
  ].join('\n'))

  ctx.command('炼丹配方帮助', '机制说明').action(() =>[
    '📖 主药 + 药引需冷热调和（主药性 + 药引性 ≈ 0）',
    '辅药决定丹药类型。持有炼丹炉方可炼丹。',
  ].join('\n'))

  ctx.command('炼丹', '列出可炼丹方')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const buff = await getBuff(ctx, p.userId)
      if (!buff.furnaceBuff) return '⚠️ 尚未装备炼丹炉，无法炼丹'
      const items = await ctx.database.get(TABLE.back, { userId: p.userId })
      const have = new Map(items.map(it => [String(it.goodsId), it.goodsNum]))
      const list: CraftResult[] = []
      for (const [pid, pill] of Object.entries<any>(data.craftPills)) {
        if (!pill.craft) continue
        const { mainType, mainCount, auxType, auxCount } = pill.craft
        // 遍历背包里符合类型的药材
        for (const [hid, num] of have) {
          const herb = data.herbs[hid]
          if (!herb) continue
          const main = herb.main || []
          const aux = herb.aux || []
          if (main[0] !== mainType) continue
          if (num < mainCount + auxCount) continue
          if (aux[0] !== auxType) continue
          list.push({
            index: list.length + 1, pillId: pid, name: pill.name, mainId: hid, auxId: hid,
          })
        }
        if (list.length >= 20) break
      }
      recipeCache.set(p.userId, list)
      if (!list.length) return '背包中没有可炼制的丹方'
      return '⚗️ 可炼制丹方（发送「炼制 <序号>」）\n' +
        list.slice(0, 20).map(r => `${r.index}. ${r.name}`).join('\n')
    })

  ctx.command('炼制 <no:number>', '炼制')
    .action(async ({ session }, no) => {
      if (!no) return '请输入序号'
      const p = await requirePlayer(ctx, session)
      const list = recipeCache.get(p.userId) || []
      const r = list[no - 1]
      if (!r) return '序号不存在'
      const pill = data.craftPills[r.pillId]
      const herb = data.herbs[r.mainId]
      const aux = data.herbs[r.auxId]
      const { mainCount, auxCount } = pill.craft
      // 检查数量
      const items = await ctx.database.get(TABLE.back, { userId: p.userId })
      const haveMain = items.find(i => String(i.goodsId) === r.mainId)?.goodsNum || 0
      const haveAux = items.find(i => String(i.goodsId) === r.auxId)?.goodsNum || 0
      if (haveMain < mainCount || haveAux < auxCount) return '药材不足'
      // 冷热调和
      if (herb.main?.[0] !== 0) {
        // 简化：主药和药引的冷热和需为 0
        const guideSum = herb.main[0] + (herb.guide?.[0] ?? 0)
        if (guideSum !== 0 && herb.main[0] !== 0) {
          return '❌ 冷热失和，炼制失败（不消耗药材）'
        }
      }
      // 计算成功率
      let rate = 60 + (pill.craft.successCap - 60) * 0.5
      // ✅ 若装了炉子，加成 bonusSuccess
      const buff = await getBuff(ctx, p.userId)
      const furnace = buff.furnaceBuff ? data.furnaces[String(buff.furnaceBuff)] : undefined
      if (furnace?.bonusSuccess) rate += furnace.bonusSuccess * 100
      if (rate > 100) rate = 100

      if (Math.random() * 100 > rate) {
        // ✅ 失败也扣材料
        await removeItem(ctx, p.userId, Number(r.mainId), mainCount)
        await removeItem(ctx, p.userId, Number(r.auxId), auxCount)
        return `❌ 炼制失败！损失药材 ${mainCount} 主药 + ${auxCount} 辅药`
      }

      // 成功扣材料 + 加丹药（数量受炉子 bonusQuantity 加成）
      await removeItem(ctx, p.userId, Number(r.mainId), mainCount)
      await removeItem(ctx, p.userId, Number(r.auxId), auxCount)
      const qty = 1 + (furnace?.bonusQuantity ?? 0)
      await addItem(ctx, p.userId, Number(r.pillId), qty)
      return `⚗️ 炼制成功！获得「${pill.name}」×${qty}`
    })
}