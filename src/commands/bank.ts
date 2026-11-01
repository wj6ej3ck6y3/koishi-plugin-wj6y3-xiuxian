import { Context } from 'koishi'
import { TABLE } from '../models'
import { requirePlayer, getStone, addStone, costStone } from '../utils'

const LEVELS = [
  { lv: 1, cap: 1_000_000, ratePerHour: 0.001, upFee: 0 },
  { lv: 2, cap: 5_000_000, ratePerHour: 0.002, upFee: 100_000 },
  { lv: 3, cap: 10_000_000, ratePerHour: 0.003, upFee: 500_000 },
  { lv: 4, cap: 50_000_000, ratePerHour: 0.005, upFee: 2_000_000 },
  { lv: 5, cap: 100_000_000, ratePerHour: 0.008, upFee: 10_000_000 },
  { lv: 6, cap: 500_000_000, ratePerHour: 0.01, upFee: 50_000_000 },
  { lv: 7, cap: 2_000_000_000, ratePerHour: 0.015, upFee: 200_000_000 },
]

export function registerBankCommands(ctx: Context) {
  ctx.command('灵庄帮助', '灵庄帮助')
    .action(async () => [
      '灵庄存灵石 [数量]  灵庄取灵石 [数量]',
      '灵庄结算  灵庄升级  灵庄信息',
    ].join('\n'))

  async function load(ctx: Context, userId: string) {
    const rows = await ctx.database.get(TABLE.bank, { userId })
    if (rows[0]) return rows[0]
    const row = { userId, saveStone: 0, saveTime: new Date(), bankLevel: 1 }
    await ctx.database.create(TABLE.bank, row)
    return row
  }

  async function settle(ctx: Context, p: any, bank: any) {
    if (bank.saveStone <= 0) return { total: 0, banked: 0, direct: 0 }
    const cfg = LEVELS[bank.bankLevel - 1] ?? LEVELS[0]
    const hours = (Date.now() - +new Date(bank.saveTime)) / 3600000
    const gain = Math.floor(bank.saveStone * cfg.ratePerHour * hours)
    if (gain <= 0) return { total: 0, banked: 0, direct: 0 }

    // ✅ 先填满灵庄，溢出部分直接给玩家
    const room = Math.max(0, cfg.cap - bank.saveStone)
    const banked = Math.min(gain, room)
    const direct = gain - banked

    bank.saveStone += banked
    bank.saveTime = new Date()
    await ctx.database.set(TABLE.bank, { userId: p.userId }, {
      saveStone: bank.saveStone,
      saveTime: bank.saveTime,
    })
    if (direct > 0) await addStone(ctx, p.uid, direct)

    return { total: gain, banked, direct }
  }

  ctx.command('灵庄存灵石 <amount:number>', '存灵石')
    .alias('存灵石').alias('存入灵石')
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0) return '请输入数量'
      const p = await requirePlayer(ctx, session)

      // 1. 输入校验：灵石不足直接截断（不结息，不进入主流程）
      const balance = await getStone(ctx, p.uid)
      if (balance < amount) {
        return `⚠️ 灵石不足（当前 ${balance}，需 ${amount}）`
      }

      const bank = await load(ctx, p.userId)
      const cfg = LEVELS[bank.bankLevel - 1]

      // 2. 主流程：算能存多少 → 扣款存入 → 结息
      const room = Math.max(0, cfg.cap - bank.saveStone)
      const actualDeposit = Math.min(amount, room)
      let deposited = 0
      if (actualDeposit > 0 && await costStone(ctx, p.uid, actualDeposit)) {
        deposited = actualDeposit
        bank.saveStone += deposited
        await ctx.database.set(TABLE.bank, { userId: p.userId }, { saveStone: bank.saveStone })
      }

      // 3. 无论存多少都结息
      const s = await settle(ctx, p, bank)

      // 4. 输出（按 deposited === amount 分两路）
      const lines: string[] = []
      if (s.total > 0) {
        lines.push(`💹 结算利息 +${s.total}`)
        if (s.direct > 0) {
          lines.push(`  · 存入灵庄 +${s.banked}（已达上限 ${cfg.cap}）`)
          lines.push(`  · 直接到账 +${s.direct}`)
        } else {
          lines.push(`  · 全部存入灵庄 +${s.banked}`)
        }
      }

      if (deposited === amount) {
        lines.push(`🏦 存入 ${amount} 灵石`)
      } else {
        if (deposited > 0) lines.push(`🏦 存入 ${deposited} 灵石`)
        lines.push(`↩️ ${amount - deposited} 灵石未存入`)
      }
      lines.push(`当前存款 ${bank.saveStone} / ${cfg.cap}`)

      return lines.join('\n')
    })

  ctx.command('灵庄取灵石 <amount:number>', '取灵石')
    .alias('取灵石').alias('取出灵石')
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0) return '请输入数量'
      const p = await requirePlayer(ctx, session)
      const bank = await load(ctx, p.userId)
      const cfg = LEVELS[bank.bankLevel - 1] ?? LEVELS[0]

      // ✅ 先结息（saveTime 重置、利息落账或直接到账）
      const s = await settle(ctx, p, bank)

      // 结息展示：无论后续取出成功与否都展示，避免玩家误以为利息被吞
      const settleLines: string[] = []
      if (s.total > 0) {
        settleLines.push(`💹 结算利息 +${s.total}`)
        if (s.direct > 0) {
          settleLines.push(`  · 存入灵庄 +${s.banked}（已达上限 ${cfg.cap}）`)
          settleLines.push(`  · 直接到账 +${s.direct}`)
        } else {
          settleLines.push(`  · 全部存入灵庄 +${s.banked}`)
        }
      }

      // ✅ 再取出（此时 bank.saveStone 已含最新结息）
      if (bank.saveStone < amount) {
        return [...settleLines, `⚠️ 存款不足（当前 ${bank.saveStone}，需 ${amount}）`].join('\n')
      }

      bank.saveStone -= amount
      await addStone(ctx, p.uid, amount)
      await ctx.database.set(TABLE.bank, { userId: p.userId }, { saveStone: bank.saveStone })

      return [
        ...settleLines,
        `🏦 取出 ${amount} 灵石`,
        `当前存款 ${bank.saveStone} / ${cfg.cap}`,
      ].join('\n')
    })

  ctx.command('灵庄结算', '结算利息')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const bank = await load(ctx, p.userId)
      const cfg = LEVELS[bank.bankLevel - 1] ?? LEVELS[0]
      const s = await settle(ctx, p, bank)

      if (s.total === 0) return `🏦 当前存款 ${bank.saveStone}，本次无利息`

      const lines = [`🏦 本次利息 +${s.total}`]
      if (s.direct > 0) {
        lines.push(`  · 存入灵庄 +${s.banked}（已达上限 ${cfg.cap}）`)
        lines.push(`  · 灵石直接到账 +${s.direct}`)
      } else {
        lines.push(`  · 全部存入灵庄 +${s.banked}`)
      }
      lines.push(`当前存款 ${bank.saveStone} / ${cfg.cap}`)
      return lines.join('\n')
    })

  ctx.command('灵庄升级', '升级')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const bank = await load(ctx, p.userId)
      const next = LEVELS[bank.bankLevel]
      if (!next) return '已是最高等级'
      if (!(await costStone(ctx, p.uid, next.upFee))) return `需 ${next.upFee} 灵石`
      await ctx.database.set(TABLE.bank, { userId: p.userId }, { bankLevel: next.lv })
      return `🏦 灵庄升级至 ${next.lv} 级（上限 ${next.cap}，时息 ${next.ratePerHour * 100}%）`
    })

  ctx.command('灵庄信息', '查询存款信息').alias('查看灵庄').alias('灵庄')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const bank = await load(ctx, p.userId)
      const cfg = LEVELS[bank.bankLevel - 1]
      const next = LEVELS[bank.bankLevel]
      return [
        `🏦 灵庄等级：${bank.bankLevel} 级`,
        `存款：${bank.saveStone} / ${cfg.cap}`,
        `时息：${cfg.ratePerHour * 100}%`,
        next ? `升级费用：${next.upFee}` : '已是最高级',
      ].join('\n')
    })
}