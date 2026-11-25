import { $, Context } from 'koishi'
import { data, weightedPick } from '../data'
import { TABLE } from '../models'
import {
  requirePlayer, addStone, costStone, getPlayer,
  simulateBattle,
  getNextId,
  recomputeAndSaveStats,
  requireBattleReadyPlayer,
  addItem,
  addPlayerExp,
  addPlayerContribution,
  subPlayerContributionIfEnough,
  getAffectedRows,
  getPositionName,
  isSameDay,
  recordBattle,
  CombatUnit,
  formatRemainTime,
  formatPct,
  resolveAtUid,
  formatCompact,
} from '../utils'

// ======================= 宗门任务数值配置 =======================
const SECT_MISSION_CONFIG = {
  STARS: {
    1: { hpMul: 0.7, atkMul: 0.7, defMul: 0.7, rewardStone: 500, rewardContrib: 50, rewardBuild: 100 },
    2: { hpMul: 0.9, atkMul: 0.9, defMul: 0.9, rewardStone: 1000, rewardContrib: 50, rewardBuild: 200 },
    3: { hpMul: 1.1, atkMul: 1.1, defMul: 1.1, rewardStone: 1500, rewardContrib: 50, rewardBuild: 300 },
    4: { hpMul: 1.4, atkMul: 1.4, defMul: 1.4, rewardStone: 2000, rewardContrib: 50, rewardBuild: 400 },
    5: { hpMul: 1.8, atkMul: 1.8, defMul: 1.8, rewardStone: 2500, rewardContrib: 50, rewardBuild: 500 },
  } as Record<number, {
    hpMul: number; atkMul: number; defMul: number;
    rewardStone: number; rewardContrib: number; rewardBuild: number;
  }>,
  STAR_NAMES: ['', '一星', '二星', '三星', '四星', '五星'],

  BASE_HP_MULT: 0.5,
  BASE_ATK_MULT: 0.4,
  MAX_DEF_CAP: 85,
  SPD: 0,
  CRIT: 0.05,
  CRIT_DMG: 1.5,

  UNLOCK_REALM_FOR_4STAR: 11,
  UNLOCK_REALM_FOR_5STAR: 17,

  COOLDOWN_HOURS: 12,
}

/** 贡献兑换比例：10 贡献 = 1 灵石，5 贡献 = 1 修为，200 贡献 = 1 颗回复丹 */
const CONTRIB_PER_STONE = 10
const CONTRIB_PER_EXP = 5
const CONTRIB_PER_PILL = 200

export function buildSectMissionBoss(levelId: string, star: number): CombatUnit {
  const cfg = SECT_MISSION_CONFIG.STARS[star] ?? SECT_MISSION_CONFIG.STARS[1]
  const lv = data.levels[levelId] ?? data.levels['1']
  const starName = SECT_MISSION_CONFIG.STAR_NAMES[star] || `${star}星`
  const hp = Math.floor(lv.hp * SECT_MISSION_CONFIG.BASE_HP_MULT * cfg.hpMul)
  const def = Math.min(SECT_MISSION_CONFIG.MAX_DEF_CAP, lv.def * cfg.defMul)
  return {
    name: `宗门妖兽（${starName}）`,
    hp, maxhp: hp,
    mp: lv.mp, maxmp: lv.mp,
    atk: Math.floor(lv.atk * SECT_MISSION_CONFIG.BASE_ATK_MULT * cfg.atkMul),
    def,
    spd: SECT_MISSION_CONFIG.SPD,
    crit: SECT_MISSION_CONFIG.CRIT,
    critDmg: SECT_MISSION_CONFIG.CRIT_DMG,
    pen: 0,
  }
}

/** 今天 0 点（服务器本地时区） */
function startOfToday(now = new Date()): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * 宗门每日结算：建设度换算灵石入库，并为当天的供奉计算快照。
 * 以「offeringSnapshotAt 早于今日 0 点」作为条件更新，保证每个宗门每天只结算一次；灵石池以 $.add 累加。
 */
export async function settleSectDaily(ctx: Context, onlySectId?: number): Promise<void> {
  const now = new Date()
  const todayStart = startOfToday(now)

  const sects = onlySectId !== undefined
    ? await ctx.database.get(TABLE.sect, { sectId: onlySectId })
    : await ctx.database.get(TABLE.sect, {})

  for (const sect of sects) {
    if (isSameDay(sect.offeringSnapshotAt, now)) continue

    const buildBonus = Math.floor((sect.sectScale ?? 0) / 2000)
    const stoneAfter = Math.floor(sect.sectUsedStone ?? 0) + buildBonus
    const snapshot = Math.floor(stoneAfter * 0.001)

    await ctx.database.set(TABLE.sect, {
      sectId: sect.sectId,
      offeringSnapshotAt: { $lt: todayStart },
    }, row => ({
      sectUsedStone: $.add(row.sectUsedStone, buildBonus),
      offeringSnapshot: snapshot,
      offeringSnapshotAt: now,
    }))
  }
}

export function registerSectCommands(ctx: Context) {
  // ================= 帮助 =================
  ctx.command('宗门帮助', '宗门指令列表').action(() => [
    '创建宗门 [名称]，创建宗门',
    '我的宗门，查看宗门信息',
    '宗门列表，查看所有宗门',
    '加入宗门 [编号/名称]，加入指定宗门',
    '宗门捐献 [灵石数]，10 灵石 = 1 贡献',
    '宗门成员查看，查看本宗门成员',
    '退出宗门，退出当前宗门',
    '宗门职位变更 [2-5] [@成员]，只能调整比自己低阶的成员',
    '踢出宗门 [@成员]，踢出成员',
    '宗主传位 [@成员]，转让宗主',
    '宗门每日供奉，领取供奉灵石',
    '宗门贡献兑换 灵石 [贡献数]，10 贡献 = 1 灵石',
    '宗门贡献兑换 修为 [贡献数]，5 贡献 = 1 修为',
    '宗门贡献兑换 丹药 [颗数]，200 贡献 = 1 颗回复丹',
    '接取宗门任务，12 小时冷却',
    '完成宗门任务，挑战任务妖兽',
  ].join('\n'))

  // ================= 创建 =================
  ctx.command('创建宗门 <name:string>', '创建宗门')
    .action(async ({ session }, name) => {
      if (!name) return '请提供宗门名称'
      const p = await requirePlayer(ctx, session)
      if (p.sectId && p.sectId > 0) return '你已加入宗门，需先退出'
      const need = 100000
      if (!(await costStone(ctx, p.uid, need))) return `创建宗门需 ${formatCompact(need)} 灵石，灵石不足`

      const sectId = await getNextId(ctx, TABLE.sect, 'sectId')
      try {
        await ctx.database.create(TABLE.sect, {
          sectId,
          sectName: name, sectOwnerUid: p.uid,
          sectScale: 0, sectFairyland: 0, sectMaterials: 0, elixirRoomLevel: 0,
          sectUsedStone: 0,
          offeringSnapshot: 0,
          offeringSnapshotAt: new Date(0),
        })
      } catch (e: any) {
        ctx.logger('xiuxian').warn(`创建宗门失败: ${e?.message ?? e}`)
        await addStone(ctx, p.uid, need)
        return '⚠️ 宗门创建失败，灵石已退还，请稍后重试'
      }

      const verify = await ctx.database.get(TABLE.sect, { sectId })
      if (!verify[0]) {
        ctx.logger('xiuxian').warn(`宗门创建后无法查到 sectId=${sectId}`)
        await addStone(ctx, p.uid, need)
        return '⚠️ 宗门创建异常，灵石已退还，请稍后重试'
      }

      await ctx.database.set(TABLE.player, { uid: p.uid }, {
        sectId, sectPosition: 1,
      })
      return `⛩️ 宗门「${name}」创建成功（编号 ${sectId}），你是第一任宗主！`
    })

  // ================= 我的宗门 =================
  ctx.command('我的宗门', '查看宗门信息').alias('宗门信息').alias('宗门')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '你尚未加入任何宗门'
      await settleSectDaily(ctx, p.sectId)
      const [sect] = await ctx.database.get(TABLE.sect, { sectId: p.sectId })
      if (!sect) return '宗门不存在（数据异常）'
      const members = await ctx.database.get(TABLE.player, { sectId: p.sectId })
      const owner = await getPlayer(ctx, sect.sectOwnerUid)
      return [
        `⛩️ ${sect.sectName}（编号 ${sect.sectId}）`,
        `宗主：${owner?.userName ?? '未知'}`,
        `建设度：${formatCompact(sect.sectScale)}   可用灵石：${formatCompact(sect.sectUsedStone)}   资材：${formatCompact(sect.sectMaterials)}`,
        `成员：${members.length}   我的职位：${getPositionName(p.sectPosition)}   个人贡献：${formatCompact(p.sectContribution)}`,
      ].join('\n')
    })

  // ================= 宗门列表 =================
  ctx.command('宗门列表', '所有宗门').action(async () => {
    const sects = await ctx.database.get(TABLE.sect, {}, { sort: { sectScale: 'desc' }, limit: 30 })
    if (!sects.length) return '尚无宗门'
    return '⛩️ 宗门列表\n' + sects.map((s, i) => `${i + 1}. ${s.sectName}（编号 ${s.sectId}）建设度 ${formatCompact(s.sectScale)}`).join('\n')
  })

  // ================= 加入 =================
  ctx.command('加入宗门 <target:string>', '加入宗门')
    .action(async ({ session }, target) => {
      if (!target) return '请输入宗门编号或名称'
      const p = await requirePlayer(ctx, session)
      if (p.sectId) return '已在宗门中'
      const rows = /^\d+$/.test(target)
        ? await ctx.database.get(TABLE.sect, { sectId: Number(target) })
        : await ctx.database.get(TABLE.sect, { sectName: target })
      const sect = rows[0]
      if (!sect) return '宗门不存在'
      await ctx.database.set(TABLE.player, { uid: p.uid }, { sectId: sect.sectId, sectPosition: 5 })
      return `✅ 已加入「${sect.sectName}」，成为外门弟子`
    })

  // ================= 捐献 =================
  ctx.command('宗门捐献 <amount:number>', '捐献灵石，10 灵石 = 1 贡献')
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0) return '请输入正整数'
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      const actualSpend = Math.floor(amount / 10) * 10
      if (actualSpend < 10) return '至少捐献 10 灵石'

      await settleSectDaily(ctx, p.sectId)

      if (!(await costStone(ctx, p.uid, actualSpend))) return '灵石不足'
      await ctx.database.set(TABLE.sect, { sectId: p.sectId }, row => ({
        sectScale: $.add(row.sectScale, actualSpend),
        sectUsedStone: $.add(row.sectUsedStone, actualSpend),
      }))
      const contrib = actualSpend / 10
      await addPlayerContribution(ctx, p.uid, contrib)
      return `💎 捐献 ${formatCompact(actualSpend)} 灵石，建设度 +${formatCompact(actualSpend)}，个人贡献 +${formatCompact(contrib)}`
    })

  // ================= 成员 =================
  ctx.command('宗门成员查看', '本宗门成员').alias('查看宗门成员').alias('宗门成员')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      const members = await ctx.database.get(TABLE.player, { sectId: p.sectId })
      const grouped: Record<number, string[]> = {}
      for (const m of members) {
        (grouped[m.sectPosition] ??= []).push(`${m.userName}(${formatCompact(m.sectContribution)})`)
      }
      return Object.keys(grouped).sort().map(pos => {
        const n = Number(pos)
        return `${getPositionName(n)}：${grouped[n].join('、')}`
      }).join('\n')
    })

  // ================= 职位变更 =================
  ctx.command('宗门职位变更 <pos:number>', '调整比自己低阶的成员职位，职位填 2-5').alias('宗门职位调整')
    .action(async ({ session }, rawPos) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      if (p.sectPosition <= 0) return '你没有宗门职位，无法管理人员'

      // 职位参数无条件舍去小数
      const pos = Math.floor(Number(rawPos))
      if (!Number.isFinite(pos) || pos < 2 || pos > 5) {
        return '职位值需在 2-5 之间（2长老 / 3亲传 / 4内门 / 5外门）'
      }

      if (pos <= p.sectPosition) {
        return '你不能将其他成员的职位设置得与自己同级或更高'
      }

      const targetUid = await resolveAtUid(ctx, session)
      if (targetUid === null) return '请 @ 目标成员（对方需在本平台使用过 bot）'
      if (targetUid === p.uid) return '不能变更自己的职位，如需传位请使用「宗主传位」'

      const target = await getPlayer(ctx, targetUid)
      if (!target || target.sectId !== p.sectId) return '该成员不在你的宗门'

      if (target.sectPosition <= p.sectPosition) {
        return '你不能变更同级或更高级别成员的职位'
      }

      await ctx.database.set(TABLE.player, { uid: targetUid }, { sectPosition: pos })
      return `✅ 已将 ${target.userName} 调整为「${getPositionName(pos)}」`
    })

  // ================= 踢人 =================
  ctx.command('踢出宗门', '踢出成员')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.sectPosition !== 1) return '只有宗主可踢人'
      const targetUid = await resolveAtUid(ctx, session)
      if (targetUid === null) return '请 @ 目标成员（对方需在本平台使用过 bot）'
      if (targetUid === p.uid) return '不能踢自己'
      const target = await getPlayer(ctx, targetUid)
      if (!target || target.sectId !== p.sectId) return '目标不在本宗门'
      await ctx.database.set(TABLE.player, { uid: targetUid }, { sectId: 0, sectPosition: 0 })
      return `✅ 已踢出宗门`
    })

  // ================= 传位 =================
  ctx.command('宗主传位', '转让宗主')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.sectPosition !== 1) return '只有宗主可传位'
      const targetUid = await resolveAtUid(ctx, session)
      if (targetUid === null) return '请 @ 目标成员（对方需在本平台使用过 bot）'
      if (targetUid === p.uid) return '不能传位给自己'
      const target = await getPlayer(ctx, targetUid)
      if (!target || target.sectId !== p.sectId) return '目标不在本宗门'
      await ctx.database.set(TABLE.sect, { sectId: p.sectId }, { sectOwnerUid: targetUid })
      await ctx.database.set(TABLE.player, { uid: targetUid }, { sectPosition: 1 })
      await ctx.database.set(TABLE.player, { uid: p.uid }, { sectPosition: 2 })
      return `✅ 已将宗主之位传给 ${target.userName}`
    })

  // ================= 退出 =================
  ctx.command('退出宗门', '退出当前宗门')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      if (p.sectPosition === 1) return '宗主需先传位或解散宗门（暂不支持解散）'

      await ctx.database.set(TABLE.player, { uid: p.uid }, {
        sectId: 0, sectPosition: 0, sectMissionId: 0,
      })
      return '✅ 已退出宗门'
    })

  // ================= 每日供奉 =================
  ctx.command('宗门每日供奉', '领取供奉灵石')
    .alias('宗门供奉').alias('领取宗门俸禄').alias('宗门俸禄')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'

      const now = new Date()
      if (isSameDay(p.sectOfferingGet, now)) return '今日已领取供奉'

      await settleSectDaily(ctx, p.sectId)

      const [sect] = await ctx.database.get(TABLE.sect, { sectId: p.sectId })
      if (!sect) return '宗门不存在（数据异常），请联系管理员'

      const snapshot = sect.offeringSnapshot ?? 0

      if (snapshot <= 0) {
        await ctx.database.set(TABLE.player, { uid: p.uid }, { sectOfferingGet: now })
        return '🎁 今日宗门灵石不足，供奉无法发放'
      }

      const ratioPermille: Record<number, number> = { 1: 1750, 2: 1500, 3: 750, 4: 300, 5: 100 }
      const permille = ratioPermille[p.sectPosition]
      if (!permille) return '你的宗门职位异常，请联系管理员'
      const amount = Math.floor(snapshot * permille / 1000)

      if (amount <= 0) {
        await ctx.database.set(TABLE.player, { uid: p.uid }, { sectOfferingGet: now })
        return '🎁 今日宗门供奉过少，不足 1 灵石'
      }

      // 条件扣减宗门灵石池（签到的写法）：灵石池 ≥ amount 才扣减成功
      const deduct = await ctx.database.set(TABLE.sect, {
        sectId: p.sectId,
        sectUsedStone: { $gte: amount },
      }, row => ({ sectUsedStone: $.sub(row.sectUsedStone, amount) }))
      if (getAffectedRows(deduct) === 0) {
        return `🎁 宗门灵石不足，请稍后再试`
      }

      // 占用今日领取资格；若并发下已被领取，退还刚扣的灵石池
      const claim = await ctx.database.set(TABLE.player, {
        uid: p.uid,
        sectOfferingGet: { $lt: startOfToday(now) },
      }, { sectOfferingGet: now })
      if (getAffectedRows(claim) === 0) {
        await ctx.database.set(TABLE.sect, { sectId: p.sectId }, row => ({ sectUsedStone: $.add(row.sectUsedStone, amount) }))
        return '今日已领取供奉'
      }

      await addStone(ctx, p.uid, amount)

      let extra = ''
      if (Math.random() < 0.2) {
        await addItem(ctx, p.uid, 1101, 1)
        extra = '，额外获得「生骨丹」×1'
      }

      return [
        `🎁 ${getPositionName(p.sectPosition)}领取供奉：${formatCompact(amount)}${extra}`,
        `宗门灵石剩余：${formatCompact(sect.sectUsedStone - amount)}`,
      ].join('\n')
    })

  // ================= 贡献兑换 =================
  ctx.command('宗门贡献兑换 <type:string> [count:posint]', '兑换，灵石/修为填要花的贡献数，丹药填颗数').alias('贡献兑换')
    .action(async ({ session }, type, count) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectContribution || p.sectContribution <= 0) return '没有贡献'
      const current = Math.floor(p.sectContribution)

      if (type === '灵石' || type === '修为') {
        const rate = type === '灵石' ? CONTRIB_PER_STONE : CONTRIB_PER_EXP
        if (!count) return `请输入要花费的贡献数（${rate} 贡献 = 1 ${type}），例如「宗门贡献兑换 ${type} ${rate * 10}」`
        // 无法整除的部分向下取到可兑换的数量
        const spend = Math.floor(count / rate) * rate
        if (spend < rate) return `至少需花费 ${rate} 贡献（${rate} 贡献 = 1 ${type}）`
        if (!(await subPlayerContributionIfEnough(ctx, p.uid, spend))) {
          return `贡献不足（需 ${formatCompact(spend)}，当前 ${formatCompact(current)}）`
        }
        const gain = spend / rate
        if (type === '灵石') {
          await addStone(ctx, p.uid, gain)
          return `💎 用 ${formatCompact(spend)} 贡献兑换 ${formatCompact(gain)} 灵石`
        }
        await addPlayerExp(ctx, p.uid, gain)
        return `🌱 用 ${formatCompact(spend)} 贡献兑换 ${formatCompact(gain)} 修为`
      }

      if (type === '丹药') {
        const actualCount = count ?? 1
        const need = CONTRIB_PER_PILL * actualCount
        if (current < need) {
          return `批量兑换 ${actualCount} 颗回复丹需 ${formatCompact(need)} 贡献（当前 ${formatCompact(current)}）`
        }

        const allHealPills = Object.entries(data.pills)
          .filter(([, v]) => (v?.modifiers ?? []).some(m => m.stat === 'hp' || m.stat === 'mp'))

        const lvNum = parseInt(p.level, 10) || 1
        const buildPool = (src: Array<[string, any]>) => src.map(([id, v]) => ({
          id: Number(id),
          weight: Math.max(1, Number(v.weight) || 1),
        }))

        let pool = buildPool(allHealPills.filter(([, v]) => !v.realm || lvNum >= Number(v.realm)))
        if (pool.length === 0) pool = buildPool(allHealPills)
        if (pool.length === 0) return '暂无可兑换的回复丹药'

        if (!(await subPlayerContributionIfEnough(ctx, p.uid, need))) {
          return `批量兑换 ${actualCount} 颗回复丹需 ${formatCompact(need)} 贡献（当前 ${formatCompact(current)}）`
        }

        const got: Record<number, number> = {}
        for (let i = 0; i < actualCount; i++) {
          const pid = (weightedPick(pool, it => it.weight) ?? pool[pool.length - 1]).id
          got[pid] = (got[pid] ?? 0) + 1
        }
        for (const [pidStr, num] of Object.entries(got)) {
          await addItem(ctx, p.uid, Number(pidStr), num)
        }

        const detail = Object.entries(got)
          .map(([pidStr, num]) => `「${data.pills[pidStr]?.name ?? `#${pidStr}`}」×${num}`)
          .join('、')
        return `💊 消耗 ${formatCompact(need)} 贡献，获得：${detail}`
      }
      return '类型需为 灵石 / 修为 / 丹药'
    })

  // ================= 接取宗门任务 =================
  ctx.command('接取宗门任务', '接宗门任务，12 小时冷却').alias('宗门任务接取')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      if (p.sectMissionId) return '你已有进行中的宗门任务'

      const cdMs = SECT_MISSION_CONFIG.COOLDOWN_HOURS * 3600 * 1000
      if (p.sectMissionDoneAt && Date.now() - +new Date(p.sectMissionDoneAt) < cdMs) {
        const remainMs = cdMs - (Date.now() - +new Date(p.sectMissionDoneAt))
        return `冷却中，还需 ${formatRemainTime(remainMs)}`
      }

      const lvNum = parseInt(p.level, 10)
      let maxStar = 3
      if (lvNum >= SECT_MISSION_CONFIG.UNLOCK_REALM_FOR_4STAR) maxStar = 4
      if (lvNum >= SECT_MISSION_CONFIG.UNLOCK_REALM_FOR_5STAR) maxStar = 5

      const missionId = 1 + Math.floor(Math.random() * maxStar)
      await ctx.database.set(TABLE.player, { uid: p.uid }, { sectMissionId: missionId })

      const star = SECT_MISSION_CONFIG.STAR_NAMES[missionId] || `${missionId}星`
      return `📜 已接取【${star}】宗门任务，发送「完成宗门任务」挑战妖兽`
    })

  // ================= 完成宗门任务 =================
  ctx.command('完成宗门任务', '挑战任务妖兽').alias('宗门任务完成')
    .action(async ({ session }) => {
      const prep = await requireBattleReadyPlayer(ctx, session)
      if (typeof prep === 'string') return prep
      const { player: p, unit: me } = prep
      if (!p.sectId) {
        await ctx.database.set(TABLE.player, { uid: p.uid }, { sectMissionId: 0 })
        return '未加入宗门'
      }
      if (!p.sectMissionId) return '当前无任务'

      const star = p.sectMissionId
      const now = new Date()

      // 先占用任务（条件更新：任务仍是这一个才成功），同一个任务只能结算一次
      const claim = await ctx.database.set(TABLE.player, {
        uid: p.uid,
        sectMissionId: star,
      }, { sectMissionId: 0, sectMissionDoneAt: now })
      if (getAffectedRows(claim) === 0) return '当前无任务'

      const cfg = SECT_MISSION_CONFIG.STARS[star] ?? SECT_MISSION_CONFIG.STARS[1]
      const boss = buildSectMissionBoss(p.level, star)

      const r = simulateBattle(me, boss)

      recordBattle(p.uid, {
        ts: Date.now(),
        title: `宗门任务「${boss.name}」`,
        log: r.log,
        winner: r.winner,
        playerName: me.name,
        opponentName: boss.name,
      })

      p.hp = me.hp
      p.mp = me.mp

      if (r.winner === 'a') {
        await addStone(ctx, p.uid, cfg.rewardStone)
        await settleSectDaily(ctx, p.sectId)
        await addPlayerContribution(ctx, p.uid, cfg.rewardContrib)

        const buildRes = await ctx.database.set(TABLE.sect, { sectId: p.sectId }, row => ({
          sectScale: $.add(row.sectScale, cfg.rewardBuild),
        }))
        const sectOk = getAffectedRows(buildRes) !== 0

        await recomputeAndSaveStats(ctx, p)

        const sectNote = sectOk
          ? ` + ${formatCompact(cfg.rewardBuild)} 建设度`
          : '（宗门数据异常，未计入建设度）'
        return `⚔️ 击败${boss.name}！奖励 ${formatCompact(cfg.rewardStone)} 灵石 + ${formatCompact(cfg.rewardContrib)} 贡献${sectNote}（你剩余气血 ${formatCompact(me.hp)}/${formatCompact(me.maxhp)}，${formatPct(me.hp, me.maxhp)}%）`
      }

      await recomputeAndSaveStats(ctx, p)
      return `💥 挑战${boss.name}失败（你剩余气血 ${formatCompact(me.hp)}/${formatCompact(me.maxhp)}，${formatPct(me.hp, me.maxhp)}%），下次再来`
    })
}
