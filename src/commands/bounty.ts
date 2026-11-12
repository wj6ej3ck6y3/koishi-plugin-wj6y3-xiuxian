import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import {
  requirePlayer, addStone, costStone, addItem,
  rollSingleDrop, DropEntry,
  formatRemainTime,
  getAffectedRows,
} from '../utils'

const BOUNTY_SIZE = 3

// ===== 工具 =====

function buildAllTasks(): Array<{ key: string; cat: string; name: string; task: any }> {
  const all: Array<{ key: string; cat: string; name: string; task: any }> = []
  for (const [cat, group] of Object.entries(data.bounty)) {
    for (const [name, v] of Object.entries(group as any)) {
      all.push({ key: `${cat}:${name}`, cat, name, task: v })
    }
  }
  return all
}

function getCategoryWeights(ctx: Context): Record<string, number> {
  const w = (ctx as any).config?.bountyDropCategoryWeights
  if (w && typeof w === 'object' && Object.keys(w).length > 0) return w
  return {
    pill: 20, craftPill: 8, herb: 25, weapon: 12, armor: 8,
    gongfa: 10, shentong: 10, fuxiu: 3, qiFlag: 2, furnace: 2,
  }
}

function mergeDrops(drops: DropEntry[]): Array<{ id: number; name: string; num: number }> {
  const map = new Map<number, { id: number; name: string; num: number }>()
  for (const d of drops) {
    const cur = map.get(d.id)
    if (cur) cur.num += 1
    else map.set(d.id, { id: d.id, name: d.name, num: 1 })
  }
  return [...map.values()]
}

function generateDropsForTask(ctx: Context): Array<{ id: number; name: string; num: number }> {
  const weights = getCategoryWeights(ctx)
  const count = 1 + Math.floor(Math.random() * 2)
  const results: DropEntry[] = []
  for (let i = 0; i < count; i++) {
    const d = rollSingleDrop(weights)
    if (d) results.push(d)
  }
  return mergeDrops(results)
}

// ===== 成功率随机生成（25~100，步长 5，众数 75）=====

function rollSuccessRate(): number {
  const values: number[] = []
  for (let sr = 25; sr <= 100; sr += 5) values.push(sr)

  const weights = values.map(sr => Math.max(1, 100 - Math.abs(sr - 75)))
  const total = weights.reduce((s, w) => s + w, 0)

  let r = Math.random() * total
  for (let i = 0; i < values.length; i++) {
    r -= weights[i]
    if (r <= 0) return values[i]
  }
  return 75
}

function successBonus(sr: number): number {
  return 1 + ((100 - sr) / 75) * 2
}

function calcExpReward(baseExp: number, level: number, sr: number): number {
  return Math.floor(baseExp * level * successBonus(sr))
}

function calcStoneReward(baseExp: number, level: number, sr: number): number {
  return calcExpReward(baseExp, level, sr) * 5
}

function pickTasksByWeight(
  pool: Array<{ key: string; cat: string; name: string; task: any }>,
  count: number,
) {
  const remaining = [...pool]
  const picked: typeof pool = []
  for (let i = 0; i < count && remaining.length > 0; i++) {
    const total = remaining.reduce((s, t) => s + Math.max(1, Number(t.task.rate) || 1), 0)
    let r = Math.random() * total
    let idx = remaining.length - 1
    for (let j = 0; j < remaining.length; j++) {
      r -= Math.max(1, Number(remaining[j].task.rate) || 1)
      if (r <= 0) { idx = j; break }
    }
    picked.push(remaining[idx])
    remaining.splice(idx, 1)
  }
  return picked
}

async function generateBountyList(ctx: Context, uid: number) {
  await ctx.database.remove(TABLE.bountyList, { uid })
  const all = buildAllTasks()
  const picked = pickTasksByWeight(all, BOUNTY_SIZE)
  for (let i = 0; i < picked.length; i++) {
    const t = picked[i]
    const drops = generateDropsForTask(ctx)
    const successRate = rollSuccessRate()
    await ctx.database.create(TABLE.bountyList, {
      uid, slot: i + 1, questKey: t.key,
      dropJson: JSON.stringify(drops),
      successRate,
      createdAt: new Date(),
    })
  }
}

async function loadBountyList(ctx: Context, uid: number) {
  const rows = await ctx.database.get(TABLE.bountyList, { uid })
  return rows.sort((a, b) => a.slot - b.slot)
}

function formatBountyList(rows: any[], level: number): string {
  if (rows.length === 0) return '（暂无悬赏令，发送「悬赏令刷新」生成）'
  const lines: string[] = []
  for (const r of rows) {
    const [cat, ...rest] = r.questKey.split(':')
    const name = rest.join(':')
    const task = (data.bounty as any)[cat]?.[name]
    if (!task) continue
    const drops = JSON.parse(r.dropJson) as Array<{ id: number; name: string; num: number }>
    const dropStr = drops.length > 0 ? drops.map(d => `${d.name}×${d.num}`).join('、') : '无'
    const sr = r.successRate ?? 75
    const baseExp = task.reward[1]
    const expReward = calcExpReward(baseExp, level, sr)
    const stoneReward = calcStoneReward(baseExp, level, sr)
    lines.push(`【${r.slot}】${cat}·${name}`)
    lines.push(`    成功率 ${sr}%｜ ${task.timeSec} 分钟`)
    lines.push(`    修为 +${expReward}｜ 灵石折算 +${stoneReward}`)
    lines.push(`    🎁 额外掉落：${dropStr}`)
  }
  return lines.join('\n')
}

async function clearSession(ctx: Context, uid: number) {
  await ctx.database.remove(TABLE.cd, { uid })
  await ctx.database.remove(TABLE.quest, { uid })
  await ctx.database.remove(TABLE.work, { uid })
}

// ===== 结算结果类型 =====
interface BountySettleResult {
  settled: boolean
  msg?: string
  reason?: 'no-active' | 'not-ready' | 'error'
  remainMs?: number
}

/**
 * 尝试结算进行中的悬赏令。
 */
async function trySettleBounty(
  ctx: Context,
  p: any,
  wantStone = false,
): Promise<BountySettleResult> {
  const cdRows = await ctx.database.get(TABLE.cd, { uid: p.uid })
  if (cdRows[0]?.type !== 2) return { settled: false, reason: 'no-active' }

  const elapsed = (Date.now() - +new Date(cdRows[0].createTime)) / 1000
  if (elapsed < cdRows[0].scheduledTime) {
    const remainMs = (cdRows[0].scheduledTime - elapsed) * 1000
    return { settled: false, reason: 'not-ready', remainMs }
  }

  // ✅ 抢占式删除（只有真正删除成功的那次请求才能继续）
  const lockRes: any = await ctx.database.remove(TABLE.cd, { uid: p.uid, type: 2 })
  const locked = getAffectedRows(lockRes)
  if (locked === 0) {
    return { settled: false, reason: 'not-ready', remainMs: 1000 }
  }

  const cleanQuestAndWork = async () => {
    await ctx.database.remove(TABLE.quest, { uid: p.uid })
    await ctx.database.remove(TABLE.work, { uid: p.uid })
  }

  const qRows = await ctx.database.get(TABLE.quest, { uid: p.uid })
  const slot = qRows[0]?.questId
  if (!slot) {
    await cleanQuestAndWork()
    return { settled: false, reason: 'error', msg: '任务数据异常' }
  }

  const listRows = await ctx.database.get(TABLE.bountyList, { uid: p.uid, slot })
  if (!listRows[0]) {
    await cleanQuestAndWork()
    return { settled: false, reason: 'error', msg: '任务列表数据异常，请重新发送「悬赏令」' }
  }
  const [cat, ...rest] = listRows[0].questKey.split(':')
  const name = rest.join(':')
  const task = (data.bounty as any)[cat]?.[name]
  if (!task) {
    await cleanQuestAndWork()
    return { settled: false, reason: 'error', msg: '任务编号无效' }
  }

  const drops = JSON.parse(listRows[0].dropJson) as Array<{ id: number; name: string; num: number }>
  const successRate = listRows[0].successRate ?? 75
  const success = Math.random() * 100 < successRate

  const level = parseInt(p.level, 10) || 1
  const baseExp = task.reward[1]

  let msg: string
  if (success) {
    const expReward = calcExpReward(baseExp, level, successRate)
    if (wantStone) {
      const stoneReward = calcStoneReward(baseExp, level, successRate)
      await addStone(ctx, p.uid, stoneReward)
      msg = `✅ 「${name}」成功！\n💎 获得灵石 +${stoneReward}`
    } else {
      p.exp += expReward
      await ctx.database.set(TABLE.player, { uid: p.uid }, { exp: p.exp })
      msg = `✅ 「${name}」成功！\n🌱 获得修为 +${expReward}`
    }
    if (drops.length > 0) {
      for (const d of drops) await addItem(ctx, p.uid, d.id, d.num)
      msg += `\n🎁 额外掉落：${drops.map(d => `${d.name}×${d.num}`).join('、')}`
    }
  } else {
    const expGain = Math.floor(calcExpReward(baseExp, level, successRate) * 0.3)
    p.exp += expGain
    await ctx.database.set(TABLE.player, { uid: p.uid }, { exp: p.exp })
    msg = `❌ 「${name}」失败，仍获得修为 +${expGain}`
  }

  await cleanQuestAndWork()
  await generateBountyList(ctx, p.uid)
  return { settled: true, msg }
}

// ===== 命令注册 =====

export function registerBountyCommands(ctx: Context) {
  ctx.command('悬赏令帮助', '玩法说明').action(() =>
    [
      '悬赏令            查看当前刷出的 3 个悬赏令（若进行中悬赏已到期会自动结算）',
      '悬赏令刷新        重新生成 3 个（每日 3 次免费，超出 1000 灵石）',
      '悬赏令接取 [序号]  接取对应悬赏令',
      '悬赏令结算 [灵石] 到期结算（不填默认给修为，填"灵石"则给灵石）',
      '悬赏令终止        中止任务（罚 500000 灵石）',
    ].join('\n')
  )

  // ===== 查看 =====
  ctx.command('悬赏令', '查看悬赏令列表')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)

      const settleResult = await trySettleBounty(ctx, p)
      const prefix = settleResult.msg ? settleResult.msg + '\n\n' : ''

      const cdRows = await ctx.database.get(TABLE.cd, { uid: p.uid })

      if (cdRows[0]?.type === 2) {
        const qRows = await ctx.database.get(TABLE.quest, { uid: p.uid })
        const slot = qRows[0]?.questId
        const listRows = slot
          ? await ctx.database.get(TABLE.bountyList, { uid: p.uid, slot })
          : []
        if (!listRows[0]) {
          await clearSession(ctx, p.uid)
          return prefix + '数据异常已清理，请重新发送「悬赏令」'
        }
        const [cat, ...rest] = listRows[0].questKey.split(':')
        const name = rest.join(':')
        const sr = listRows[0].successRate ?? 75
        const elapsed = (Date.now() - +new Date(cdRows[0].createTime)) / 1000
        const remainSec = Math.max(0, cdRows[0].scheduledTime - elapsed)
        return prefix + (remainSec > 0
          ? `📜 你正在进行「${name}」（成功率 ${sr}%），还需 ${formatRemainTime(remainSec * 1000)} 可结算`
          : `📜 你正在进行「${name}」（成功率 ${sr}%），可发送「悬赏令结算」结算`)
      }
      if (cdRows[0]?.type === 1) return prefix + '你正在闭关中，无法进行悬赏令'

      let list = await loadBountyList(ctx, p.uid)
      if (list.length === 0) {
        await generateBountyList(ctx, p.uid)
        list = await loadBountyList(ctx, p.uid)
      }

      return prefix + '📜 当前悬赏令：\n' + formatBountyList(list, parseInt(p.level, 10) || 1) +
        '\n\n发送「悬赏令接取 <1~3>」接取对应悬赏令'
    })

  // ===== 刷新 =====
  ctx.command('悬赏令刷新', '刷新悬赏令')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)

      const settleResult = await trySettleBounty(ctx, p)
      if (settleResult.settled) {
        const list = await loadBountyList(ctx, p.uid)
        return (settleResult.msg || '') +
          '\n\n🔄 已自动结算并生成新悬赏令（本次不消耗刷新次数）\n\n' +
          formatBountyList(list, parseInt(p.level, 10) || 1)
      }

      const cdRows = await ctx.database.get(TABLE.cd, { uid: p.uid })
      if (cdRows[0]?.type === 2) return '正在进行悬赏令，无法刷新'
      if (cdRows[0]?.type === 1) return '正在闭关中，无法刷新'

      const now = new Date()
      const dayKey = now.toDateString()
      let cnt = p.workRefreshCount || 0
      let dayTs = p.workRefreshCountTime || 0
      if (new Date(dayTs).toDateString() !== dayKey) { cnt = 0; dayTs = +now }

      let costNote = ''
      if (cnt >= 3) {
        if (!(await costStone(ctx, p.uid, 1000))) return '超出免费次数，需 1000 灵石（灵石不足）'
        costNote = '（本次消耗 1000 灵石）'
      }
      await ctx.database.set(TABLE.player, { uid: p.uid }, {
        workRefreshCount: cnt + 1, workRefreshCountTime: dayTs,
      })

      await generateBountyList(ctx, p.uid)
      const list = await loadBountyList(ctx, p.uid)
      const freeRemain = Math.max(0, 3 - Math.min(3, cnt + 1))
      return `🔄 悬赏令已刷新${costNote}（今日免费剩余 ${freeRemain} 次）\n\n${formatBountyList(list, parseInt(p.level, 10) || 1)}`
    })

  // ===== 接取 =====
  ctx.command('悬赏令接取 <no:number>', '接取任务')
    .action(async ({ session }, no) => {
      if (!no) return '请输入编号（1~3）'
      const p = await requirePlayer(ctx, session)
      const cdRows = await ctx.database.get(TABLE.cd, { uid: p.uid })
      if (cdRows[0]?.type === 1) return '你正在闭关中，无法接取悬赏'
      if (cdRows[0]?.type === 2) return '你已有进行中的悬赏令'

      const list = await loadBountyList(ctx, p.uid)
      const target = list.find(r => r.slot === no)
      if (!target) {
        if (list.length === 0) return '暂无悬赏令，请先发送「悬赏令」生成'
        return `编号不存在（可用：${list.map(r => r.slot).join('/')}）`
      }

      const [cat, ...rest] = target.questKey.split(':')
      const name = rest.join(':')
      const task = (data.bounty as any)[cat]?.[name]
      if (!task) return '任务数据异常'

      const sr = target.successRate ?? 75
      await ctx.database.remove(TABLE.cd, { uid: p.uid })
      await ctx.database.create(TABLE.cd, {
        uid: p.uid, type: 2,
        createTime: new Date(), scheduledTime: task.timeSec * 60,
      })
      await ctx.database.upsert(TABLE.quest, [{ uid: p.uid, questId: no }], ['uid'])
      return `📜 已接取【${no}】${cat}·${name}（成功率 ${sr}%），需等待 ${task.timeSec} 分钟后可结算`
    })

  // ===== 结算（显式调用） =====
  ctx.command('悬赏令结算 [stone:string]', '结算任务').alias('最后的悬赏令')
    .action(async ({ session }, stone) => {
      const p = await requirePlayer(ctx, session)
      const wantStone = typeof stone === 'string' && stone.includes('灵')

      const result = await trySettleBounty(ctx, p, wantStone)

      if (!result.settled) {
        if (result.reason === 'no-active') return '当前没有进行中的悬赏令'
        if (result.reason === 'not-ready') return `尚未完成，还需 ${formatRemainTime(result.remainMs!)}`
        return result.msg || '结算失败'
      }

      return (result.msg || '') + '\n\n🔄 已生成下一批悬赏令，发送「悬赏令」查看'
    })

  // ===== 终止 =====
  ctx.command('悬赏令终止', '中止任务')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const cdRows = await ctx.database.get(TABLE.cd, { uid: p.uid })
      if (cdRows[0]?.type !== 2) return '当前没有悬赏令'
      await costStone(ctx, p.uid, 500000)
      await clearSession(ctx, p.uid)
      await generateBountyList(ctx, p.uid)
      return '已终止悬赏令（罚 500000 灵石），已生成下一批悬赏令'
    })
}