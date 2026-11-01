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
import { registerGambleCommands } from './commands/gamble'
import { registerLongtermCommands } from './commands/longterm'
import { registerAdminCommands } from './commands/admin'
import { getPlayer, resetDaily, getItemNameById, getNextId, addItem, estimatePrice } from './utils'
import { TABLE } from './models'

export const name = 'xiuxian'
export const inject = {
  required: ['database', 'monetary'],
  optional: ['cron'],
}
export { Config }

// ===== 管理命令权限表（命令名 → 所需 authority 阈值）=====
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

  // 定时任务：优先 cron，未启用则回退 setInterval
  setupTimers(ctx, config)

  // ======================= 未建号玩家拦截（混合方案） =======================

  // 正向名单：这些命令要求玩家已建号
  const XIUXIAN_GAME_COMMANDS = new Set([
    // ===== 基础（base.ts）=====
    '修仙签到',
    '我的修仙信息', '修仙信息',
    '灵石',
    '查看战斗详情', '战斗详情',
    '修改道号',
    '修仙排行榜',

    // ===== 修炼（cultivate.ts）=====
    '闭关', '出关',
    '灵石修炼', '灵石修仙',
    '突破', '突破信息',
    '直接突破',
    '渡厄突破',
    '抑制黑暗动乱',

    // ===== 背包（backpack.ts）=====
    '我的背包', '我的物品', '修仙物品', '查看背包',
    '卸下',
    '使用',
    '我的功法',
    '我的神通',

    // ===== 坊市（shop.ts）=====
    '坊市购买',
    '坊市上架',
    '坊市下架',
    '系统回收',

    // ===== 宗门（sect.ts）=====
    '创建宗门',
    '我的宗门', '宗门信息', '宗门',
    '宗门列表',
    '加入宗门', '退出宗门', '宗门捐献',
    '宗门成员查看', '查看宗门成员', '宗门成员',
    '宗门职位变更',
    '踢出宗门',
    '宗主传位',
    '宗门每日供奉', '宗门供奉', '领取宗门俸禄','宗门俸禄',
    '宗门贡献兑换', '贡献兑换',
    '接取宗门任务', '宗门任务接取',
    '完成宗门任务',

    // ===== 悬赏令（bounty.ts）=====
    '悬赏令', '悬赏令刷新', '悬赏令接取',
    '悬赏令结算', '最后的悬赏令',
    '悬赏令终止',

    // ===== 灵庄（bank.ts）=====
    '灵庄',
    '灵庄存灵石', '存灵石',
    '灵庄取灵石', '取灵石',
    '灵庄结算',
    '灵庄升级',
    '灵庄信息', '查看灵庄', '灵庄',

    // ===== 世界 Boss（boss.ts）======
    '讨伐世界boss',

    // ===== 秘境（rift.ts）=====
    '探索秘境',

    // ===== 炼丹（alchemy.ts）=====
    '炼丹',
    '炼制',

    // ===== 炼体（body.ts）=====
    '炼体', '炼体信息', '查看炼体',
    '炼体突破',

    // ===== 传承 / 顿悟 / 转世 / 双修（longterm.ts）=====
    '重入仙途',
    '参悟传承', '升级攻击修炼',
    '参悟天机', '顿悟',
    '飞升转世', '飞升', '转世',
    '我的转世', '查看转世',
    '双修',
    '我的双修次数',

    // ===== 洞府（spot.ts）=====
    '开辟洞府', '洞府开辟',
    '灵气升级', '洞府升级',
    '开垦灵田', '洞府开垦',
    '灵田种植', '洞府种植',
    '灵田收获', '洞府收获',
    '查看灵田',
    '洞府信息', '我的洞府',
    '洞府改名', '重命名洞府',

    // ===== 小游戏（gamble.ts）=====
    '金银阁',
    '虚神界对决',
    '接受对决',
    '拒绝对决',
    '抢灵石',
  ])

  // 反向白名单：永远放行，不论是否建号
  // 目前只有建号命令需要放行，其余未收录命令（含管理指令）默认放行
  const NEVER_BLOCK = new Set(['我要修仙'])

  ctx.before('command/execute', async (argv: any) => {
    const session = argv?.session
    const cmdName = (argv?.command?.name ?? '').split('/').pop() || ''
    if (!session?.userId || !cmdName) return

    const required = COMMAND_AUTHORITY[cmdName]
    if (required === undefined) return   // 该命令不需要额外权限

    // 优先 session.authority（装了 @koishijs/plugin-auth 时自动注入）
    let auth: number = (session as any).authority ?? 0
    // 没有则从数据库读一次
    if (auth === 0) {
      try {
        const user = await ctx.database.getUser(session.platform as any, session.userId)
        auth = (user as any)?.authority ?? 0
      } catch { /* 忽略，按 0 处理 */ }
    }
    if (auth < required) return '权限不足'
  })

  ctx.before('command/execute', async (argv: any) => {
    const session = argv?.session
    const cmdNameRaw: string = argv?.command?.name ?? ''
    if (!session?.userId || !cmdNameRaw) return

    // 取命令名最后一段，防止嵌套命令 name 变成 'xiuxian/xxx'
    const cmdName = cmdNameRaw.split('/').pop() || cmdNameRaw

    // 1. 永远放行的命令（建号）
    if (NEVER_BLOCK.has(cmdName)) return

    // 2. 不在"需要登录"名单里 → 不处理（管理命令 / 其它插件命令）
    if (!XIUXIAN_GAME_COMMANDS.has(cmdName)) return

    // 3. 查玩家，已建号放行
    const p = await getPlayer(ctx, session.userId)
    if (p) return

    // 4. 未建号 → 返回提示，命令 action 不会执行
    return '⚠️ 你尚未踏入仙途，请先发送「我要修仙」加入仙途。'
  })

  ctx.on('ready', async () => {
    ctx.logger('xiuxian').info('修仙插件已加载')
    // 加载时补一次跨天结算（幂等）
    try {
      await settleSectDaily(ctx)
    } catch (e: any) {
      ctx.logger('xiuxian').warn(`加载时宗门每日结算失败: ${e?.message ?? e}`)
    }
  })
}

// ======================= 定时任务注册 =======================
/**
 * 优先使用 cron 服务（@koishijs/plugin-cron）注册标准 cron 表达式；
 * 若 cron 服务不可用，则自动回退到原有的 setInterval 逻辑。
 *
 * 两种模式通过 `cronBound` 互斥，绝不重复执行。
 *
 * cron 表达式：
 *   - `0 0 * * *` 每天 0 点：每日重置 + 宗门每日结算
 *   - `0 * * * *` 每小时整点：坊市清理过期 / 自动上架
 *
 * 宗门结算若因 0:00 定时任务漏跑而未执行，会由「我的宗门」「宗门捐献」
 * 「宗门每日供奉」「完成宗门任务」等指令的兜底调用补齐。
 *
 * 日志级别：
 *   - info  ：一次性「启用 cron」或「回退 setInterval」的模式报告
 *   - debug ：每次任务触发 / 完成（想观察需将日志级别调整到 debug）
 *   - warn  ：任务执行异常
 */
function setupTimers(ctx: Context, config: Config) {
  const logger = ctx.logger('xiuxian')

  // ========== 任务实现 ==========
  const runHourly = async () => {
    const t0 = Date.now()
    logger.debug('[定时任务] 开始：坊市每小时任务')
    try {
      await runHourlyShopJob(ctx, config)
      logger.debug(`[定时任务] 完成：坊市每小时任务（耗时 ${Date.now() - t0}ms）`)
    } catch (e: any) {
      logger.warn(`[定时任务] 坊市每小时任务失败: ${e?.message ?? e}`)
    }
  }

  const runDaily = async () => {
    const t0 = Date.now()
    logger.debug('[定时任务] 开始：每日重置 + 宗门每日结算')
    try {
      await resetDaily(ctx)
      logger.debug('[定时任务] 完成：每日重置')
    } catch (e: any) {
      logger.warn(`[定时任务] 每日重置失败: ${e?.message ?? e}`)
    }
    try {
      await settleSectDaily(ctx)
      logger.debug('[定时任务] 完成：宗门每日结算')
    } catch (e: any) {
      logger.warn(`[定时任务] 宗门每日结算失败: ${e?.message ?? e}`)
    }
    logger.debug(`[定时任务] 完成：每日任务总耗时 ${Date.now() - t0}ms`)
  }

  // ========== cron 绑定（this 保留 + 时机延后） ==========
  let cronBound = false

  /**
   * 尝试把两个 cron 任务绑定到 scope。
   * - 关键 1：用 `scope.cron(...)` 直接调用，**不要提取方法引用**，否则 `this` 丢失
   * - 关键 2：只在 scope 完全就绪后调用（inject 回调 / ready 事件）
   */
  const bindCron = (scope: Context): boolean => {
    if (cronBound) return true
    const s = scope as any
    if (typeof s.cron !== 'function') return false
    try {
      s.cron('0 0 * * *', () => {
        logger.debug('[定时任务] cron 触发：0 0 * * *')
        return runDaily()
      })
      s.cron('0 * * * *', () => {
        logger.debug('[定时任务] cron 触发：0 * * * *')
        return runHourly()
      })
      cronBound = true
      logger.info('定时任务已启用 cron 模式（每日 0 0 * * * / 每小时 0 * * * *）')
      return true
    } catch (e: any) {
      logger.warn(`[定时任务] cron 注册失败，保持 setInterval 兜底: ${e?.message ?? e}`)
      return false
    }
  }

  // 触发点 A：cron 服务就绪时（inject 回调在 scope 完全建立后才执行）
  ctx.inject(['cron'], (scope) => {
    bindCron(scope)
  })

  // 触发点 B：插件 ready 时再兜一次（覆盖 cron 已存在但 inject 未触发的场景）
  //           ready 后 cron 的 collect 链路一定就绪
  ctx.on('ready', () => {
    bindCron(ctx)
  })

  // ========== setInterval 兜底 ==========
  ctx.setInterval(async () => {
    if (cronBound) return
    logger.debug('[定时任务] setInterval 触发：每小时')
    await runHourly()
  }, 60 * 60 * 1000)

  ctx.setInterval(async () => {
    if (cronBound) return
    const now = new Date()
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      logger.debug('[定时任务] setInterval 触发：每日 0:00')
      await runDaily()
    }
  }, 60_000)

  // ========== 5 秒后报告最终生效模式（只在未绑定 cron 时） ==========
  ctx.setTimeout(() => {
    if (!cronBound) {
      logger.info('未检测到 cron 服务，定时任务已回退到 setInterval 模式（每日 0:00 检查 / 每小时一次）')
    }
  }, 5_000)
}

async function runHourlyShopJob(ctx: Context, config: Config) {
  const now = Date.now()
  const expireMs = (config.shopExpireHours ?? 72) * 3600 * 1000

  // 1. 清理过期商品
  const all = await ctx.database.get(TABLE.shop, {})
  let expired = 0
  for (const s of all) {
    if (now - +new Date(s.createTime) >= expireMs) {
      // 退回卖家背包（系统卖家 '0' 直接删）
      if (s.sellerId !== '0') {
        await addItem(ctx, s.sellerId, s.goodsId, s.goodsNum)
      }
      await ctx.database.remove(TABLE.shop, { id: s.id })
      expired++
    }
  }
  if (expired > 0) ctx.logger('xiuxian').info(`坊市清理过期商品 ${expired} 件`)

  // 2. 判断是否自动上架
  if (!config.shopAutoListing) return
  const remain = await ctx.database.get(TABLE.shop, {})
  if (remain.length >= config.shopMinItems) return

  // 从白名单随机挑一件
  const pool = config.shopAutoPool ?? []
  if (pool.length === 0) return
  const goodsId = pool[Math.floor(Math.random() * pool.length)]
  const price = estimatePrice(goodsId)

  // ✅ 手动分配 ID
  const id = await getNextId(ctx, TABLE.shop, 'id')
  await ctx.database.create(TABLE.shop, {
    id, // ✅ 传入
    sellerId: '0', sellerName: '系统', goodsId,
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