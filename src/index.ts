import { Context } from 'koishi'
import { Config } from './config'
import { data } from './data'
import { defineModels, TABLE } from './models'
import { registerBaseCommands } from './commands/base'
import { registerCultivateCommands } from './commands/cultivate'
import { registerBackpackCommands } from './commands/backpack'
import { registerSectCommands, settleSectDaily } from './commands/sect'
import { registerBountyCommands } from './commands/bounty'
import { registerBankCommands } from './commands/bank'
import { registerBossCommands, spawnWorldBoss, hasAliveWorldBoss, settleDeadWorldBosses } from './commands/boss'
import { registerRiftCommands } from './commands/rift'
import { registerAlchemyCommands } from './commands/alchemy'
import { registerBodyCommands } from './commands/body'
import { registerSpotCommands } from './commands/spot'
import { registerShopCommands } from './commands/shop'
import { registerGambleCommands, cleanupGambleCds, clearGambleState } from './commands/gamble'
import { registerLongtermCommands } from './commands/longterm'
import { registerAdminCommands } from './commands/admin'
import {
  getPlayer, resetDaily, getItemNameById, getNextId, addItem, estimatePrice, getSessionUid,
  claimByRemove, cleanupBattleRecords, clearBattleRecords,
  migrateLegacyPillCounts, normalizeFlooredFields,
} from './utils'

export const name = 'xiuxian'
export const inject = {
  required: ['database', 'monetary'],
  optional: ['cron'],
}
export { Config }

/**
 * 需要先建号（我要修仙）才能使用的指令：处理函数内会调用 requirePlayer / requireBattleReadyPlayer。
 * 拦截器按 command.name（注册时的正式指令名，不受 koishi.yml 改名或别名影响）匹配，因此这里只列正式指令名。
 * 新增需要角色的指令时须同步加入此名单，否则未建号玩家只会看到「发生未知错误」。
 */
const XIUXIAN_GAME_COMMANDS = new Set([
  // base
  '修仙签到', '我的修仙信息', '灵石', '查看战斗详情', '修改道号',
  // cultivate
  '闭关', '出关', '灵石修炼', '突破', '直接突破', '渡厄突破', '抑制黑暗动乱',
  // backpack
  '我的背包', '卸下', '使用', '我的功法', '我的神通',
  // sect
  '创建宗门', '我的宗门', '加入宗门', '宗门捐献', '宗门成员查看',
  '宗门职位变更', '踢出宗门', '宗主传位', '退出宗门',
  '宗门每日供奉', '宗门贡献兑换', '接取宗门任务', '完成宗门任务',
  // bounty
  '悬赏令', '悬赏令刷新', '悬赏令接取', '悬赏令结算', '悬赏令终止',
  // bank
  '灵庄存灵石', '灵庄取灵石', '灵庄结算', '灵庄升级', '灵庄信息',
  // boss / rift
  '讨伐世界boss', '探索秘境',
  // alchemy / body
  '炼丹', '炼制', '炼体', '炼体突破',
  // spot
  '开辟洞府', '灵气升级', '开垦灵田', '灵田种植', '灵田收获', '查看灵田', '洞府信息', '洞府改名',
  // shop
  '坊市购买', '坊市上架', '坊市下架', '系统回收',
  // gamble
  '金银阁', '虚神界对决', '接受对决', '拒绝对决', '抢灵石',
  // longterm
  '重入仙途', '参悟传承', '参悟天机', '飞升转世', '我的转世', '双修',
])

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('xiuxian')
  defineModels(ctx)

  registerBaseCommands(ctx, config)
  registerCultivateCommands(ctx, config)
  registerBackpackCommands(ctx)
  registerSectCommands(ctx)
  registerBountyCommands(ctx, config)
  registerBankCommands(ctx)
  registerBossCommands(ctx)
  registerRiftCommands(ctx, config)
  registerAlchemyCommands(ctx)
  registerBodyCommands(ctx)
  registerSpotCommands(ctx)
  registerShopCommands(ctx)
  registerGambleCommands(ctx)
  registerLongtermCommands(ctx, config)
  registerAdminCommands(ctx)

  setupTimers(ctx, config)

  // ======================= 未建号玩家拦截 =======================
  ctx.before('command/execute', async (argv) => {
    const session = argv.session
    const cmdName = argv.command?.name ?? ''
    if (!session?.userId || !cmdName) return
    if (!XIUXIAN_GAME_COMMANDS.has(cmdName)) return

    const uid = await getSessionUid(ctx, session)
    if (uid === null) return '⚠️ 账号未同步，请稍后重试'
    const p = await getPlayer(ctx, uid)
    if (p) return

    return '⚠️ 你尚未踏入仙途，请先发送「我要修仙」加入仙途。'
  })

  ctx.on('ready', async () => {
    logger.info('修仙插件已加载')
    try {
      await settleSectDaily(ctx)
    } catch (e: any) {
      logger.warn(`加载时宗门每日结算失败: ${e?.message ?? e}`)
    }
    try {
      const n = await migrateLegacyPillCounts(ctx)
      if (n > 0) logger.info(`已将 ${n} 条攻击丹服用次数迁移至独立记录表`)
    } catch (e: any) {
      logger.warn(`攻击丹服用次数迁移失败: ${e?.message ?? e}`)
    }
    try {
      const n = await normalizeFlooredFields(ctx)
      if (n > 0) logger.info(`已将 ${n} 行旧数据中的小数数值向下取整`)
    } catch (e: any) {
      logger.warn(`旧数据数值取整失败: ${e?.message ?? e}`)
    }
    try {
      const n = await settleDeadWorldBosses(ctx)
      if (n > 0) logger.info(`已结算并清理 ${n} 只残留的已击杀世界 BOSS`)
    } catch (e: any) {
      logger.warn(`残留世界 BOSS 清理失败: ${e?.message ?? e}`)
    }
  })

  ctx.on('dispose', () => {
    clearBattleRecords()
    clearGambleState()
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
      cleanupBattleRecords()
      logger.debug('[定时任务] 完成：内存 CD / 战斗记录清理')
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

  const runWeeklyBoss = async () => {
    try {
      await settleDeadWorldBosses(ctx)
      if (await hasAliveWorldBoss(ctx)) {
        logger.debug('[定时任务] 周一世界BOSS：已有存活BOSS，跳过生成')
        return
      }
      const b = await spawnWorldBoss(ctx)
      logger.info(`[定时任务] 周一世界BOSS：已自动生成「${b.name}」（HP ${b.maxHp}）`)
    } catch (e: any) {
      logger.warn(`[定时任务] 周一世界BOSS生成失败: ${e?.message ?? e}`)
    }
  }

  // cron 模式：cron 服务每次可用（包括 cron 插件重载后）都会重新进入此回调并在其子作用域注册任务；
  // 子作用域释放时任务随之停止，cronActive 复位，由下方回退定时器接手。
  let cronActive = false
  ctx.inject(['cron'], (scope) => {
    // koishi-plugin-cron 未提供类型声明，这里按其运行时 API 调用
    const s = scope as any
    try {
      s.cron('0 0 * * *', () => { logger.debug('[定时任务] cron 触发：0 0 * * *'); return runDaily() })
      s.cron('0 * * * *', () => { logger.debug('[定时任务] cron 触发：0 * * * *'); return runHourly() })
      s.cron('0 0 * * 1', () => { logger.debug('[定时任务] cron 触发：0 0 * * 1'); return runWeeklyBoss() })
      cronActive = true
      logger.info('定时任务已启用 cron 模式')
      scope.on('dispose', () => {
        cronActive = false
        logger.debug('cron 服务已释放，定时任务回退到 setInterval 模式')
      })
    } catch (e: any) {
      logger.warn(`[定时任务] cron 注册失败: ${e?.message ?? e}`)
    }
  })

  ctx.setInterval(async () => {
    if (cronActive) return
    await runHourly()
  }, 60 * 60 * 1000)

  ctx.setInterval(async () => {
    if (cronActive) return
    const now = new Date()
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      await runDaily()
      if (now.getDay() === 1) await runWeeklyBoss()
    }
  }, 60_000)

  ctx.setTimeout(() => {
    if (!cronActive) logger.info('定时任务已回退到 setInterval 模式')
  }, 5_000)
}

async function runHourlyShopJob(ctx: Context, config: Config) {
  const now = Date.now()
  const expireMs = (config.shopExpireHours ?? 72) * 3600 * 1000

  const all = await ctx.database.get(TABLE.shop, {})
  let expired = 0
  for (const s of all) {
    if (now - +new Date(s.createTime) < expireMs) continue
    // 先删除挂单作为占用：已被买走 / 下架的不会再退还
    if (!(await claimByRemove(ctx, TABLE.shop, { id: s.id }))) continue
    if (s.sellerUid !== 0) {
      await addItem(ctx, s.sellerUid, s.goodsId, s.goodsNum)
    }
    expired++
  }
  if (expired > 0) ctx.logger('xiuxian').info(`坊市清理过期商品 ${expired} 件`)

  if (!config.shopAutoListing) return
  const remain = await ctx.database.get(TABLE.shop, {})
  if (remain.length >= config.shopMinItems) return

  const pool = config.shopAutoPool ?? []
  if (pool.length === 0) return
  const goodsId = pool[Math.floor(Math.random() * pool.length)]
  const price = Math.max(1, Math.floor(estimatePrice(goodsId)))

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
