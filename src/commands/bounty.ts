import { Context } from 'koishi'
import { Config, getPluginConfig } from '../config'
import { data, weightedPick } from '../data'
import { TABLE } from '../models'
import {
  requirePlayer, addStone, costStone, addItem,
  addPlayerExp, applyQiExp, qiExpNote,
  getBusyKind,
  getDropCategoryWeights, rollDrops, mergeDrops, formatDropList,
  isSameDay,
  formatRemainTime,
  getAffectedRows,
  formatCompact,
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

/** 解析悬赏令键「类别:名称」，并取出对应任务数据（不存在时 task 为 undefined） */
function parseQuestKey(questKey: string): { cat: string; name: string; task: any } {
  const [cat, ...rest] = questKey.split(':')
  const name = rest.join(':')
  return { cat, name, task: (data.bounty as any)[cat]?.[name] }
}

/**
 * 为单个悬赏任务生成附带掉落：
 * 按 bountyDropChance（%）决定是否掉落，掉落时随机 1 ~ bountyDropCount 件。
 */
function generateDropsForTask(config: Config): Array<{ id: number; name: string; num: number }> {
  const chance = config.bountyDropChance ?? 100
  const maxCount = Math.max(0, Math.floor(config.bountyDropCount ?? 2))
  if (maxCount <= 0 || Math.random() * 100 >= chance) return []
  const count = 1 + Math.floor(Math.random() * maxCount)
  return mergeDrops(rollDrops(getDropCategoryWeights(config), count))
}

// ===== 成功率随机生成（25~100，步长 5，众数 75）=====

function rollSuccessRate(): number {
  const values: number[] = []
  for (let sr = 25; sr <= 100; sr += 5) values.push(sr)
  return weightedPick(values, sr => Math.max(1, 100 - Math.abs(sr - 75))) ?? 75
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

/** 按任务 rate 加权、不放回地抽取 count 个任务 */
function pickTasksByWeight(
  pool: Array<{ key: string; cat: string; name: string; task: any }>,
  count: number,
) {
  const remaining = [...pool]
  const picked: typeof pool = []
  for (let i = 0; i < count && remaining.length > 0; i++) {
    const t = weightedPick(remaining, x => Math.max(1, Number(x.task.rate) || 1)) ?? remaining[remaining.length - 1]
    picked.push(t)
    remaining.splice(remaining.indexOf(t), 1)
  }
  return picked
}

async function generateBountyList(ctx: Context, uid: number) {
  const config = getPluginConfig(ctx)
  await ctx.database.remove(TABLE.bountyList, { uid })
  const all = buildAllTasks()
  const picked = pickTasksByWeight(all, BOUNTY_SIZE)
  for (let i = 0; i < picked.length; i++) {
    const t = picked[i]
    const drops = generateDropsForTask(config)
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

function formatBountyList(rows: Array<{ slot: number; questKey: string; dropJson: string; successRate: number }>, level: number): string {
  if (rows.length === 0) return '（暂无悬赏令，发送「悬赏令刷新」生成）'
  const lines: string[] = []
  for (const r of rows) {
    const { cat, name, task } = parseQuestKey(r.questKey)
    if (!task) continue
    const drops = JSON.parse(r.dropJson) as Array<{ id: number; name: string; num: number }>
    const dropStr = drops.length > 0 ? formatDropList(drops) : '无'
    const sr = r.successRate ?? 75
    const baseExp = task.reward[1]
    const expReward = calcExpReward(baseExp, level, sr)
    const stoneReward = calcStoneReward(baseExp, level, sr)
    lines.push(`【${r.slot}】${cat}·${name}`)
    lines.push(`    成功率 ${sr}%｜ ${task.timeSec} 分钟`)
    lines.push(`    修为 +${formatCompact(expReward)}｜ 灵石折算 +${formatCompact(stoneReward)}`)
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
  /** busy：另一请求正在结算同一悬赏令 */
  reason?: 'no-active' | 'not-ready' | 'busy' | 'error'
  remainMs?: number
}

/**
 * 尝试结算进行中的悬赏令。
 */
async function trySettleBounty(
  ctx: Context,
  p: { uid: number; level: string },
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
  const lockRes = await ctx.database.remove(TABLE.cd, { uid: p.uid, type: 2 })
  const locked = getAffectedRows(lockRes)
  if (locked === 0) {
    return { settled: false, reason: 'busy' }
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
  const { name, task } = parseQuestKey(listRows[0].questKey)
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
      msg = `✅ 「${name}」成功！\n💎 获得灵石 +${formatCompact(stoneReward)}`
    } else {
      const qi = await applyQiExp(ctx, p.uid, expReward)
      await addPlayerExp(ctx, p.uid, qi.gain)
      msg = `✅ 「${name}」成功！\n🌱 获得修为 +${formatCompact(qi.gain)}${qiExpNote(qi.mul)}`
    }
    if (drops.length > 0) {
      for (const d of drops) await addItem(ctx, p.uid, d.id, d.num)
      msg += `\n🎁 额外掉落：${formatDropList(drops)}`
    }
  } else {
    const qi = await applyQiExp(ctx, p.uid, Math.floor(calcExpReward(baseExp, level, successRate) * 0.3))
    await addPlayerExp(ctx, p.uid, qi.gain)
    msg = `❌ 「${name}」失败，仍获得修为 +${formatCompact(qi.gain)}${qiExpNote(qi.mul)}`
  }

  await cleanQuestAndWork()
  await generateBountyList(ctx, p.uid)
  return { settled: true, msg }
}

// ===== 命令注册 =====

export function registerBountyCommands(ctx: Context, config: Config) {
  ctx.command('悬赏令帮助', '玩法说明').action(() =>
    [
      '悬赏令，查看当前刷出的 3 个悬赏令，进行中悬赏已到期会自动结算，默认给修为',
      '悬赏令刷新，重新生成 3 个，每日 3 次免费，超出 1000 灵石',
      '悬赏令接取 [序号]，接取对应悬赏令',
      '悬赏令结算 [灵石]，到期结算，不填默认给修为，填「灵石」则给灵石',
      '悬赏令终止，中止任务，罚 500000 灵石',
      `每个悬赏令有 ${config.bountyDropChance}% 概率附带 1~${config.bountyDropCount} 件掉落`,
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
        const { name } = parseQuestKey(listRows[0].questKey)
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
        '\n\n发送「悬赏令接取 [1~3]」接取对应悬赏令'
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

      const busy = await getBusyKind(ctx, p.uid)
      if (busy === 'bounty') return '正在进行悬赏令，无法刷新'
      if (busy === 'closed') return '正在闭关中，无法刷新'

      const now = new Date()
      let cnt = p.workRefreshCount || 0
      let dayTs = p.workRefreshCountTime || 0
      if (!isSameDay(dayTs, now)) { cnt = 0; dayTs = +now }

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
      const busy = await getBusyKind(ctx, p.uid)
      if (busy === 'closed') return '你正在闭关中，无法接取悬赏'
      if (busy === 'bounty') return '你已有进行中的悬赏令'

      const list = await loadBountyList(ctx, p.uid)
      const target = list.find(r => r.slot === no)
      if (!target) {
        if (list.length === 0) return '暂无悬赏令，请先发送「悬赏令」生成'
        return `编号不存在（可用：${list.map(r => r.slot).join('/')}）`
      }

      const { cat, name, task } = parseQuestKey(target.questKey)
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
        if (result.reason === 'busy') return '⏳ 悬赏令正在结算，请稍后'
        if (result.reason === 'not-ready') return `尚未完成，还需 ${formatRemainTime(result.remainMs ?? 0)}`
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
