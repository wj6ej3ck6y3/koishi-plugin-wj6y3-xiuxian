import { Context } from 'koishi'
import { Config } from './config'
import { defineModels } from './models'
import { registerBaseCommands } from './commands/base'
import { registerCultivateCommands } from './commands/cultivate'
import { registerBackpackCommands } from './commands/backpack'
import { registerSectCommands, settleSectDaily } from './commands/sect'
import { registerBountyCommands } from './commands/bounty'
import { registerBankCommands } from './commands/bank'
import { registerBossCommands } from './commands/boss'
import { registerRiftCommands } from './commands/rift'
import { registerAlchemyCommands } from './commands/alchemy'
import { registerBodyCommands } from './commands/body'
import { registerSpotCommands } from './commands/spot'
import { registerShopCommands } from './commands/shop'
import { registerGambleCommands, cleanupGambleCds } from './commands/gamble'
import { registerLongtermCommands } from './commands/longterm'
import { registerAdminCommands } from './commands/admin'
import { getPlayer, resetDaily, getItemNameById, getNextId, addItem, estimatePrice, getSessionUid } from './utils'
import { TABLE } from './models'

export const name = 'xiuxian'
export const inject = {
  required: ['database', 'monetary'],
  optional: ['cron'],
}
export { Config }

const COMMAND_AUTHORITY: Record<string, number> = {
  '神秘力量': 5,
  '重置状态': 5,
  '创建世界boss': 5,
  '系统坊市上架': 5,
}

export function apply(ctx: Context, config: Config) {
  ; (ctx as any).config = config
  defineModels(ctx)

  registerBaseCommands(ctx)
  registerCultivateCommands(ctx)
  registerBackpackCommands(ctx)
  registerSectCommands(ctx)
  registerBountyCommands(ctx)
  registerBankCommands(ctx)
  registerBossCommands(ctx)
  registerRiftCommands(ctx)
  registerAlchemyCommands(ctx)
  registerBodyCommands(ctx)
  registerSpotCommands(ctx)
  registerShopCommands(ctx)
  registerGambleCommands(ctx)
  registerLongtermCommands(ctx)
  registerAdminCommands(ctx)

  setupTimers(ctx, config)

  // ======================= 未建号玩家拦截 =======================

  const XIUXIAN_GAME_COMMANDS = new Set([
    '修仙签到', '我的修仙信息', '修仙信息', '灵石',
    '查看战斗详情', '战斗详情', '修改道号', '修仙排行榜',
    '闭关', '出关', '灵石修炼', '灵石修仙',
    '突破', '突破信息', '直接突破', '渡厄突破', '抑制黑暗动乱',
    '我的背包', '我的物品', '修仙物品', '查看背包', '卸下', '使用',
    '我的功法', '我的神通',
    '坊市购买', '坊市上架', '坊市下架', '系统回收',
    '创建宗门', '我的宗门', '宗门信息', '宗门',
    '宗门列表', '加入宗门', '退出宗门', '宗门捐献',
    '宗门成员查看', '查看宗门成员', '宗门成员',
    '宗门职位变更', '踢出宗门', '宗主传位',
    '宗门每日供奉', '宗门供奉', '领取宗门俸禄', '宗门俸禄',
    '宗门贡献兑换', '贡献兑换',
    '接取宗门任务', '宗门任务接取', '完成宗门任务', '宗门任务完成',
    '悬赏令', '悬赏令刷新', '悬赏令接取', '悬赏令结算', '最后的悬赏令', '悬赏令终止',
    '灵庄', '灵庄存灵石', '存灵石', '灵庄取灵石', '取灵石',
    '灵庄结算', '灵庄升级', '灵庄信息', '查看灵庄',
    '讨伐世界boss', '探索秘境',
    '炼丹', '炼制', '炼体', '炼体信息', '查看炼体', '炼体突破',
    '重入仙途', '参悟传承', '升级攻击修炼',
    '参悟天机', '顿悟', '飞升转世', '飞升', '转世',
    '我的转世', '查看转世', '双修', '我的双修次数',
    '开辟洞府', '洞府开辟', '灵气升级', '洞府升级',
    '开垦灵田', '洞府开垦', '灵田种植', '洞府种植',
    '灵田收获', '洞府收获', '查看灵田',
    '洞府信息', '我的洞府', '洞府改名', '重命名洞府',
    '金银阁', '虚神界对决', '接受对决', '拒绝对决', '抢灵石',
  ])

  const NEVER_BLOCK = new Set(['我要修仙'])

  // 权限检查（保持原样，用 Koishi 原生 getUser）
  ctx.before('command/execute', async (argv: any) => {
    const session = argv?.session
    const cmdName = (argv?.command?.name ?? '').split('/').pop() || ''
    if (!session?.userId || !cmdName) return

    const required = COMMAND_AUTHORITY[cmdName]
    if (required === undefined) return

    let auth: number = (session as any).authority ?? 0
    if (auth === 0) {
      try {
        const user = await ctx.database.getUser(session.platform as any, session.userId)
        auth = (user as any)?.authority ?? 0
      } catch { /* ignore */ }
    }
    if (auth < required) return '权限不足'
  })

  // 未建号拦截（改用 uid）
  ctx.before('command/execute', async (argv: any) => {
    const session = argv?.session
    const cmdNameRaw: string = argv?.command?.name ?? ''
    if (!session?.userId || !cmdNameRaw) return

    const cmdName = cmdNameRaw.split('/').pop() || cmdNameRaw
    if (NEVER_BLOCK.has(cmdName)) return
    if (!XIUXIAN_GAME_COMMANDS.has(cmdName)) return

    const uid = await getSessionUid(ctx, session)
    if (uid === null) return '⚠️ 账号未同步，请稍后重试'
    const p = await getPlayer(ctx, uid)
    if (p) return

    return '⚠️ 你尚未踏入仙途，请先发送「我要修仙」加入仙途。'
  })

  ctx.on('ready', async () => {
    ctx.logger('xiuxian').info('修仙插件已加载')
    try {
      await settleSectDaily(ctx)
    } catch (e: any) {
      ctx.logger('xiuxian').warn(`加载时宗门每日结算失败: ${e?.message ?? e}`)
    }
  })
}

// ======================= 定时任务 =======================
function setupTimers(ctx: Context, config: Config) {
  const logger = ctx.logger('xiuxian')

  const runHourly = async () => {
    const t0 = Date.now()
    logger.debug('[定时任务] 开始：坊市每小时任务')
    try {
      await runHourlyShopJob(ctx, config)
      logger.debug(`[定时任务] 完成：坊市每小时任务（耗时 ${Date.now() - t0}ms）`)
    } catch (e: any) {
      logger.warn(`[定时任务] 坊市每小时任务失败: ${e?.message ?? e}`)
    }
    try {
      cleanupGambleCds()
      logger.debug('[定时任务] 完成：内存 CD 清理')
    } catch (e: any) {
      logger.warn(`[定时任务] 内存 CD 清理失败: ${e?.message ?? e}`)
    }
  }

  const runDaily = async () => {
    const t0 = Date.now()
    logger.debug('[定时任务] 开始：每日重置 + 宗门每日结算')
    try { await resetDaily(ctx); logger.debug('[定时任务] 完成：每日重置') } catch (e: any) { logger.warn(`[定时任务] 每日重置失败: ${e?.message ?? e}`) }
    try { await settleSectDaily(ctx); logger.debug('[定时任务] 完成：宗门每日结算') } catch (e: any) { logger.warn(`[定时任务] 宗门每日结算失败: ${e?.message ?? e}`) }
    logger.debug(`[定时任务] 完成：每日任务总耗时 ${Date.now() - t0}ms`)
  }

  let cronBound = false
  const bindCron = (scope: Context): boolean => {
    if (cronBound) return true
    const s = scope as any
    if (typeof s.cron !== 'function') return false
    try {
      s.cron('0 0 * * *', () => { logger.debug('[定时任务] cron 触发：0 0 * * *'); return runDaily() })
      s.cron('0 * * * *', () => { logger.debug('[定时任务] cron 触发：0 * * * *'); return runHourly() })
      cronBound = true
      logger.info('定时任务已启用 cron 模式')
      return true
    } catch (e: any) {
      logger.warn(`[定时任务] cron 注册失败: ${e?.message ?? e}`)
      return false
    }
  }

  ctx.inject(['cron'], (scope) => { bindCron(scope) })
  ctx.on('ready', () => { bindCron(ctx) })

  ctx.setInterval(async () => {
    if (cronBound) return
    await runHourly()
  }, 60 * 60 * 1000)

  ctx.setInterval(async () => {
    if (cronBound) return
    const now = new Date()
    if (now.getHours() === 0 && now.getMinutes() === 0) await runDaily()
  }, 60_000)

  ctx.setTimeout(() => {
    if (!cronBound) logger.info('定时任务已回退到 setInterval 模式')
  }, 5_000)
}

async function runHourlyShopJob(ctx: Context, config: Config) {
  const now = Date.now()
  const expireMs = (config.shopExpireHours ?? 72) * 3600 * 1000

  const all = await ctx.database.get(TABLE.shop, {})
  let expired = 0
  for (const s of all) {
    if (now - +new Date(s.createTime) >= expireMs) {
      if (s.sellerUid !== 0) {
        await addItem(ctx, s.sellerUid, s.goodsId, s.goodsNum)
      }
      await ctx.database.remove(TABLE.shop, { id: s.id })
      expired++
    }
  }
  if (expired > 0) ctx.logger('xiuxian').info(`坊市清理过期商品 ${expired} 件`)

  if (!config.shopAutoListing) return
  const remain = await ctx.database.get(TABLE.shop, {})
  if (remain.length >= config.shopMinItems) return

  const pool = config.shopAutoPool ?? []
  if (pool.length === 0) return
  const goodsId = pool[Math.floor(Math.random() * pool.length)]
  const price = estimatePrice(goodsId)

  const id = await getNextId(ctx, TABLE.shop, 'id')
  await ctx.database.create(TABLE.shop, {
    id,
    sellerUid: 0, sellerName: '系统', goodsId,
    price, goodsNum: 1, createTime: new Date(),
  })

  const name = getItemNameById(goodsId)
  const type = getItemType(goodsId)
  ctx.logger('xiuxian').info(`坊市自动上架【${type}】「${name}」，${price} 灵石`)
}

function getItemType(goodsId: number): string {
  const { data } = require('./data')
  const id = String(goodsId)
  if (data.pills[id]) return '丹药'
  if (data.craftPills[id]) return '炼丹丹药'
  if (data.herbs[id]) return '药材'
  if (data.weapons[id]) return '武器'
  if (data.armors[id]) return '防具'
  if (data.gongfa[id]) return '功法'
  if (data.shentong[id]) return '神通'
  if (data.fuxiu[id]) return '辅修'
  if (data.qiFlags[id]) return '聚灵旗'
  if (data.furnaces[id]) return '炼丹炉'
  return '未知'
}