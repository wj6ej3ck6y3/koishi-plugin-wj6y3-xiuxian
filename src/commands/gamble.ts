import { Context } from 'koishi'
import {
  requirePlayer, getStone, addStone, costStone,
  computeStats, buildPlayerUnit, simulateBattle, refreshPlayerStats,
  recordBattle,
  formatRemainTime,
} from '../utils'
import { TABLE } from '../models'

// ================= 内存 CD（模块级，便于 B9 统一清理） =================
const gambleCd = new Map<string, number>()
const duelCd = new Map<string, number>()
const robCd = new Map<string, number>()

interface DuelState {
  challenger: string
  target: string
  amount: number
  bulletPos: number
  currentPos: number
  shooter: string
  ts: number
}
const duelPending = new Map<string, DuelState>()

const ROB_CD_MS = 5 * 60_000

/** ✅ B9：清理已过期的内存 CD，由 index.ts 每小时定时任务调用 */
export function cleanupGambleCds() {
  const now = Date.now()
  for (const [k, v] of gambleCd) if (v < now) gambleCd.delete(k)
  for (const [k, v] of robCd) if (v < now) robCd.delete(k)
  for (const [k, v] of duelCd) if (v < now) duelCd.delete(k)
  for (const [k, v] of duelPending) if (now - v.ts >= 60_000) duelPending.delete(k)
}

/** 询问下注金额，最多重试 maxRetry 次，成功返回金额，取消/超时返回 null */
async function askAmount(
  session: any, uid: number, balance: number, maxRetry = 3,
): Promise<number | null> {
  let hint = '🎲 请输入下注金额（最低 1 灵石，回复「取消」退出）：'
  for (let i = 0; i < maxRetry; i++) {
    await session.send(hint)

    let input = ''
    try {
      const raw = await session.prompt((s: any) => s.content, { timeout: 30000 } as any)
      input = raw == null ? '' : String(raw).trim()
      input = input.replace(/^[\/#\.]/, '').trim()
    } catch {
      return null
    }

    if (!input) return null
    if (input === '取消') return null

    const amount = parseInt(input, 10)
    if (!amount || amount <= 0) {
      hint = `❌ 最低下注 1 灵石，请重新输入（回复「取消」退出）：`
      continue
    }
    if (balance < amount) {
      hint = `❌ 灵石不足（当前 ${balance}），请重新输入（回复「取消」退出）：`
      continue
    }
    return amount
  }
  return null
}

/** 询问押大/押小，最多重试 maxRetry 次 */
async function askBet(
  session: any, maxRetry = 3,
): Promise<'大' | '小' | null> {
  let hint = '🎲 请押【大】或【小】（回复「取消」退出）：'
  for (let i = 0; i < maxRetry; i++) {
    await session.send(hint)

    let input = ''
    try {
      const raw = await session.prompt((s: any) => s.content, { timeout: 30000 } as any)
      input = raw == null ? '' : String(raw).trim()
      input = input.replace(/^[\/#\.]/, '').trim()
    } catch {
      return null
    }

    if (!input) return null
    if (input === '取消') return null
    if (input === '大' || input === '小') return input
    hint = '❌ 请输入「大」或「小」（回复「取消」退出）：'
  }
  return null
}

export function registerGambleCommands(ctx: Context) {
  ctx.command('金银阁', '掷骰赌灵石')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.uid === null) return '⚠️ 灵石服务未同步，请稍后重试或联系管理员'

      const now = Date.now()
      const cd = gambleCd.get(p.userId) || 0
      if (now < cd) return `冷却中，还需 ${formatRemainTime(cd - now)}`

      gambleCd.set(p.userId, now + 60_000)

      const balance = await getStone(ctx, p.uid)
      if (balance <= 0) {
        gambleCd.delete(p.userId)
        return `❌ 灵石不足（当前 ${balance} 灵石，最低下注 1）`
      }

      const amount = await askAmount(session, p.uid, balance)
      if (amount === null) {
        gambleCd.delete(p.userId)
        return '✅ 已取消下注'
      }

      const bet = await askBet(session)
      if (bet === null) {
        gambleCd.delete(p.userId)
        return '✅ 已取消下注'
      }

      if (!(await costStone(ctx, p.uid, amount))) {
        gambleCd.delete(p.userId)
        return '❌ 灵石不足'
      }

      const d1 = 1 + Math.floor(Math.random() * 6)
      const d2 = 1 + Math.floor(Math.random() * 6)
      const d3 = 1 + Math.floor(Math.random() * 6)
      const sum = d1 + d2 + d3
      const isTriple = d1 === d2 && d2 === d3

      let result: string
      if (isTriple) {
        result = `💀 豹子通杀！你输了 ${amount} 灵石`
      } else {
        const isBig = sum >= 11
        const actualName = isBig ? '大' : '小'
        const won = (bet === '大' && isBig) || (bet === '小' && !isBig)
        if (won) {
          const gain = Math.floor(amount * 1.9)
          await addStone(ctx, p.uid, gain)
          result = `🎉 ${actualName}，你赢了 ${gain - amount} 灵石（含本金 ${amount}）`
        } else {
          result = `💸 ${actualName}，你输了 ${amount} 灵石`
        }
      }

      gambleCd.set(p.userId, Date.now() + 30_000)
      return `🎲 ${d1} ${d2} ${d3} 和 ${sum}\n${result}`
    })

  // ===== 虚神界对决 =====
  ctx.command('虚神界对决 <amount:number>', 'PvP 左轮对决')
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0) return '请输入赌注'
      const p = await requirePlayer(ctx, session)
      const target = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
      if (!target) return '请 @ 对方'
      if (target === p.userId) return '不能与自己对决'
      if (p.uid === null) return '灵石服务未同步'
      if ((await getStone(ctx, p.uid)) < amount) return '灵石不足'

      const targetRows = await ctx.database.get(TABLE.player, { userId: target })
      if (!targetRows[0]) return '对方尚未踏入仙途，无法对决'

      const now = Date.now()
      for (const [k, v] of [...duelPending.entries()]) {
        if (now - v.ts >= 60_000) duelPending.delete(k)
      }
      const pending = [...duelPending.values()]

      if (pending.some(v => v.challenger === p.userId || v.target === p.userId)) {
        return '你已有进行中的对决邀请（发起或被邀请），请先处理'
      }
      if (pending.some(v => v.challenger === target || v.target === target)) {
        return '对方已有进行中的对决邀请，请稍后再试'
      }

      const cd = duelCd.get(p.userId) || 0
      if (now < cd) return `对决冷却中，还需 ${formatRemainTime(cd - now)}`

      const key = `${p.userId}-${target}`
      const startTs = now
      duelPending.set(key, {
        challenger: p.userId, target, amount,
        bulletPos: Math.floor(Math.random() * 6),
        currentPos: 0,
        shooter: p.userId,
        ts: startTs,
      })
      duelCd.set(p.userId, now + 60_000)
      setTimeout(() => {
        const cur = duelPending.get(key)
        if (cur && cur.ts === startTs) duelPending.delete(key)
      }, 60_000)
      return `🎲 向 ${target} 发起虚神界左轮对决（赌注 ${amount}）\n🔫 6 弹位随机装 1 发，先扣扳机者先，中弹者负\n请对方发送「接受对决」接受挑战（60 秒内），或发送「拒绝对决」拒绝`
    })

  ctx.command('接受对决', '接受 PvP')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.uid === null) return '灵石服务未同步'
      const entry = [...duelPending.entries()].find(([, v]) => v.target === p.userId && Date.now() - v.ts < 60_000)
      if (!entry) return '没有待接受的对决'
      const [key, v] = entry
      duelPending.delete(key)

      if (!(await costStone(ctx, p.uid, v.amount))) return '你灵石不足'
      const ch = await ctx.database.get(TABLE.player, { userId: v.challenger })
      if (!ch[0] || ch[0].uid === null || !(await costStone(ctx, ch[0].uid, v.amount))) {
        await addStone(ctx, p.uid, v.amount)
        return '发起者灵石不足，对决取消'
      }

      const log: string[] = []
      let pos = v.currentPos
      let shooter = v.shooter
      let loserId: string | null = null
      while (pos < 6) {
        const ch2 = await ctx.database.get(TABLE.player, { userId: shooter })
        const name = ch2[0]?.userName ?? shooter
        if (pos === v.bulletPos) {
          log.push(`💥 第 ${pos + 1} 发——子弹击中！${name} 输了！`)
          loserId = shooter
          break
        }
        log.push(`「咔嚓」——${name} 扣下第 ${pos + 1} 发，无事发生`)
        pos += 1
        shooter = shooter === v.challenger ? v.target : v.challenger
      }

      const winnerId = loserId === v.challenger ? v.target : v.challenger
      const win = await ctx.database.get(TABLE.player, { userId: winnerId })
      if (win[0] && win[0].uid !== null) await addStone(ctx, win[0].uid, v.amount * 2)

      return `🔫 虚神界对决结束！\n${log.join('\n')}\n🏆 ${win[0]?.userName ?? '?'} 获胜，赢得 ${v.amount * 2} 灵石`
    })

  ctx.command('拒绝对决', '拒绝虚神界对决')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const entry = [...duelPending.entries()]
        .find(([, v]) => v.target === p.userId && Date.now() - v.ts < 60_000)
      if (!entry) return '没有待接受的对决'
      const [key, v] = entry
      duelPending.delete(key)

      const ch = await ctx.database.get(TABLE.player, { userId: v.challenger })
      const chName = ch[0]?.userName ?? '对方'
      return `✅ 已拒绝 ${chName} 的对决（赌注 ${v.amount} 灵石）`
    })

  // ===== 抢灵石 =====
  ctx.command('抢灵石', '打劫对方灵石（PvP 战斗）')
    .alias('打劫').alias('抢夺灵石')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.uid === null) return '灵石服务未同步'
      {
        const myThreshold = Math.max(1, Math.floor(p.maxhp * 0.01))
        if (!Number.isFinite(p.hp) || p.hp < myThreshold) {
          return `你身受重伤，无法打劫`
        }
      }
      const target = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
      if (!target) return '请 @ 要打劫的人'
      if (target === p.userId) return '不能打劫自己'

      const now = Date.now()
      const cd = robCd.get(p.userId) || 0
      if (now < cd) return `打劫冷却中，还需 ${formatRemainTime(cd - now)}`

      // ✅ B4：所有前置校验通过后，才上 5 分钟 CD
      const oppRows = await ctx.database.get(TABLE.player, { userId: target })
      const opp = oppRows[0]
      if (!opp) return '对方尚未踏入仙途'
      if (opp.uid === null) return '对方灵石服务未同步'
      {
        const oppThreshold = Math.max(1, Math.floor(opp.maxhp * 0.01))
        if (!Number.isFinite(opp.hp) || opp.hp < oppThreshold) {
          return `对方身受重伤，胜之不武`
        }
      }
      const oppStone = await getStone(ctx, opp.uid)
      if (oppStone <= 0) return '对方身上没有灵石可抢'

      // ✅ B4：到这里才真正进入战斗流程，才上锁
      robCd.set(p.userId, now + ROB_CD_MS)

      const myStats = await computeStats(ctx, p)
      const myUnit = await buildPlayerUnit(ctx, p, myStats)
      const oppStats = await computeStats(ctx, opp)
      const oppUnit = await buildPlayerUnit(ctx, opp, oppStats)

      const r = simulateBattle(myUnit, oppUnit)

      recordBattle(p.userId, {
        ts: Date.now(),
        title: `打劫「${opp.userName}」`,
        log: r.log,
        winner: r.winner,
        playerName: myUnit.name,
        opponentName: oppUnit.name,
      }, {
        opponentUserId: opp.userId,
        opponentTitle: `被「${p.userName}」打劫`,
      })

      const iWon = r.winner === 'a'

      const pct = 1 + Math.random() * 4
      const pctDisplay = Math.round(pct * 100) / 100
      const expGain = Math.floor(100 + ((pct - 1) / 4) * 900)

      const winnerPlayer = iWon ? p : opp
      const loserPlayer = iWon ? opp : p
      const loserStone = iWon ? oppStone : await getStone(ctx, p.uid)

      const wantGain = Math.max(1, Math.floor(loserStone * pct / 100))
      const actualGain = Math.min(wantGain, loserStone)

      let realGain = 0
      if (actualGain > 0 && (await costStone(ctx, loserPlayer.uid, actualGain))) {
        await addStone(ctx, winnerPlayer.uid, actualGain)
        realGain = actualGain
      }

      if (realGain > 0) {
        loserPlayer.exp = (loserPlayer.exp || 0) + expGain
      }

      p.hp = myUnit.hp
      p.mp = myUnit.mp
      opp.hp = oppUnit.hp
      opp.mp = oppUnit.mp
      await refreshPlayerStats(ctx, p)
      await refreshPlayerStats(ctx, opp)
      if (realGain > 0) {
        await ctx.database.set(TABLE.player, { userId: loserPlayer.userId }, {
          exp: loserPlayer.exp,
        })
      }

      const lastLog = r.log.length ? r.log[r.log.length - 1].text : '（无战斗记录）'
      const lines = [
        `⚔️ 打劫：${p.userName} vs ${opp.userName}`,
        `📜 ${lastLog}`,
        `🏆 ${winnerPlayer.userName} 获胜`,
      ]
      if (realGain > 0) {
        lines.push(`💎 抢走 ${loserPlayer.userName} 的 ${pctDisplay}% 灵石：${realGain}`)
        lines.push(`🌱 ${loserPlayer.userName} 破财免灾，获得修为 +${expGain}`)
      } else {
        lines.push(`💸 灵石转移失败（余额变动/并发冲突），本次未结算灵石与修为`)
      }
      return lines.join('\n')
    })
}