import { Context, } from 'koishi'
import { data, rollRoot, getLevel, getRoot, } from '../data'
import { TABLE, Player, } from '../models'

import {
  getPlayer, requirePlayer, computeStats,
  getStone, addStone,
  getBuff, getLearnedSkills, checkBreakthrough, computeOneShotBreakthroughBonus,
  statLabel,
  getBattleRecord,
  truncateDecimal,
  formatPct,
} from '../utils'

export function registerBaseCommands(ctx: Context) {
  // ---------- 建号 ----------
  ctx.command('我要修仙', '踏上仙途')
    .action(async ({ session }) => {
      const userId = session.userId!
      const exist = await getPlayer(ctx, userId)
      if (exist) return '你已入仙途，无需重复。发送「我的修仙信息」查看。'
      // 优先用 session.user.id（Koishi 内部主键），它是 monetary 用的 id
      // 兜底走 database.getUser（首次会话时可能 user 还没同步）
      let uid: number | null = (session as any).user?.id ?? null
      if (uid === null) {
        const user = await ctx.database.getUser(session.platform as any, userId)
        if (user && typeof user.id === 'number') uid = user.id
      }
      if (uid === null) {
        ctx.logger('xiuxian').warn(`玩家 ${userId} 建号时 uid 获取失败，将在首次操作时重试`)
      }
      const [rootId, root] = rollRoot()
      const initialLevel = '1'
      const lv = getLevel(initialLevel)!

      const player: Player = {
        userId,
        platform: session.platform,
        uid,                              // ✅ 不再 ?? 0
        root: rootId,
        level: initialLevel,
        exercisesLevel: '20001',          // ✅ 3.2：开局筋骨境一层
        power: lv.power,
        isSign: new Date(0),
        exp: 0,
        userName: session.username || `无名散修${userId.slice(-3)}`,
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

  // ---------- 签到 ----------
  ctx.command('修仙签到', '每日签到领取灵石')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const now = new Date()
      const last = new Date(p.isSign)
      if (last.toDateString() === now.toDateString()) return '今日已签到，明日再来。'
      if (p.uid === null) return '⚠️ 灵石服务未同步，请稍后重试或联系管理员'

      const min = (ctx as any).config?.signMin ?? 1000
      const max = (ctx as any).config?.signMax ?? 2000
      const gain = Math.floor(min + Math.random() * (max - min + 1))

      // ✅ 先读余额，再发放，显示时用 before + gain
      const before = await getStone(ctx, p.uid)
      await addStone(ctx, p.uid, gain)
      await ctx.database.set(TABLE.player, { userId: p.userId }, { isSign: now })

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
      const buff = await getBuff(ctx, p.userId)
      const learned = await getLearnedSkills(ctx, p.userId)

      // ===== 主功法 + 辅修累计加成 =====
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

      // ===== 突破率三段拆解 =====
      const info = checkBreakthrough(p)
      const oneShot = await computeOneShotBreakthroughBonus(ctx, p.userId, p.level)
      const tempRate = p.levelUpRate || 0
      const baseRate = Math.max(0, info.rate - tempRate)  // info.rate 已含 tempRate
      const dueRate = oneShot.bonus
      const totalRate = Math.min(100, baseRate + tempRate + dueRate)

      // ===== 装备槽 =====
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

      // 状态
      lines.push('⚔️ 当前属性')
      lines.push(`  气血 ${Math.floor(p.hp)}/${st.hp}（${formatPct(p.hp, st.hp)}%）`)
      lines.push(`  真元 ${Math.floor(p.mp)}/${st.mp}（${formatPct(p.mp, st.mp)}%）`)
      lines.push(`  攻击 ${st.atk}   防御 ${truncateDecimal(st.def)}%   速度 ${st.spd}`)
      lines.push(`  会心 ${(st.crit * 100).toFixed(1)}%   暴伤 ${(st.critDmg * 100).toFixed(0)}%   穿透 ${(st.pen * 100).toFixed(1)}%`)
      lines.push('')

      // 已学
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

      // 炼体境界
      const bodyLevelId = p.exercisesLevel
      const bodyLevel = bodyLevelId ? data.bodyLevels[bodyLevelId] : undefined
      if (bodyLevel) {
        const bodyModStr = (bodyLevel.modifiers ?? [])
          .map(m => `${statLabel(m.stat)} +${(m.value * 100).toFixed(2)}%`)
          .join('、')
        lines.push(`🗿 炼体：${bodyLevel.name}`)
        if (bodyModStr) lines.push(`  加成：${bodyModStr}`)
      }

      // 装备
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

      // 突破
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

      // 其它
      // 宗门行：查 sect 表拿名称
      let sectLine = '无'
      if (p.sectId && p.sectId > 0) {
        const [sect] = await ctx.database.get(TABLE.sect, { sectId: p.sectId })
        if (sect) {
          const POSITION_NAMES = ['散修', '宗主', '长老', '亲传弟子', '内门弟子', '外门弟子']
          sectLine = `${sect.sectName}（${POSITION_NAMES[p.sectPosition] || '未知错误'}）  贡献 ${p.sectContribution}`
        } else {
          // sectId 指向不存在的宗门（脏数据）→ 显示异常提示，不崩
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
      if (p.uid === null) return '⚠️ 灵石服务未同步，请稍后重试或联系管理员'
      return `💰 你当前拥有灵石 ${await getStone(ctx, p.uid)}。`
    })

  // ---------- 查看战斗详情 ----------
  ctx.command('查看战斗详情', '查看最近 120 秒内的战斗记录').alias('战斗详情')
    .action(async ({ session }) => {
      const p = await requirePlayer(ctx, session)
      const rec = getBattleRecord(p.userId)
      if (!rec) return '⏱️ 最近 120 秒内没有战斗记录（或已过期）'

      const winnerName = rec.winner === 'a' ? rec.playerName
        : rec.winner === 'b' ? rec.opponentName
          : '平局'

      // 按回合分组
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
  ctx.command('修改道号 <name:string>', '修改道号')
    .action(async ({ session }, name) => {
      if (!name) return '请输入新的道号'
      if (Buffer.byteLength(name, 'utf-8') > 30) return '道号过长（最多 30 字节）'
      const p = await requirePlayer(ctx, session)
      await ctx.database.set(TABLE.player, { userId: p.userId }, { userName: name })
      return `✅ 道号已更改为「${name}」`
    })

  // ---------- 排行榜 ----------
  ctx.command('修仙排行榜 [type:string]', '查看排行榜')
    .action(async ({ session }, type = '境界') => {
      const limit = 10
      if (type === '灵石') {
        // 从 monetary 拉 uid 列表（若服务可用）
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
      // 默认境界
      const rows = await ctx.database.get(TABLE.player, {}, { limit: 500 })
      rows.sort((a, b) => parseInt(b.level) - parseInt(a.level) || b.exp - a.exp)
      return '🌌 境界排行榜 TOP10\n' + rows.slice(0, limit)
        .map((r, i) => `${i + 1}. ${r.userName} - ${getLevel(r.level)?.name}`).join('\n')
    })
}