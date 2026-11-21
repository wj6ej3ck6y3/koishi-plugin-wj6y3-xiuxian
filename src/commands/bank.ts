import { $, Context } from 'koishi'
import { TABLE, BankRow } from '../models'
import { requirePlayer, getStone, addStone, costStone, getAffectedRows, formatCompact } from '../utils'

const LEVELS = [
  { lv: 1, cap: 1_000_000, ratePerHour: 0.001, upFee: 0 },
  { lv: 2, cap: 5_000_000, ratePerHour: 0.002, upFee: 100_000 },
  { lv: 3, cap: 10_000_000, ratePerHour: 0.003, upFee: 500_000 },
  { lv: 4, cap: 50_000_000, ratePerHour: 0.005, upFee: 2_000_000 },
  { lv: 5, cap: 100_000_000, ratePerHour: 0.008, upFee: 10_000_000 },
  { lv: 6, cap: 500_000_000, ratePerHour: 0.01, upFee: 50_000_000 },
  { lv: 7, cap: 2_000_000_000, ratePerHour: 0.015, upFee: 200_000_000 },
]

interface SettleResult { total: number; banked: number; direct: number }

function levelOf(bank: BankRow) {
  return LEVELS[bank.bankLevel - 1] ?? LEVELS[0]
}

/** 结息结果的说明文字（存灵石 / 取灵石 / 结算 / 升级共用） */
function formatInterestLines(s: SettleResult, cap: number, header = `💹 结算利息 +${formatCompact(s.total)}`): string[] {
  if (s.total <= 0) return []
  const lines = [header]
  if (s.direct > 0) {
    lines.push(`  · 存入灵庄 +${formatCompact(s.banked)}（已达上限 ${formatCompact(cap)}）`)
    lines.push(`  · 直接到账 +${formatCompact(s.direct)}`)
  } else {
    lines.push(`  · 全部存入灵庄 +${formatCompact(s.banked)}`)
  }
  return lines
}

export function registerBankCommands(ctx: Context) {
  ctx.command('灵庄帮助', '灵庄帮助')
    .action(async () => [
      '灵庄存灵石 <数量>  灵庄取灵石 <数量>',
      '灵庄结算  灵庄升级  灵庄信息',
    ].join('\n'))

  // ✅ B7：load 包 try/catch，并发 create 冲突时重读
  async function load(ctx: Context, uid: number): Promise<BankRow> {
    const rows = await ctx.database.get(TABLE.bank, { uid })
    if (rows[0]) return rows[0]
    const row: BankRow = { uid, saveStone: 0, saveTime: new Date(), bankLevel: 1 }
    try {
      await ctx.database.create(TABLE.bank, row)
      return row
    } catch {
      // 并发下可能已被其他请求创建
      const again = await ctx.database.get(TABLE.bank, { uid })
      if (again[0]) return again[0]
      throw new Error('灵庄数据创建失败')
    }
  }

  /**
   * 结息：以「saveTime 仍为读取时的值」作为条件更新（签到的写法），保证同一段时间只结息一次；
   * 存款以 $.add 原子累加，溢出上限的利息直接发到灵石。成功时同步更新传入的 bank 对象。
   */
  async function settle(ctx: Context, uid: number, bank: BankRow): Promise<SettleResult> {
    const none = { total: 0, banked: 0, direct: 0 }
    if (bank.saveStone <= 0) return none
    const cfg = levelOf(bank)
    const hours = (Date.now() - +new Date(bank.saveTime)) / 3600000
    const gain = Math.floor(bank.saveStone * cfg.ratePerHour * hours)
    if (gain <= 0) return none

    // 先填满灵庄，溢出部分直接给玩家
    const room = Math.max(0, cfg.cap - bank.saveStone)
    const banked = Math.min(gain, room)
    const direct = gain - banked

    const newTime = new Date()
    const res = await ctx.database.set(TABLE.bank, { uid, saveTime: bank.saveTime }, row => ({
      saveStone: $.add(row.saveStone, banked),
      saveTime: newTime,
    }))
    if (getAffectedRows(res) === 0) return none // 已被其他请求结算

    bank.saveStone += banked
    bank.saveTime = newTime
    if (direct > 0) await addStone(ctx, uid, direct)

    return { total: gain, banked, direct }
  }

  // ✅ B1：先按原始存款算利息 → 再存入 → 再区分利息能存多少
  ctx.command('灵庄存灵石 <amount:number>', '存灵石')
    .alias('存灵石').alias('存入灵石')
    .action(async ({ session }, rawAmount) => {
      const amount = Math.floor(Number(rawAmount))
      if (!amount || amount <= 0) return '请输入数量'
      const p = await requirePlayer(ctx, session)

      const balance = await getStone(ctx, p.uid)
      if (balance < amount) {
        return `⚠️ 灵石不足（当前 ${formatCompact(balance)}，需 ${formatCompact(amount)}）`
      }

      const bank = await load(ctx, p.uid)
      const cfg = levelOf(bank)

      // ① 用「原始存款」计算本次利息（新存入不参与这段计息）
      const oldSave = bank.saveStone
      const hours = (Date.now() - +new Date(bank.saveTime)) / 3600000
      const gain = oldSave > 0 ? Math.floor(oldSave * cfg.ratePerHour * hours) : 0

      // ② 存入（room 基于原始存款，利息尚未入账）
      const depositRoom = Math.max(0, cfg.cap - oldSave)
      const actualDeposit = Math.min(amount, depositRoom)
      let deposited = 0
      if (actualDeposit > 0 && await costStone(ctx, p.uid, actualDeposit)) {
        deposited = actualDeposit
      }

      // ③ 再处理利息：room 基于「存入后」的存款
      const saveAfterDeposit = oldSave + deposited
      const interestRoom = Math.max(0, cfg.cap - saveAfterDeposit)
      const banked = Math.min(gain, interestRoom)
      const direct = gain - banked

      // 以 saveTime 作为本次结息的占用条件，存款原子累加；若并发下已被结息，退还本次存入的灵石
      const newTime = new Date()
      const res = await ctx.database.set(TABLE.bank, { uid: p.uid, saveTime: bank.saveTime }, row => ({
        saveStone: $.add(row.saveStone, deposited + banked),
        saveTime: newTime,
      }))
      if (getAffectedRows(res) === 0) {
        if (deposited > 0) await addStone(ctx, p.uid, deposited)
        return '灵庄状态已变化，请重试'
      }
      bank.saveStone = saveAfterDeposit + banked
      if (direct > 0) await addStone(ctx, p.uid, direct)

      // ④ 输出
      const lines = formatInterestLines({ total: gain, banked, direct }, cfg.cap)

      if (deposited === amount) {
        lines.push(`🏦 存入 ${formatCompact(amount)} 灵石`)
      } else {
        if (deposited > 0) lines.push(`🏦 存入 ${formatCompact(deposited)} 灵石`)
        lines.push(`↩️ ${formatCompact(amount - deposited)} 灵石未存入`)
      }
      lines.push(`当前存款 ${formatCompact(bank.saveStone)} / ${formatCompact(cfg.cap)}`)

      return lines.join('\n')
    })

  ctx.command('灵庄取灵石 <amount:number>', '取灵石')
    .alias('取灵石').alias('取出灵石')
    .action(async ({ session }, rawAmount) => {
      const amount = Math.floor(Number(rawAmount))
      if (!amount || amount <= 0) return '请输入数量'
      const p = await requirePlayer(ctx, session)
      const bank = await load(ctx, p.uid)
      const cfg = levelOf(bank)

      const s = await settle(ctx, p.uid, bank)
      const settleLines = formatInterestLines(s, cfg.cap)

      // 条件扣减（签到的写法）：存款 ≥ amount 才扣减成功，成功后才发放灵石
      const res = await ctx.database.set(TABLE.bank, {
        uid: p.uid,
        saveStone: { $gte: amount },
      }, row => ({ saveStone: $.sub(row.saveStone, amount) }))
      if (getAffectedRows(res) === 0) {
        const [now] = await ctx.database.get(TABLE.bank, { uid: p.uid })
        return [...settleLines, `⚠️ 存款不足（当前 ${formatCompact(now?.saveStone ?? bank.saveStone)}，需 ${formatCompact(amount)}）`].join('\n')
      }
      await addStone(ctx, p.uid, amount)
      const [after] = await ctx.database.get(TABLE.bank, { uid: p.uid })

      return [
        ...settleLines,
        `🏦 取出 ${formatCompact(amount)} 灵石`,
        `当前存款 ${formatCompact(after?.saveStone ?? Math.max(0, bank.saveStone - amount))} / ${formatCompact(cfg.cap)}`,
      ].join('\n')
    })

  ctx.command('灵庄结算', '结算利息')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const bank = await load(ctx, p.uid)
      const cfg = levelOf(bank)
      const s = await settle(ctx, p.uid, bank)

      if (s.total === 0) return `🏦 当前存款 ${formatCompact(bank.saveStone)}，本次无利息`

      const lines = formatInterestLines(s, cfg.cap, `🏦 本次利息 +${formatCompact(s.total)}`)
      lines.push(`当前存款 ${formatCompact(bank.saveStone)} / ${formatCompact(cfg.cap)}`)
      return lines.join('\n')
    })

  // ✅ B7：升级用条件更新（bankLevel 仍是旧值才成功），并发冲突退还扣费
  ctx.command('灵庄升级', '升级')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const bank = await load(ctx, p.uid)
      const next = LEVELS[bank.bankLevel]
      if (!next) return '已是最高等级'
      if (!(await costStone(ctx, p.uid, next.upFee))) return `需 ${formatCompact(next.upFee)} 灵石`

      // 升级前先按旧等级结息，避免新利率追溯套用到之前的存款时间
      const cfg = levelOf(bank)
      const s = await settle(ctx, p.uid, bank)

      const writeRes = await ctx.database.set(TABLE.bank, {
        uid: p.uid,
        bankLevel: bank.bankLevel,
      }, { bankLevel: next.lv })

      const affected = getAffectedRows(writeRes)
      // ✅ 只有明确「0 行修改」才判定并发冲突；-1 视为成功
      if (affected === 0) {
        await addStone(ctx, p.uid, next.upFee)
        return [...formatInterestLines(s, cfg.cap), '灵庄状态已变化，请重试'].join('\n')
      }

      return [
        ...formatInterestLines(s, cfg.cap, `💹 升级前先按 ${cfg.lv} 级利率结息 +${formatCompact(s.total)}`),
        `🏦 灵庄升级至 ${next.lv} 级（上限 ${formatCompact(next.cap)}，时息 ${next.ratePerHour * 100}%）`,
      ].join('\n')
    })

  ctx.command('灵庄信息', '查询存款信息').alias('查看灵庄').alias('灵庄')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const bank = await load(ctx, p.uid)
      const cfg = levelOf(bank)
      const next = LEVELS[bank.bankLevel]
      return [
        `🏦 灵庄等级：${bank.bankLevel} 级`,
        `存款：${formatCompact(bank.saveStone)} / ${formatCompact(cfg.cap)}`,
        `时息：${cfg.ratePerHour * 100}%`,
        next ? `升级费用：${formatCompact(next.upFee)}` : '已是最高级',
      ].join('\n')
    })
}
