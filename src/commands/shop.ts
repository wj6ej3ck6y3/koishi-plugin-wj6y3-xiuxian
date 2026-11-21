import { Context } from 'koishi'
import { TABLE } from '../models'
import {
  requirePlayer, addStone, costStone, getStone, getPlayer, addItem, removeItem,
  getItemNameById, getNextId, getQualityLabel, ALL_ITEM_TABLES, estimatePrice, findItemInBackpack,
  getOrCreateBuff, getEquippedIds, claimByRemove,
} from '../utils'
import { findItemByName } from './backpack'

/** 价格参数：舍去小数后须 ≥ 1，否则返回 null */
function parsePrice(price: number | undefined): number | null {
  const n = Math.floor(Number(price))
  return Number.isFinite(n) && n >= 1 ? n : null
}

/** 玩家可出售（上架 / 回收）的数量：装备中的那 1 件不可出售 */
async function sellableCount(ctx: Context, uid: number, goodsId: number): Promise<{ owned: number; reserved: number; sellable: number }> {
  const rows = await ctx.database.get(TABLE.back, { uid, goodsId })
  const owned = rows[0]?.goodsNum ?? 0
  const buff = await getOrCreateBuff(ctx, uid)
  const reserved = getEquippedIds(buff).has(goodsId) ? 1 : 0
  return { owned, reserved, sellable: Math.max(0, owned - reserved) }
}

export function registerShopCommands(ctx: Context) {
  ctx.command('坊市查看', '查看坊市')
    .alias('查看坊市').alias('坊市')
    .action(async () => {
      const list = await ctx.database.get(TABLE.shop, {}, { sort: { createTime: 'asc' }, limit: 50 })
      if (!list.length) return '坊市暂空'
      const all = ALL_ITEM_TABLES()
      const lines = list.map(s => {
        const meta = all[s.goodsId]
        const name = meta?.name ?? getItemNameById(s.goodsId)
        const quality = getQualityLabel(s.goodsId)
        const qualityStr = quality ? `[${quality}] ` : ''
        const tag = (meta as any)?.tag
        const tagStr = tag ? `【${tag}】` : ''
        return `【${s.id}】${s.sellerName}｜${qualityStr}${tagStr}「${name}」×${s.goodsNum}｜${s.price} 灵石`
      })
      return `🏪 坊市（${list.length} 件）：\n` + lines.join('\n')
    })

  ctx.command('坊市购买 <no:number>', '购买')
    .action(async ({ session }, no) => {
      if (no === undefined || no === null) return '请输入编号'
      const p = await requirePlayer(ctx, session)
      const rows = await ctx.database.get(TABLE.shop, { id: Number(no) })
      if (!rows[0]) return '商品不存在'
      const s = rows[0]
      if ((await getStone(ctx, p.uid)) < s.price) return '灵石不足'

      // 先删除挂单作为占用（悬赏令的写法）：同一件商品只能被买走一次
      if (!(await claimByRemove(ctx, TABLE.shop, { id: s.id }))) return '商品已被购买或下架'
      if (!(await costStone(ctx, p.uid, s.price))) {
        // 回滚：恢复挂单
        await ctx.database.create(TABLE.shop, s)
        return '灵石不足'
      }
      await addItem(ctx, p.uid, s.goodsId, s.goodsNum)
      // 卖家到账（sellerUid=0 表示系统挂单，无到账）
      if (s.sellerUid !== 0) {
        const seller = await getPlayer(ctx, s.sellerUid)
        if (seller) await addStone(ctx, seller.uid, Math.floor(s.price * 0.95))
      }
      const name = getItemNameById(s.goodsId)
      const quality = getQualityLabel(s.goodsId)
      const qualityStr = quality ? `[${quality}]` : ''
      return `✅ 购买成功，花费 ${s.price} 灵石，获得 ${qualityStr}「${name}」×${s.goodsNum}`
    })

  ctx.command('坊市上架 <name:string> <price:number>', '上架（价格最低 1 灵石，小数部分舍去）')
    .action(async ({ session }, name, price) => {
      if (!name || !price) return '格式：坊市上架 [物品名称] [价格]'
      const p = await requirePlayer(ctx, session)
      const found = await findItemInBackpack(ctx, p.uid, name)
      if (!found) return '背包中没有该物品'
      const [idStr] = found
      const goodsId = Number(idStr)
      const finalPrice = parsePrice(price)
      if (finalPrice === null) return '价格无效（最低 1 灵石，小数部分会被舍去）'

      const { reserved, sellable } = await sellableCount(ctx, p.uid, goodsId)
      if (sellable < 1) {
        return reserved ? `「${name}」正在装备中，请先「卸下」再上架` : '数量不足'
      }
      if (!(await removeItem(ctx, p.uid, goodsId, 1))) return '数量不足'

      // 手动分配 ID
      const id = await getNextId(ctx, TABLE.shop, 'id')
      await ctx.database.create(TABLE.shop, {
        id,
        sellerUid: p.uid, sellerName: p.userName,
        goodsId, price: finalPrice,
        goodsNum: 1, createTime: new Date(),
      })
      return `🏪 「${name}」已上架，价格 ${finalPrice} 灵石`
    })

  ctx.command('坊市下架 <no:number>', '下架')
    .action(async ({ session }, no) => {
      if (no === undefined || no === null) return '请输入编号'
      const p = await requirePlayer(ctx, session)
      const rows = await ctx.database.get(TABLE.shop, { id: Number(no) })
      if (!rows[0]) return '不存在'
      const s = rows[0]
      if (s.sellerUid !== p.uid) return '这不是你的商品，无法下架'
      // 先删除挂单作为占用：只有真正删除成功才退还物品
      if (!(await claimByRemove(ctx, TABLE.shop, { id: s.id, sellerUid: p.uid }))) return '商品已被购买或下架'
      await addItem(ctx, p.uid, s.goodsId, s.goodsNum)
      return '✅ 已下架'
    })

  ctx.command('系统坊市上架 <name:string> <price:number>', '管理员上架（价格最低 1 灵石，小数部分舍去）', { authority: 5 })
    .action(async (_, name, price) => {
      if (!name) return '请输入物品名称'
      const found = findItemByName(name)
      if (!found) return '物品不存在'
      const [idStr] = found

      const finalPrice = parsePrice(price)
      if (finalPrice === null) return '价格无效（最低 1 灵石，小数部分会被舍去）'

      const id = await getNextId(ctx, TABLE.shop, 'id')
      await ctx.database.create(TABLE.shop, {
        id,
        sellerUid: 0, sellerName: '系统',
        goodsId: Number(idStr), price: finalPrice,
        goodsNum: 1, createTime: new Date(),
      })
      return `✅ 系统已上架「${name}」，价格 ${finalPrice} 灵石`
    })

  // ===== 系统回收（玩家将背包物品按半价卖给系统） =====
  ctx.command('系统回收 <name:string> [count:number]', '按半价向系统出售背包物品（装备中的物品不可回收）')
    .action(async ({ session }, name, count = 1) => {
      if (!name) return '请输入要回收的物品名称'
      const p = await requirePlayer(ctx, session)

      const found = await findItemInBackpack(ctx, p.uid, name)
      if (!found) return '背包中没有该物品'
      const [idStr, meta] = found
      const goodsId = parseInt(idStr, 10)

      const actualCount = Math.max(1, Math.floor(Number(count) || 1))

      // 检查背包数量（装备中的那 1 件保留，不可回收）
      const { owned, reserved, sellable } = await sellableCount(ctx, p.uid, goodsId)
      if (sellable < actualCount) {
        const equipNote = reserved ? `，其中 1 件装备中不可回收` : ''
        return `背包中「${meta.name}」可回收数量不足（持有 ${owned}${equipNote}，需 ${actualCount}）`
      }

      // 半价回收
      const unitPrice = Math.max(1, Math.floor(estimatePrice(goodsId) / 2))
      const totalPrice = unitPrice * actualCount

      if (!(await removeItem(ctx, p.uid, goodsId, actualCount))) {
        return '回收失败，请稍后重试'
      }
      await addStone(ctx, p.uid, totalPrice)

      const quality = getQualityLabel(goodsId)
      const qualityStr = quality ? `[${quality}]` : ''
      return `♻️ 系统回收 ${qualityStr}「${meta.name}」×${actualCount}\n💎 获得 ${totalPrice} 灵石（单价 ${unitPrice}）`
    })
}
