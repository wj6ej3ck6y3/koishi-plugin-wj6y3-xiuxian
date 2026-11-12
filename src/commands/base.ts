import { Context, } from 'koishi'
import { data, rollRoot, getLevel, getRoot, } from '../data'
import { TABLE, Player, } from '../models'

import {
  getPlayer, requirePlayer, computeStats,
  getStone, addStone, costStone,
  getBuff, getLearnedSkills, checkBreakthrough, computeOneShotBreakthroughBonus,
  statLabel,
  getBattleRecord,
  truncateDecimal,
  formatPct,
  getAffectedRows,
  getSessionUid,
} from '../utils'

export function registerBaseCommands(ctx: Context) {
  // ---------- 建号 ----------
  ctx.command('我要修仙', '踏上仙途')
    .action(async ({ session }) => {
      const uid = await getSessionUid(ctx, session)
      if (uid === null) {
        return '⚠️ 账号未同步，请稍后重试或联系管理员'
      }
      const exist = await getPlayer(ctx, uid)
      if (exist) return '你已入仙途，无需重复。发送「我的修仙信息」查看。'

      const [rootId, root] = rollRoot()
      const initialLevel = '1'
      const lv = getLevel(initialLevel)!

      const userName = session.username || `无名散修${String(uid).slice(-3)}`

      const player: Player = {
        uid,
        platform: session.platform,
        root: rootId,
        level: initialLevel,
        exercisesLevel: '20001',
        power: lv.power,
        isSign: new Date(0),
        exp: 0,
        userName,
        levelUpCd: new Date(0),
        levelUpRate: 0,
        hp: lv.hp, maxhp: lv.hp,
        mp: lv.mp, maxmp: lv.mp,
        atk: lv.atk,
        atkPractice: 0,
        sectId: 0, sectPosition: 0,
        sectMissionId: 0, sectMissionDoneAt: new Date(0),
        sectContribution: 0, sectOfferingGet: new Date(0),
        blessedSpotFlag: 0, blessedSpotName: '', plotCount: 0,
        riftCd: new Date(0), riftDailyCount: 0,
        workRefreshCountTime: 0, workRefreshCount: 0,
        rebirth: 0, dualCultivation: 0, dualCultivationTime: new Date(0),
        insightCd: new Date(0),
      }
      await ctx.database.create('wj6y3_xiuxian_player', player)

      return [
        `🌱 ${player.userName}，你已踏入仙途！`,
        `灵根：${root.name}（${root.tier}）｜攻击倍率 ×${root.atk}`,
        `境界：${lv.name}`,
        `气血 ${lv.hp} / 真元 ${lv.mp} / 攻击 ${lv.atk}`,
        `发送「我的修仙信息」查看详情，发送「修仙签到」领取灵石。`,
      ].join('\n')
    })

  // ---------- 签到（原子占位） ----------
  ctx.command('修仙签到', '每日签到领取灵石')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const now = new Date()
      const last = new Date(p.isSign)
      if (last.toDateString() === now.toDateString()) return '今日已签到，明日再来。'

      const min = (ctx as any).config?.signMin ?? 1000
      const max = (ctx as any).config?.signMax ?? 2000
      const gain = Math.floor(min + Math.random() * (max - min + 1))

      // ✅ 原子性：只有 isSign 仍是「今日 0 点之前」时才更新成功
      const todayStart = new Date(now)
      todayStart.setHours(0, 0, 0, 0)
      const writeRes: any = await ctx.database.set(TABLE.player, {
        uid: p.uid,
        isSign: { $lt: todayStart },
      }, { isSign: now })

      const affected = getAffectedRows(writeRes)
      if (affected === 0) return '今日已签到，明日再来。'

      const before = await getStone(ctx, p.uid)
      await addStone(ctx, p.uid, gain)
      return `📅 签到成功，获得灵石 ×${gain}，当前灵石 ${before + gain}。`
    })

  // ---------- 我的修仙信息 ----------
  ctx.command('我的修仙信息', '完整存档').alias('修仙信息')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const lv = getLevel(p.level)!
      const root = getRoot(p.root)
      const stone = await getStone(ctx, p.uid)

      const st = await computeStats(ctx, p)
      const buff = await getBuff(ctx, p.uid)
      const learned = await getLearnedSkills(ctx, p.uid)

      const gongfaStatSums: Record<string, number> = {}
      for (const gid of learned.gongfa) {
        const g = data.gongfa[String(gid)]
        if (!g?.modifiers) continue
        for (const m of g.modifiers as any[]) {
          if (m.mode && m.mode !== 'pct') continue
          gongfaStatSums[m.stat] = (gongfaStatSums[m.stat] ?? 0) + m.value
        }
      }
      for (const fid of learned.fuxiu) {
        const sub = data.fuxiu[String(fid)]
        if (!sub) continue
        if (sub.effect === 'hpPct') {
          gongfaStatSums['hp'] = (gongfaStatSums['hp'] ?? 0) + sub.value / 100
        } else if (sub.effect === 'damageBoost') {
          gongfaStatSums['atk'] = (gongfaStatSums['atk'] ?? 0) + sub.value / 100
        }
      }

      const info = checkBreakthrough(p)
      const oneShot = await computeOneShotBreakthroughBonus(ctx, p.uid, p.level)
      const tempRate = p.levelUpRate || 0
      const baseRate = Math.max(0, info.rate - tempRate)
      const dueRate = oneShot.bonus
      const totalRate = Math.min(100, baseRate + tempRate + dueRate)

      const equipItems: Array<{
        icon: string; label: string; id: number; table: any;
        desc?: (m: any) => string
      }> = [
          {
            icon: '⚔️', label: '武器', id: buff.faqiBuff, table: data.weapons,
            desc: (m) => {
              const mods = (m.modifiers ?? []).map((x: any) => `${statLabel(x.stat)} +${(x.value * 100).toFixed(0)}%`).join('、')
              return mods ? `（${mods}）` : ''
            },
          },
          {
            icon: '🛡️', label: '防具', id: buff.armorBuff, table: data.armors,
            desc: (m) => {
              const mods = (m.modifiers ?? []).map((x: any) => `${statLabel(x.stat)} +${(x.value * 100).toFixed(0)}%`).join('、')
              return mods ? `（${mods}）` : ''
            },
          },
          {
            icon: '⚗️', label: '炼丹炉', id: buff.furnaceBuff, table: data.furnaces,
            desc: (m) => `（多产 ${m.bonusQuantity ?? 0} 枚 / 成功率 +${((m.bonusSuccess ?? 0) * 100).toFixed(0)}%）`,
          },
          {
            icon: '🚩', label: '聚灵旗', id: buff.qiFlagBuff, table: data.qiFlags,
            desc: (m) => `（修为 +${((m.cultivateSpeed ?? 0) * 10).toFixed(0)}% / 灵田 +${((m.herbSpeed ?? 0) * 20).toFixed(0)}%）`,
          },
        ]

      const lines: string[] = []
      lines.push(`👤 道号：${p.userName}`)
      lines.push(`灵根：${root?.name ?? '?'}（${root?.tier ?? '?'}）`)
      lines.push(`境界：${lv.name}`)
      lines.push(`战力：${p.power}`)
      lines.push(`修为：${Math.floor(p.exp)}/${lv.expToNext}`)
      lines.push(`灵石：${stone}`)
      lines.push('')

      lines.push('⚔️ 当前属性')
      lines.push(`  气血 ${Math.floor(p.hp)}/${st.hp}（${formatPct(p.hp, st.hp)}%）`)
      lines.push(`  真元 ${Math.floor(p.mp)}/${st.mp}（${formatPct(p.mp, st.mp)}%）`)
      lines.push(`  攻击 ${st.atk}   防御 ${truncateDecimal(st.def)}%   速度 ${st.spd}`)
      lines.push(`  会心 ${(st.crit * 100).toFixed(1)}%   暴伤 ${(st.critDmg * 100).toFixed(0)}%   穿透 ${(st.pen * 100).toFixed(1)}%`)
      lines.push('')

      lines.push(`📖 已学功法数（${learned.gongfa.length}）`)
      lines.push(`📚 已学辅修数（${learned.fuxiu.length}）`)
      lines.push(`✨ 已学神通数（${learned.shentong.length}）`)

      if (learned.gongfa.length > 0) {
        const parts: string[] = []
        for (const [stat, val] of Object.entries(gongfaStatSums)) {
          if (val !== 0) parts.push(`${statLabel(stat)} +${(val * 100).toFixed(0)}%`)
        }
        lines.push(`总加成：${parts.length ? parts.join(' / ') : '无'}`)
      }

      lines.push(`使用「我的功法」、「我的神通」查看详情`)
      lines.push('')

      const bodyLevelId = p.exercisesLevel
      const bodyLevel = bodyLevelId ? data.bodyLevels[bodyLevelId] : undefined
      if (bodyLevel) {
        const bodyModStr = (bodyLevel.modifiers ?? [])
          .map(m => `${statLabel(m.stat)} +${(m.value * 100).toFixed(2)}%`)
          .join('、')
        lines.push(`🗿 炼体：${bodyLevel.name}`)
        if (bodyModStr) lines.push(`  加成：${bodyModStr}`)
      }

      lines.push('已装备')
      for (const eq of equipItems) {
        if (!eq.id) {
          lines.push(`  ${eq.icon} ${eq.label}：无`)
        } else {
          const meta = eq.table?.[String(eq.id)]
          const name = meta?.name ?? `未知#${eq.id}`
          const desc = eq.desc ? eq.desc(meta) : ''
          lines.push(`  ${eq.icon} ${eq.label}：${name}${desc}`)
        }
      }
      lines.push('')

      lines.push('⚡ 突破')
      if (!info.nextLevelId) {
        lines.push('  已至绝巅，唯有飞升')
      } else {
        const nextName = getLevel(info.nextLevelId)?.name
        const canNote = info.canBreak ? '' : '（修为不足）'
        lines.push(`  下一境界：${nextName}${canNote}`)
        lines.push(`  突破概率： ${totalRate}%`)
      }
      lines.push('')

      let sectLine = '无'
      if (p.sectId && p.sectId > 0) {
        const [sect] = await ctx.database.get(TABLE.sect, { sectId: p.sectId })
        if (sect) {
          const POSITION_NAMES = ['散修', '宗主', '长老', '亲传弟子', '内门弟子', '外门弟子']
          sectLine = `${sect.sectName}（${POSITION_NAMES[p.sectPosition] || '未知错误'}）  贡献 ${p.sectContribution}`
        } else {
          sectLine = `数据异常（编号 ${p.sectId}）`
        }
      }
      lines.push(`🏛️ 宗门：${sectLine}`)
      lines.push(`🏞️ 洞府：${p.blessedSpotFlag ? p.blessedSpotName : '无'}`)

      return lines.join('\n')
    })

  // ---------- 灵石 ----------
  ctx.command('灵石', '查看灵石')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      return `💰 你当前拥有灵石 ${await getStone(ctx, p.uid)}。`
    })

  // ---------- 查看战斗详情 ----------
  ctx.command('查看战斗详情', '查看最近 120 秒内的战斗记录').alias('战斗详情')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const rec = getBattleRecord(p.uid)
      if (!rec) return '⏱️ 最近 120 秒内没有战斗记录（或已过期）'

      const winnerName = rec.winner === 'a' ? rec.playerName
        : rec.winner === 'b' ? rec.opponentName
          : '平局'

      const grouped = new Map<number, string[]>()
      for (const e of rec.log) {
        if (!grouped.has(e.round)) grouped.set(e.round, [])
        grouped.get(e.round)!.push(e.text)
      }
      const body = [...grouped.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([round, lines]) => `【第 ${round} 回合】\n${lines.map(t => '  ' + t).join('\n')}`)
        .join('\n')

      return [
        `⚔️ ${rec.title}`,
        `🏆 ${winnerName} 获胜`,
        '',
        body,
      ].join('\n')
    })

  // ---------- 改名 ----------
  ctx.command('修改道号 <name:string>', '修改道号（消耗 50000 × 境界ID 灵石）')
    .action(async ({ session }, name) => {
      if (!name) return '请输入新的道号'
      if (Buffer.byteLength(name, 'utf-8') > 30) return '道号过长（最多 30 字节）'

      const p = await requirePlayer(ctx, session)

      // 灵石消耗 = 50000 × 当前境界ID（境界ID取数值，最低按 1）
      const lvNum = Math.max(1, parseInt(p.level, 10) || 1)
      const cost = 50_000 * lvNum

      if (!(await costStone(ctx, p.uid, cost))) {
        return `💎 灵石不足：修改道号需 ${cost} 灵石（50000 × 境界 ${lvNum}），当前 ${await getStone(ctx, p.uid)}`
      }

      await ctx.database.set(TABLE.player, { uid: p.uid }, { userName: name })
      return `✅ 道号已更改为「${name}」（消耗 ${cost} 灵石）`
    })

  // ---------- 排行榜 ----------
  ctx.command('修仙排行榜 [type:string]', '查看排行榜')
    .action(async ({ session }, type = '境界') => {
      const limit = 10
      if (type === '灵石') {
        if (!ctx.get('monetary')) return '灵石排行榜需 monetary 服务'
        const all = await ctx.database.get(TABLE.player, {})
        const rows = await Promise.all(all.map(async p => ({ p, s: await getStone(ctx, p.uid) })))
        rows.sort((a, b) => b.s - a.s)
        return '💎 灵石排行榜 TOP10\n' + rows.slice(0, limit)
          .map((r, i) => `${i + 1}. ${r.p.userName} - ${r.s}`).join('\n')
      }
      if (type === '战力') {
        const rows = await ctx.database.get(TABLE.player, {}, { sort: { power: 'desc' }, limit })
        return '⚔️ 战力排行榜 TOP10\n' + rows
          .map((r, i) => `${i + 1}. ${r.userName} - ${r.power}`).join('\n')
      }
      const rows = await ctx.database.get(TABLE.player, {}, { limit: 500 })
      rows.sort((a, b) => parseInt(b.level) - parseInt(a.level) || b.exp - a.exp)
      return '🌌 境界排行榜 TOP10\n' + rows.slice(0, limit)
        .map((r, i) => `${i + 1}. ${r.userName} - ${getLevel(r.level)?.name}`).join('\n')
    })
}