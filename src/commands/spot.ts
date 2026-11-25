import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import {
  requirePlayer, costStone, addItem, removeItem, getOrCreateBuff,
  getQiFlagBonus,
  formatRemainTime,
  getQualityLabel,
  sendSegments,
  formatCompact,
  getAffectedRows,
  parseAmount,
} from '../utils'

const PLOT_COST = (idx: number) => 1_000_000 * Math.pow(2, idx - 2)
const SPOT_LEVEL_COST = (lv: number) => 500_000 * Math.pow(2, lv)

/** 指定了具体数量却没种够时的补充说明（all 种满或耗尽属预期，不提示） */
function stopNote(want: number, done: number, freePlots: number, held: number): string {
  if (!Number.isFinite(want) || done >= want) return ''
  if (freePlots <= held && freePlots < want) return `\n灵田已种满，剩余 ${want - done} 株未种`
  return '\n药材已耗尽'
}

export function registerSpotCommands(ctx: Context) {
  ctx.command('洞府帮助', '洞天指令').action(() => [
    '开辟洞府 [名称]   灵气升级   开垦灵田',
    '灵田种植 [药材] [数量|all]，数量默认 1，填 all 则种满或药材耗尽',
    '灵田收获 [编号]   查看灵田',
    '洞府信息   洞府改名 [名称]'
  ].join('\n'))

  ctx.command('开辟洞府 [name:string]', '开辟个人洞府').alias('洞府开辟')
    .action(async ({ session }, name) => {
      const p = await requirePlayer(ctx, session)
      if (p.blessedSpotFlag) return '你已开辟洞府'
      const need = 1_000_000
      if (!(await costStone(ctx, p.uid, need))) return `开辟洞府需 ${formatCompact(need)} 灵石`
      const spotName = name || `${p.userName}的洞府`
      await ctx.database.set(TABLE.player, { uid: p.uid }, {
        blessedSpotFlag: 1, blessedSpotName: spotName, plotCount: 1,
      })
      // 创建第 1 块灵田
      await ctx.database.upsert(TABLE.plot, [{
        uid: p.uid, plotIndex: 1, plantId: 0, plantAt: new Date(0), plantMinutes: 0,
      }], ['uid', 'plotIndex'])
      return `🏞️ 洞府「${spotName}」开辟成功，赠送灵田 ×1`
    })

  ctx.command('灵气升级', '升级洞府灵气').alias('洞府升级')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'
      const buff = await getOrCreateBuff(ctx, p.uid)
      if (buff.blessedSpot >= 5) return '灵气已达 5 级'
      const cost = SPOT_LEVEL_COST(buff.blessedSpot + 1)
      if (!(await costStone(ctx, p.uid, cost))) return `需 ${formatCompact(cost)} 灵石`
      await ctx.database.set(TABLE.buff, { uid: p.uid }, { blessedSpot: buff.blessedSpot + 1 })
      return `🏞️ 灵气升级至 ${buff.blessedSpot + 1} 级（闭关修为 +${(buff.blessedSpot + 1) * 5}%，灵田产量 +${(buff.blessedSpot + 1) * 50}%）`
    })

  ctx.command('开垦灵田', '扩建灵田').alias('洞府开垦')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'
      if (p.plotCount >= 999) return '灵田已达上限'
      const cost = PLOT_COST(p.plotCount + 1)
      if (!(await costStone(ctx, p.uid, cost))) return `需 ${formatCompact(cost)} 灵石`
      const nextIdx = p.plotCount + 1
      await ctx.database.set(TABLE.player, { uid: p.uid }, { plotCount: nextIdx })
      await ctx.database.upsert(TABLE.plot, [{
        uid: p.uid, plotIndex: nextIdx, plantId: 0, plantAt: new Date(0), plantMinutes: 0,
      }], ['uid', 'plotIndex'])
      return `🌾 灵田扩建成功，当前 ${nextIdx} 块`
    })

  // ================= 灵田种植 =================
  ctx.command('灵田种植 [herb:string] [amount:string]', '种植，数量默认 1，填 all 则种满或药材耗尽').alias('洞府种植')
    .action(async ({ session }, herb, rawAmount) => {
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'

      if (!herb) {
        const items = await ctx.database.get(TABLE.back, { uid: p.uid })
        const herbs = items.filter(i => !!data.herbs[String(i.goodsId)])
        if (!herbs.length) return '背包里没有可种植的药材'

        // 按阶数 1~3 / 4~6 / 7~9 分为三组（与背包药材分段一致），组内按阶数、ID 升序
        const groups: Array<typeof herbs> = [[], [], []]
        const sorted = [...herbs].sort((a, b) =>
          (data.herbs[String(a.goodsId)].tier - data.herbs[String(b.goodsId)].tier) || (a.goodsId - b.goodsId))
        for (const i of sorted) {
          const g = Math.min(2, Math.max(0, Math.floor(((Number(data.herbs[String(i.goodsId)].tier) || 1) - 1) / 3)))
          groups[g].push(i)
        }
        const nonEmpty = groups.map((items, g) => ({ items, g })).filter(x => x.items.length)

        const segments = nonEmpty.map(({ items, g }) => {
          // 格式化每个药材：带品阶 + 名称 + 数量，每行显示两个
          const formatted = items.map(i => {
            const quality = getQualityLabel(i.goodsId) // 返回如 "1 阶药材"
            const qStr = quality ? `[${quality}] ` : ''
            return `${qStr}${data.herbs[String(i.goodsId)].name}×${i.goodsNum}`
          })
          const lines: string[] = []
          for (let k = 0; k < formatted.length; k += 2) lines.push(formatted.slice(k, k + 2).join('  ｜  '))
          const head = nonEmpty.length > 1
            ? `🌱 背包可种植药材（第 ${nonEmpty.findIndex(x => x.g === g) + 1}/${nonEmpty.length} 段｜${g * 3 + 1}~${g * 3 + 3} 阶）`
            : '🌱 背包可种植药材：'
          return head + '\n' + lines.join('\n')
        })
        await sendSegments(session, segments)
        return
      }

      const entry = Object.entries(data.herbs).find(([, v]: any) => v.name === herb)
      if (!entry) return '未找到该药材'
      const [herbId, herbData]: any = entry
      // 数量：未输入默认 1；all/ALL 为尽可能多
      const want = rawAmount === undefined || String(rawAmount).trim() === '' ? 1 : parseAmount(rawAmount)
      if (want === null) return '请输入数量或all'

      const plots = (await ctx.database.get(TABLE.plot, { uid: p.uid, plantId: 0 }))
        .sort((a, b) => a.plotIndex - b.plotIndex)
      if (!plots.length) return '没有空闲灵田'
      const [held] = await ctx.database.get(TABLE.back, { uid: p.uid, goodsId: Number(herbId) })
      if (!held || held.goodsNum <= 0) return '背包中没有该药材'

      // 实际种植数 = min(想种数量, 空闲灵田数, 持有量)
      const n = Math.min(want, plots.length, held.goodsNum)
      if (!(await removeItem(ctx, p.uid, Number(herbId), n))) return '背包中没有该药材'

      const qiBonus = await getQiFlagBonus(ctx, p.uid)
      const baseMinutes = herbData.tier * 30
      const minutes = Math.max(1, Math.floor(baseMinutes * qiBonus.herbTimeMul))
      const plantAt = new Date()

      // 依序条件写入（plantId 仍为 0 才种下）；并发被占用的灵田跳过并顺延到下一块空闲灵田，
      // 直到种够 n 株或没有空闲灵田为止，最后退还未种下的药材
      const planted: number[] = []
      for (const plot of plots) {
        if (planted.length >= n) break
        const res = await ctx.database.set(TABLE.plot, { uid: p.uid, plotIndex: plot.plotIndex, plantId: 0 }, {
          plantId: Number(herbId), plantAt, plantMinutes: minutes,
        })
        if (getAffectedRows(res) !== 0) planted.push(plot.plotIndex)
      }
      const refund = n - planted.length
      if (refund > 0) await addItem(ctx, p.uid, Number(herbId), refund)
      if (!planted.length) return '灵田状态已变化，请重试'

      const flagNote = qiBonus.herbTimeMul < 1
        ? `（聚灵旗加速，原需 ${baseMinutes} 分钟）`
        : ''
      const tail = (refund > 0 ? `\n无空闲灵田，剩余 ${refund} 份药材已退回背包` : '') +
        stopNote(want, planted.length + refund, plots.length, held.goodsNum)
      if (planted.length === 1) {
        return `🌱 已在灵田 #${planted[0]} 种植「${herb}」（${minutes} 分钟后成熟${flagNote}）` + tail
      }
      const contiguous = planted.every((v, i) => i === 0 || v === planted[i - 1] + 1)
      const where = contiguous
        ? `#${planted[0]} ~ #${planted[planted.length - 1]}`
        : planted.slice(0, 5).map(v => `#${v}`).join('、') + (planted.length > 5 ? ' 等' : '')
      return `🌱 已种植「${herb}」×${planted.length}（灵田 ${where}，${minutes} 分钟后成熟${flagNote}）` + tail
    })

  // ================= 灵田收获 =================
  // ✅ 内存锁：防止玩家并发连点导致同一块地被重复收获
  const harvestLock = new Set<number>()

  ctx.command('灵田收获 [no:number]', '收获').alias('洞府收获')
    .action(async ({ session }, no) => {
      const p = await requirePlayer(ctx, session)

      // ✅ 检查并上锁
      if (harvestLock.has(p.uid)) return '⏳ 正在收获中，请勿频繁操作'
      harvestLock.add(p.uid)

      try {
        const rows = no
          ? await ctx.database.get(TABLE.plot, { uid: p.uid, plotIndex: no })
          : await ctx.database.get(TABLE.plot, { uid: p.uid })
        const mature = rows.filter(r => r.plantId > 0 && Date.now() - +new Date(r.plantAt) >= r.plantMinutes * 60000)

        if (!mature.length) return '没有成熟灵田'

        const buff = await getOrCreateBuff(ctx, p.uid)
        // 每级增加 50%（0.5倍）产量
        const bonus = 1 + buff.blessedSpot * 0.5
        let total = 0
        for (const m of mature) {
          // 先计算总量，最后四舍五入
          const qty = Math.round((1 + Math.random() * 2) * bonus)
          await addItem(ctx, p.uid, m.plantId, qty)
          await ctx.database.set(TABLE.plot, { uid: p.uid, plotIndex: m.plotIndex }, {
            plantId: 0, plantAt: new Date(0), plantMinutes: 0,
          })
          total += qty
        }
        return `🌾 收获 ${mature.length} 块灵田，共获得 ${total} 份药材`
      } finally {
        // ✅ 无论成功还是失败，必须解锁
        harvestLock.delete(p.uid)
      }
    })

  ctx.command('查看灵田', '查看灵田')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const rows = await ctx.database.get(TABLE.plot, { uid: p.uid })
      if (!rows.length) return '尚未开垦灵田'
      return rows.map(r => {
        if (!r.plantId) return `#${r.plotIndex}：空闲`
        const herb = (data.herbs as any)[r.plantId]?.name ?? r.plantId
        const remainMs = Math.max(0, r.plantMinutes * 60000 - (Date.now() - +new Date(r.plantAt)))
        return `#${r.plotIndex}：${herb}${remainMs <= 0 ? '（已成熟）' : `（剩 ${formatRemainTime(remainMs)}）`}`
      }).join('\n')
    })

  ctx.command('洞府信息', '查看洞府').alias('我的洞府')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.blessedSpotFlag) return '尚未开辟洞府'
      const buff = await getOrCreateBuff(ctx, p.uid)
      const plots = await ctx.database.get(TABLE.plot, { uid: p.uid })
      const qiBonus = await getQiFlagBonus(ctx, p.uid)
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
      await ctx.database.set(TABLE.player, { uid: p.uid }, { blessedSpotName: name })
      return `🏞️ 洞府已改名为「${name}」`
    })
}