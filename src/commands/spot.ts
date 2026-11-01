import { Context } from 'koishi'
import { TABLE } from '../models'
import {
  requirePlayer, costStone, addItem, removeItem, getBuff,
  getQiFlagBonus,
  formatRemainTime,
  getQualityLabel
} from '../utils'

const PLOT_COST = (idx: number) => 1_000_000 * Math.pow(2, idx - 2)
const SPOT_LEVEL_COST = (lv: number) => 500_000 * Math.pow(2, lv)

export function registerSpotCommands(ctx: Context) {
  ctx.command('洞府帮助', '洞天指令').action(() =>[
    '开辟洞府 [名称]   灵气升级   开垦灵田',
    '灵田种植 [药材]   灵田收获 [编号]   查看灵田',
    '洞府信息   洞府改名 <名称>'
  ].join('\n'))

  ctx.command('开辟洞府 [name:string]', '开辟个人洞府').alias('洞府开辟')
    .action(async ({ session }, name) => {
      const p = await requirePlayer(ctx, session)
      if (p.blessedSpotFlag) return '你已开辟洞府'
      const need = 1_000_000
      if (!(await costStone(ctx, p.uid, need))) return `开辟洞府需 ${need} 灵石`
      const spotName = name || `${p.userName}的洞府`
      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        blessedSpotFlag: 1, blessedSpotName: spotName, plotCount: 1,
      })
      // 创建第 1 块灵田
      await ctx.database.upsert(TABLE.plot, [{
        userId: p.userId, plotIndex: 1, plantId: 0, plantAt: new Date(0), plantMinutes: 0,
      }], ['userId', 'plotIndex'])
      return `🏞️ 洞府「${spotName}」开辟成功，赠送灵田 ×1`
    })

  ctx.command('灵气升级', '升级洞府灵气').alias('洞府升级')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'
      const buff = await getBuff(ctx, p.userId)
      if (buff.blessedSpot >= 5) return '灵气已达 5 级'
      const cost = SPOT_LEVEL_COST(buff.blessedSpot + 1)
      if (!(await costStone(ctx, p.uid, cost))) return `需 ${cost} 灵石`
      await ctx.database.set(TABLE.buff, { userId: p.userId }, { blessedSpot: buff.blessedSpot + 1 })
      return `🏞️ 灵气升级至 ${buff.blessedSpot + 1} 级（闭关修为 +${(buff.blessedSpot + 1) * 5}%，灵田产量 +${(buff.blessedSpot + 1) * 50}%）`
    })

  ctx.command('开垦灵田', '扩建灵田').alias('洞府开垦')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'
      if (p.plotCount >= 999) return '灵田已达上限'
      const cost = PLOT_COST(p.plotCount + 1)
      if (!(await costStone(ctx, p.uid, cost))) return `需 ${cost} 灵石`
      const nextIdx = p.plotCount + 1
      await ctx.database.set(TABLE.player, { userId: p.userId }, { plotCount: nextIdx })
      await ctx.database.upsert(TABLE.plot, [{
        userId: p.userId, plotIndex: nextIdx, plantId: 0, plantAt: new Date(0), plantMinutes: 0,
      }], ['userId', 'plotIndex'])
      return `🌾 灵田扩建成功，当前 ${nextIdx} 块`
    })

  // ================= 灵田种植 =================
  ctx.command('灵田种植 [herb:string]', '种植').alias('洞府种植')
    .action(async ({ session }, herb) => {
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'

      const { data: _d } = await import('../data')

      if (!herb) {
        const items = await ctx.database.get(TABLE.back, { userId: p.userId })
        const herbs = items.filter(i => !!_d.herbs[String(i.goodsId)])
        if (!herbs.length) return '背包里没有可种植的药材'

        // 格式化每个药材：带品阶 + 名称 + 数量
        const formatted = herbs.map(i => {
          const herbData = _d.herbs[String(i.goodsId)]
          const quality = getQualityLabel(i.goodsId) // 返回如 "1 阶药材"
          const qStr = quality ? `[${quality}] ` : ''
          return `${qStr}${herbData.name}×${i.goodsNum}`
        })

        // 每行显示两个，用竖线或空格隔开
        const lines: string[] = []
        for (let i = 0; i < formatted.length; i += 2) {
          lines.push(formatted.slice(i, i + 2).join('  ｜  '))
        }

        return '🌱 背包可种植药材：\n' + lines.join('\n')
      }

      const entry = Object.entries(_d.herbs).find(([, v]: any) => v.name === herb)
      if (!entry) return '未找到该药材'
      const [herbId, herbData]: any = entry
      const plots = await ctx.database.get(TABLE.plot, { userId: p.userId, plantId: 0 })
      if (!plots.length) return '没有空闲灵田'
      if (!(await removeItem(ctx, p.userId, Number(herbId), 1))) return '背包中没有该药材'

      const qiBonus = await getQiFlagBonus(ctx, p.userId)
      const baseMinutes = herbData.tier * 30
      const minutes = Math.max(1, Math.floor(baseMinutes * qiBonus.herbTimeMul))

      await ctx.database.set(TABLE.plot, { userId: p.userId, plotIndex: plots[0].plotIndex }, {
        plantId: Number(herbId), plantAt: new Date(), plantMinutes: minutes,
      })
      const flagNote = qiBonus.herbTimeMul < 1
        ? `（聚灵旗加速，原需 ${baseMinutes} 分钟）`
        : ''
      return `🌱 已在灵田 #${plots[0].plotIndex} 种植「${herb}」（${minutes} 分钟后成熟${flagNote}）`
    })

  // ================= 灵田收获 =================
  // ✅ 内存锁：防止玩家并发连点导致同一块地被重复收获
  const harvestLock = new Set<string>()

  ctx.command('灵田收获 [no:number]', '收获').alias('洞府收获')
    .action(async ({ session }, no) => {
      const p = await requirePlayer(ctx, session)

      // ✅ 检查并上锁
      if (harvestLock.has(p.userId)) return '⏳ 正在收获中，请勿频繁操作'
      harvestLock.add(p.userId)

      try {
        const rows = no
          ? await ctx.database.get(TABLE.plot, { userId: p.userId, plotIndex: no })
          : await ctx.database.get(TABLE.plot, { userId: p.userId })
        const mature = rows.filter(r => r.plantId > 0 && Date.now() - +new Date(r.plantAt) >= r.plantMinutes * 60000)

        if (!mature.length) return '没有成熟灵田'

        const buff = await getBuff(ctx, p.userId)
        // 每级增加 50%（0.5倍）产量
        const bonus = 1 + buff.blessedSpot * 0.5
        let total = 0
        for (const m of mature) {
          // 先计算总量，最后四舍五入
          const qty = Math.round((1 + Math.random() * 2) * bonus)
          await addItem(ctx, p.userId, m.plantId, qty)
          await ctx.database.set(TABLE.plot, { userId: p.userId, plotIndex: m.plotIndex }, {
            plantId: 0, plantAt: new Date(0), plantMinutes: 0,
          })
          total += qty
        }
        return `🌾 收获 ${mature.length} 块灵田，共获得 ${total} 份药材`
      } finally {
        // ✅ 无论成功还是失败，必须解锁
        harvestLock.delete(p.userId)
      }
    })

  ctx.command('查看灵田', '查看灵田')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const rows = await ctx.database.get(TABLE.plot, { userId: p.userId })
      if (!rows.length) return '尚未开垦灵田'
      const { data: _d } = await import('../data')
      return rows.map(r => {
        if (!r.plantId) return `#${r.plotIndex}：空闲`
        const herb = (_d.herbs as any)[r.plantId]?.name ?? r.plantId
        const remainMs = Math.max(0, r.plantMinutes * 60000 - (Date.now() - +new Date(r.plantAt)))
        return `#${r.plotIndex}：${herb}${remainMs <= 0 ? '（已成熟）' : `（剩 ${formatRemainTime(remainMs)}）`}`
      }).join('\n')
    })

  ctx.command('洞府信息', '查看洞府').alias('我的洞府')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'
      const buff = await getBuff(ctx, p.userId)
      const plots = await ctx.database.get(TABLE.plot, { userId: p.userId })
      const qiBonus = await getQiFlagBonus(ctx, p.userId)
      const flagLine = qiBonus.name
        ? `聚灵旗：${qiBonus.name}（修为 ×${qiBonus.cultivateMul.toFixed(2)} / 灵田 ×${qiBonus.herbTimeMul.toFixed(2)}）`
        : '聚灵旗：无'
      return [
        `🏞️ ${p.blessedSpotName}`,
        `灵气等级：${buff.blessedSpot}`,
        flagLine,
        `灵田：${plots.length} 块（其中空闲 ${plots.filter(r => !r.plantId).length} 块）`,
      ].join('\n')
    })

  ctx.command('洞府改名 <name:string>', '改名').alias('重命名洞府')
    .action(async ({ session }, name) => {
      if (!name) return '请输入名称'
      if (name.length > 12) return '名称最多 12 字'
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'
      if (!(await costStone(ctx, p.uid, 10000))) return '需 10000 灵石'
      await ctx.database.set(TABLE.player, { userId: p.userId }, { blessedSpotName: name })
      return `🏞️ 洞府已改名为「${name}」`
    })
}