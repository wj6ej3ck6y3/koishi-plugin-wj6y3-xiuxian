import { Context } from 'koishi'
import { TABLE } from '../models'
import { requirePlayer, addStone, costStone, addItem, removeItem, getItemNameById, getNextId, getQualityLabel, ALL_ITEM_TABLES, estimatePrice, findItemInBackpack } from '../utils'
import { findItemByName } from './backpack'

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
      if (!(await costStone(ctx, p.uid, s.price))) return '灵石不足'
      await addItem(ctx, p.userId, s.goodsId, s.goodsNum)
      // 卖家到账
      if (s.sellerId !== '0') {
        const seller = await ctx.database.get(TABLE.player, { userId: s.sellerId })
        if (seller[0]) await addStone(ctx, seller[0].uid, Math.floor(s.price * 0.95))
      }
      await ctx.database.remove(TABLE.shop, { id: s.id })
      const name = getItemNameById(s.goodsId)
      const quality = getQualityLabel(s.goodsId)
      const qualityStr = quality ? `[${quality}]` : ''
      return `✅ 购买成功，花费 ${s.price} 灵石，获得 ${qualityStr}「${name}」×${s.goodsNum}`
    })

  ctx.command('坊市上架 <name:string> <price:number>', '上架')
    .action(async ({ session }, name, price) => {
      if (!name || !price) return '格式：坊市上架 [物品名称] [价格]'
      const p = await requirePlayer(ctx, session)
      const found = await findItemInBackpack(ctx, p.userId, name)
      if (!found) return '背包中没有该物品'
      const [idStr] = found
      const pNum = Number(price)
      if (!Number.isFinite(pNum) || pNum <= 0) return '价格无效'
      const finalPrice = Math.floor(pNum)
      if (!(await removeItem(ctx, p.userId, Number(idStr), 1))) return '数量不足'

      // 手动分配 ID
      const id = await getNextId(ctx, TABLE.shop, 'id')
      await ctx.database.create(TABLE.shop, {
        id,
        sellerId: p.userId, sellerName: p.userName,
        goodsId: Number(idStr), price: finalPrice,
        goodsNum: 1, createTime: new Date(),
      })
      return `🏪 「${name}」已上架，价格 ${price} 灵石`
    })

  ctx.command('坊市下架 <no:number>', '下架')
    .action(async ({ session }, no) => {
      if (no === undefined || no === null) return '请输入编号'
      const p = await requirePlayer(ctx, session)
      const rows = await ctx.database.get(TABLE.shop, { id: Number(no) })
      if (!rows[0]) return '不存在'
      const s = rows[0]
      if (s.sellerId !== p.userId) return '这不是你的商品，无法下架'
      await addItem(ctx, p.userId, s.goodsId, s.goodsNum)
      await ctx.database.remove(TABLE.shop, { id: s.id })
      return '✅ 已下架'
    })

  ctx.command('系统坊市上架 <name:string> <price:number>', '管理员上架')
    .action(async ({ session }, name, price) => {
      const found = findItemByName(name)
      if (!found) return '物品不存在'
      const [idStr] = found

      const pNum = Number(price)
      if (!Number.isFinite(pNum) || pNum <= 0) return '价格无效'

      const id = await getNextId(ctx, TABLE.shop, 'id')
      await ctx.database.create(TABLE.shop, {
        id,
        sellerId: '0', sellerName: '系统',
        goodsId: Number(idStr), price: Math.floor(pNum),
        goodsNum: 1, createTime: new Date(),
      })
      return '✅ 系统已上架'
    })

  // ===== 系统回收（玩家将背包物品按半价卖给系统） =====
  ctx.command('系统回收 <name:string> [count:number]', '按半价向系统出售背包物品')
    .action(async ({ session }, name, count = 1) => {
      if (!name) return '请输入要回收的物品名称'
      const p = await requirePlayer(ctx, session)

      const found = await findItemInBackpack(ctx, p.userId, name)
      if (!found) return '背包中没有该物品'
      const [idStr, meta] = found
      const goodsId = parseInt(idStr, 10)

      const actualCount = Math.max(1, Math.floor(Number(count) || 1))

      // 检查背包数量
      const rows = await ctx.database.get(TABLE.back, { userId: p.userId, goodsId })
      const owned = rows[0]?.goodsNum ?? 0
      if (owned < actualCount) {
        return `背包中「${meta.name}」数量不足（持有 ${owned}，需 ${actualCount}）`
      }

      // 半价回收
      const unitPrice = Math.max(1, Math.floor(estimatePrice(goodsId) / 2))
      const totalPrice = unitPrice * actualCount

      if (!(await removeItem(ctx, p.userId, goodsId, actualCount))) {
        return '回收失败，请稍后重试'
      }
      await addStone(ctx, p.uid, totalPrice)

      const quality = getQualityLabel(goodsId)
      const qualityStr = quality ? `[${quality}]` : ''
      return `♻️ 系统回收 ${qualityStr}「${meta.name}」×${actualCount}\n💎 获得 ${totalPrice} 灵石（单价 ${unitPrice}）`
    })
}