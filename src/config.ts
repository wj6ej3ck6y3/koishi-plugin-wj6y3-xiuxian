import { Schema } from 'koishi'

export interface Config {
  currency: string
  signMin: number
  signMax: number
  closeExpPerMinute: number
  breakthroughFailLossRatio: number
  breakthroughFailRateGain: number
  breakthroughCooldownMinutes: number
  rebirthMaxLevel: string
  // 坊市
  shopAutoListing: boolean
  shopMinItems: number
  shopAutoPool: number[]
  shopExpireHours: number
  // ✅ 悬赏令掉落
  bountyDropChance: number
  bountyDropCount: number
  bountyDropCategoryWeights: Record<string, number>
  riftDropChance: number
}

export const Config: Schema<Config> = Schema.object({
  currency: Schema.string().default('灵石')
    .description('修仙货币名称（用于 monetary 服务的货币键名）。修改后新旧货币互不相通，请谨慎操作。'),
  signMin: Schema.number().default(100000).min(0).description('签到灵石下限'),
  signMax: Schema.number().default(500000).min(0).description('签到灵石上限'),
  closeExpPerMinute: Schema.number().default(10).min(0).description('闭关每分钟基础修为'),
  breakthroughFailLossRatio: Schema.number().default(0.3).min(0).description('突破失败扣除修为比例'),
  breakthroughFailRateGain: Schema.number().default(5).min(0).max(100).description('突破失败累积成功概率(%)'),
  breakthroughCooldownMinutes: Schema.number().default(60).min(0).description('突破冷却分钟数（默认 60， 0 表示无冷却）'),
  rebirthMaxLevel: Schema.string().default('').description('可飞升的最高境界ID(留空则自动取最大ID)'),
  shopAutoListing: Schema.boolean().default(true).description('是否启用坊市自动上架'),
  shopMinItems: Schema.number().default(10).min(0).description('坊市商品少于该值时自动上架'),
  shopAutoPool: Schema.array(Schema.number()).default([
    // 基础丹药（回复/修为）
    1101, 1102, 1103, 1104, 1105,
    // 突破辅助丹
    1500,
    // 基础药材
    3001, 3002, 3005, 3006,
    // 基础武器 / 防具
    7001, 7011, 6001, 6011,
    // 聚灵旗
    5000, 5001,
    // 基础炼丹炉（陨铁炉）
    4003,
    // 低阶功法（人阶下品 + 人阶上品）
    9001, 9002, 9003, 9004, 9005,
    9011, 9012, 9013, 9014, 9099, 9100,
    // 低阶神通（人阶下品 + 人阶上品）
    8001, 8002, 8003, 8004, 8005,
    8101, 8102, 8103, 8104, 8105,
  ]).description('自动上架白名单物品 ID'),
  shopExpireHours: Schema.number().default(72).min(0).description('坊市超时下架小时数'),
  bountyDropChance: Schema.number().default(50).min(0).max(100)
    .description('悬赏令任务掉落概率（%）—— 注意：新版为每任务必掉 1~2 件，此项暂不使用'),
  bountyDropCount: Schema.number().default(2).min(0)
    .description('每任务掉落最大物品数量（固定 2，此项暂不使用）'),
  bountyDropCategoryWeights: Schema.dict(Schema.number()).default({
    pill: 20, craftPill: 8, herb: 25, weapon: 12, armor: 8,
    gongfa: 10, shentong: 10, fuxiu: 3, qiFlag: 2, furnace: 2,
  }).description('掉落类别权重'),
  riftDropChance: Schema.number().default(40).max(100)
    .description('秘境探索獲取灵石/修为時的额外物品掉落概率（%）'),
})