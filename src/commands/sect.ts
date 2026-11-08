import { Context } from 'koishi'
import { data } from '../data'
import { TABLE } from '../models'
import {
  requirePlayer, addStone, costStone, getPlayer,
  simulateBattle,
  getNextId,
  refreshPlayerStats,
  preparePlayerBattle,
  addItem,
  recordBattle,
  CombatUnit,
  formatRemainTime,
  formatPct,
} from '../utils'

const POSITION_NAMES = ['散修', '宗主', '长老', '亲传弟子', '内门弟子', '外门弟子']

// ======================= 宗门任务数值配置 =======================
const SECT_MISSION_CONFIG = {
  STARS: {
    1: { hpMul: 0.7, atkMul: 0.7, defMul: 0.7, rewardStone: 500, rewardContrib: 50, rewardBuild: 50 },
    2: { hpMul: 0.9, atkMul: 0.9, defMul: 0.9, rewardStone: 1000, rewardContrib: 50, rewardBuild: 100 },
    3: { hpMul: 1.1, atkMul: 1.1, defMul: 1.1, rewardStone: 1500, rewardContrib: 50, rewardBuild: 150 },
    4: { hpMul: 1.4, atkMul: 1.4, defMul: 1.4, rewardStone: 2000, rewardContrib: 50, rewardBuild: 200 },
    5: { hpMul: 1.8, atkMul: 1.8, defMul: 1.8, rewardStone: 2500, rewardContrib: 50, rewardBuild: 250 },
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

export async function settleSectDaily(ctx: Context, onlySectId?: number): Promise<void> {
  const now = new Date()
  const today = now.toDateString()

  const sects = onlySectId !== undefined
    ? await ctx.database.get(TABLE.sect, { sectId: onlySectId })
    : await ctx.database.get(TABLE.sect, {})

  for (const sect of sects) {
    const snapshotAt = sect.offeringSnapshotAt ? new Date(sect.offeringSnapshotAt) : new Date(0)
    if (snapshotAt.toDateString() === today) continue

    const buildBonus = Math.floor((sect.sectScale ?? 0) / 10000)
    const stoneAfter = Math.floor(sect.sectUsedStone ?? 0) + buildBonus
    const snapshot = Math.floor(stoneAfter * 0.001)

    await ctx.database.set(TABLE.sect, { sectId: sect.sectId }, {
      sectUsedStone: stoneAfter,
      offeringSnapshot: snapshot,
      offeringSnapshotAt: now,
    })
  }
}

export function registerSectCommands(ctx: Context) {
  // ================= 帮助 =================
  ctx.command('宗门帮助', '宗门指令列表').action(() => [
    '创建宗门 [名称]    我的宗门    宗门列表    加入宗门 [编号/名称]',
    '宗门捐献 [灵石数]    宗门成员查看    退出宗门',
    '宗门职位变更 [1-4] [@成员]    踢出宗门 [@成员]    宗主传位 [@成员]',
    '宗门每日供奉    宗门贡献兑换 [灵石|修为|丹药] [数量]',
    '接取宗门任务    完成宗门任务',
  ].join('\n'))

  // ================= 创建 =================
  ctx.command('创建宗门 <name:string>', '创建宗门')
    .action(async ({ session }, name) => {
      if (!name) return '请提供宗门名称'
      const p = await requirePlayer(ctx, session)
      if (p.sectId && p.sectId > 0) return '你已加入宗门，需先退出'
      const need = 100000
      if (!(await costStone(ctx, p.uid, need))) return `创建宗门需 ${need} 灵石，灵石不足`

      const sectId = await getNextId(ctx, TABLE.sect, 'sectId')
      try {
        await ctx.database.create(TABLE.sect, {
          sectId,
          sectName: name, sectOwner: p.userId,
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

      await ctx.database.set(TABLE.player, { userId: p.userId }, {
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
      return [
        `⛩️ ${sect.sectName}（编号 ${sect.sectId}）`,
        `宗主：${(await getPlayer(ctx, sect.sectOwner))?.userName ?? '未知'}`,
        `建设度：${sect.sectScale}   可用灵石：${sect.sectUsedStone}   资材：${sect.sectMaterials}`,
        `成员：${members.length}   我的职位：${POSITION_NAMES[p.sectPosition] || '未知错误'}   个人贡献：${p.sectContribution}`,
      ].join('\n')
    })

  // ================= 宗门列表 =================
  ctx.command('宗门列表', '所有宗门').action(async () => {
    const sects = await ctx.database.get(TABLE.sect, {}, { sort: { sectScale: 'desc' }, limit: 30 })
    if (!sects.length) return '尚无宗门'
    return '⛩️ 宗门列表\n' + sects.map((s, i) => `${i + 1}. ${s.sectName}（编号 ${s.sectId}）建设度 ${s.sectScale}`).join('\n')
  })

  // ================= 加入 =================
  ctx.command('加入宗门 <target:string>', '加入宗门')
    .action(async ({ session }, target) => {
      if (!target) return '请输入宗门编号或名称'
      const p = await requirePlayer(ctx, session)
      if (p.sectId) return '已在宗门中'
      let sect
      if (/^\d+$/.test(target)) {
        const rows = await ctx.database.get(TABLE.sect, { sectId: Number(target) }); sect = rows[0]
      } else {
        const rows = await ctx.database.get(TABLE.sect, { sectName: target }); sect = rows[0]
      }
      if (!sect) return '宗门不存在'
      await ctx.database.set(TABLE.player, { userId: p.userId }, { sectId: sect.sectId, sectPosition: 5 })
      return `✅ 已加入「${sect.sectName}」，成为外门弟子`
    })

  // ================= 捐献 =================
  ctx.command('宗门捐献 <amount:number>', '捐献灵石')
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0) return '请输入正整数'
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      const actualSpend = Math.floor(amount / 10) * 10
      if (actualSpend < 10) return '至少捐献 10 灵石'

      await settleSectDaily(ctx, p.sectId)

      if (!(await costStone(ctx, p.uid, actualSpend))) return '灵石不足'
      const [sect] = await ctx.database.get(TABLE.sect, { sectId: p.sectId })
      await ctx.database.set(TABLE.sect, { sectId: p.sectId }, {
        sectScale: sect.sectScale + actualSpend,
        sectUsedStone: sect.sectUsedStone + actualSpend,
      })
      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        sectContribution: p.sectContribution + actualSpend / 10,
      })
      return `💎 捐献 ${actualSpend} 灵石，建设度 +${actualSpend}，个人贡献 +${actualSpend / 10}`
    })

  // ================= 成员 =================
  ctx.command('宗门成员查看', '本宗门成员').alias('查看宗门成员').alias('宗门成员')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      const members = await ctx.database.get(TABLE.player, { sectId: p.sectId })
      const grouped: Record<number, string[]> = {}
      for (const m of members) {
        (grouped[m.sectPosition] ??= []).push(`${m.userName}(${m.sectContribution})`)
      }
      return Object.keys(grouped).sort().map(pos => {
        const n = Number(pos)
        return `${POSITION_NAMES[n] || '未知错误'}：${grouped[n].join('、')}`
      }).join('\n')
    })

  // ================= 职位变更 =================
  ctx.command('宗门职位变更 <pos:number>', '调整成员职位').alias('宗门职位调整')
    .action(async ({ session }, pos) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      if (p.sectPosition <= 0) return '你没有宗门职位，无法管理人员'

      if (pos < 2 || pos > 5) {
        return '职位值需在 2-5 之间（2长老 / 3亲传 / 4内门 / 5外门）'
      }

      if (pos <= p.sectPosition) {
        return '你不能将其他成员的职位设置得与自己同级或更高'
      }

      const target = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
      if (!target) return '请 @ 目标成员'
      if (target === p.userId) return '不能变更自己的职位，如需传位请使用「宗主传位」'

      const rows = await ctx.database.get(TABLE.player, { userId: target })
      if (!rows[0] || rows[0].sectId !== p.sectId) return '该成员不在你的宗门'

      if (rows[0].sectPosition <= p.sectPosition) {
        return '你不能变更同级或更高级别成员的职位'
      }

      await ctx.database.set(TABLE.player, { userId: target }, { sectPosition: pos })
      return `✅ 已将 ${rows[0].userName} 调整为「${POSITION_NAMES[pos] || '未知错误'}」`
    })

  // ================= 踢人 =================
  ctx.command('踢出宗门', '踢出成员')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.sectPosition !== 1) return '只有宗主可踢人'
      const target = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
      if (!target) return '请 @ 目标成员'
      if (target === p.userId) return '不能踢自己'
      const rows = await ctx.database.get(TABLE.player, { userId: target })
      if (!rows[0] || rows[0].sectId !== p.sectId) return '目标不在本宗门'
      await ctx.database.set(TABLE.player, { userId: target }, { sectId: 0, sectPosition: 0 })
      return `✅ 已踢出宗门`
    })

  // ================= 传位 =================
  ctx.command('宗主传位', '转让宗主')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (p.sectPosition !== 1) return '只有宗主可传位'
      const target = (session as any).elements?.find((e: any) => e.type === 'at')?.attrs?.id
      if (!target) return '请 @ 目标成员'
      const rows = await ctx.database.get(TABLE.player, { userId: target })
      if (!rows[0] || rows[0].sectId !== p.sectId) return '目标不在本宗门'
      await ctx.database.set(TABLE.sect, { sectId: p.sectId }, { sectOwner: target })
      await ctx.database.set(TABLE.player, { userId: target }, { sectPosition: 1 })
      await ctx.database.set(TABLE.player, { userId: p.userId }, { sectPosition: 2 })
      return `✅ 已将宗主之位传给 ${rows[0].userName}`
    })

  // ================= 退出 =================
  ctx.command('退出宗门', '退出当前宗门')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectId) return '未加入宗门'
      if (p.sectPosition === 1) return '宗主需先传位或解散宗门（暂不支持解散）'

      // ✅ B5：退出时清空进行中的宗门任务（不清 sectMissionDoneAt，保留 CD 语义）
      await ctx.database.set(TABLE.player, { userId: p.userId }, {
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
      if (p.uid === null) return '灵石服务未同步'

      const now = new Date()
      const last = new Date(p.sectOfferingGet)
      if (last.toDateString() === now.toDateString()) return '今日已领取供奉'

      await settleSectDaily(ctx, p.sectId)

      const [sect] = await ctx.database.get(TABLE.sect, { sectId: p.sectId })
      if (!sect) return '宗门不存在（数据异常），请联系管理员'

      const snapshot = sect.offeringSnapshot ?? 0

      if (snapshot <= 0) {
        await ctx.database.set(TABLE.player, { userId: p.userId }, { sectOfferingGet: now })
        return '🎁 今日宗门灵石不足，供奉无法发放'
      }

      const ratioPermille: Record<number, number> = { 1: 1750, 2: 1500, 3: 750, 4: 300, 5: 100 }
      const permille = ratioPermille[p.sectPosition]
      if (!permille) return '你的宗门职位异常，请联系管理员'
      const amount = Math.floor(snapshot * permille / 1000)

      if (amount <= 0) {
        await ctx.database.set(TABLE.player, { userId: p.userId }, { sectOfferingGet: now })
        return '🎁 今日宗门供奉过少，不足 1 灵石'
      }

      if ((sect.sectUsedStone ?? 0) < amount) {
        return `🎁 宗门灵石不足，请稍后再试`
      }

      await ctx.database.set(TABLE.sect, { sectId: p.sectId }, {
        sectUsedStone: Math.floor(sect.sectUsedStone - amount),
      })
      await addStone(ctx, p.uid, amount)

      let extra = ''
      if (Math.random() < 0.2) {
        await addItem(ctx, p.userId, 1101, 1)
        extra = '，额外获得「生骨丹」×1'
      }

      await ctx.database.set(TABLE.player, { userId: p.userId }, { sectOfferingGet: now })

      const posName = ['', '宗主', '长老', '亲传弟子', '内门弟子', '外门弟子'][p.sectPosition] ?? `#${p.sectPosition}`
      return [
        `🎁 ${posName}领取供奉：${amount}${extra}`,
        `宗门灵石剩余：${Math.floor(sect.sectUsedStone - amount)}`,
      ].join('\n')
    })

  // ================= 贡献兑换 =================
  ctx.command('宗门贡献兑换 <type:string> [count:number]', '兑换').alias('贡献兑换')
    .action(async ({ session }, type, count = 1) => {
      const p = await requirePlayer(ctx, session)
      if (!p.sectContribution || p.sectContribution <= 0) return '没有贡献'
      if (type === '灵石') {
        const need = 10 * count
        if (p.sectContribution < need) return `需贡献 ${need}`
        await ctx.database.set(TABLE.player, { userId: p.userId }, { sectContribution: p.sectContribution - need })
        await addStone(ctx, p.uid, count * 1000)
        return `💎 用 ${need} 贡献兑换 ${count * 1000} 灵石`
      }
      if (type === '修为') {
        const need = 5 * count
        if (p.sectContribution < need) return `需贡献 ${need}`
        await ctx.database.set(TABLE.player, { userId: p.userId }, { sectContribution: p.sectContribution - need, exp: p.exp + count * 500 })
        return `🌱 用 ${need} 贡献兑换 ${count * 500} 修为`
      }
      if (type === '丹药') {
        const PER_COST = 200
        const actualCount = Math.max(1, Math.floor(Number(count) || 1))
        const need = PER_COST * actualCount
        if (p.sectContribution < need) {
          return `批量兑换 ${actualCount} 颗回复丹需 ${need} 贡献（当前 ${Math.floor(p.sectContribution)}）`
        }

        const allHealPills = Object.entries(data.pills as Record<string, any>)
          .filter(([, v]) => (v?.modifiers ?? []).some((m: any) => m.stat === 'hp' || m.stat === 'mp'))

        const lvNum = parseInt(p.level, 10) || 1
        const buildPool = (src: [string, any][]) => src.map(([id, v]) => ({
          id: Number(id),
          weight: Math.max(1, Number(v.weight) || 1),
        }))

        let pool = buildPool(allHealPills.filter(([, v]) => !v.realm || lvNum >= Number(v.realm)))
        if (pool.length === 0) pool = buildPool(allHealPills)
        if (pool.length === 0) return '暂无可兑换的回复丹药'

        const pickWeighted = () => {
          const total = pool.reduce((s, it) => s + it.weight, 0)
          let r = Math.random() * total
          for (const it of pool) {
            r -= it.weight
            if (r <= 0) return it.id
          }
          return pool[pool.length - 1].id
        }

        const got: Record<number, number> = {}
        for (let i = 0; i < actualCount; i++) {
          const pid = pickWeighted()
          got[pid] = (got[pid] ?? 0) + 1
        }

        await ctx.database.set(TABLE.player, { userId: p.userId }, {
          sectContribution: p.sectContribution - need,
        })
        for (const [pidStr, num] of Object.entries(got)) {
          await addItem(ctx, p.userId, Number(pidStr), num)
        }

        const detail = Object.entries(got)
          .map(([pidStr, num]) => `「${(data.pills as any)[pidStr]?.name ?? `#${pidStr}`}」×${num}`)
          .join('、')
        return `💊 消耗 ${need} 贡献，获得：${detail}`
      }
      return '类型需为 灵石 / 修为 / 丹药'
    })

  // ================= 接取宗门任务 =================
  ctx.command('接取宗门任务', '接宗门任务').alias('宗门任务接取')
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
      await ctx.database.set(TABLE.player, { userId: p.userId }, { sectMissionId: missionId })

      const star = SECT_MISSION_CONFIG.STAR_NAMES[missionId] || `${missionId}星`
      return `📜 已接取【${star}】宗门任务，发送「完成宗门任务」挑战妖兽`
    })

  // ================= 完成宗门任务 =================
  ctx.command('完成宗门任务', '挑战任务妖兽').alias('宗门任务完成')
    .action(async ({ session }) => {
      const prep = await preparePlayerBattle(ctx, session)
      if (typeof prep === 'string') return prep
      const { player: p, stats: st, unit: me } = prep
      if (!p.sectId) {
        await ctx.database.set(TABLE.player, { userId: p.userId }, { sectMissionId: 0 })
        return '未加入宗门'
      }
      if (!p.sectMissionId) return '当前无任务'

      const star = p.sectMissionId
      const cfg = SECT_MISSION_CONFIG.STARS[star] ?? SECT_MISSION_CONFIG.STARS[1]
      const boss = buildSectMissionBoss(p.level, star)

      const r = simulateBattle(me, boss)

      recordBattle(p.userId, {
        ts: Date.now(),
        title: `宗门任务「${boss.name}」`,
        log: r.log,
        winner: r.winner,
        playerName: me.name,
        opponentName: boss.name,
      })

      const now = new Date()

      if (r.winner === 'a') {
        await addStone(ctx, p.uid, cfg.rewardStone)
        p.hp = me.hp
        p.mp = me.mp

        await settleSectDaily(ctx, p.sectId)

        await ctx.database.set(TABLE.player, { userId: p.userId }, {
          sectMissionId: 0,
          sectContribution: p.sectContribution + cfg.rewardContrib,
          sectMissionDoneAt: now,
        })

        const [sect] = await ctx.database.get(TABLE.sect, { sectId: p.sectId })
        if (sect) {
          await ctx.database.set(TABLE.sect, { sectId: p.sectId }, {
            sectScale: (sect.sectScale ?? 0) + cfg.rewardBuild,
          })
        }

        await refreshPlayerStats(ctx, p)

        const sectNote = sect
          ? ` + ${cfg.rewardBuild} 建设度`
          : '（宗门数据异常，未计入建设度）'
        return `⚔️ 击败${boss.name}！奖励 ${cfg.rewardStone} 灵石 + ${cfg.rewardContrib} 贡献${sectNote}（你剩余气血 ${me.hp}/${me.maxhp}，${formatPct(me.hp, me.maxhp)}%）`
      }

      p.hp = me.hp
      p.mp = me.mp
      await ctx.database.set(TABLE.player, { userId: p.userId }, {
        sectMissionId: 0,
        sectMissionDoneAt: now,
      })
      await refreshPlayerStats(ctx, p)
      return `💥 挑战${boss.name}失败（你剩余气血 ${me.hp}/${me.maxhp}，${formatPct(me.hp, me.maxhp)}%），下次再来`
    })
}