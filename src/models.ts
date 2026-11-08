import { Context } from 'koishi'

// ================= 行类型定义 =================

export interface Player {
  userId: string
  platform: string
  uid: number | null
  root: string
  level: string
  exercisesLevel: string
  power: number
  isSign: Date
  exp: number
  userName: string
  levelUpCd: Date
  levelUpRate: number
  hp: number
  maxhp: number
  mp: number
  maxmp: number
  atk: number
  atkPractice: number
  sectId: number
  sectPosition: number
  sectMissionId: number
  sectMissionDoneAt: Date
  sectContribution: number
  sectOfferingGet: Date
  blessedSpotFlag: number
  blessedSpotName: string
  plotCount: number
  riftCd: Date
  riftDailyCount: number
  workRefreshCountTime: number
  workRefreshCount: number
  rebirth: number
  dualCultivation: number
  dualCultivationTime: Date
  /** 参悟天机 CD 时间戳（B8：由内存 Map 迁移到落库） */
  insightCd: Date
}

export interface CdRow {
  userId: string
  type: number
  createTime: Date
  scheduledTime: number
}

export interface SectRow {
  sectId: number
  sectName: string
  sectOwner: string
  sectScale: number
  sectFairyland: number
  sectMaterials: number
  elixirRoomLevel: number
  sectUsedStone: number
  offeringSnapshot: number
  offeringSnapshotAt: Date
}

export interface BackpackItem {
  userId: string
  goodsId: number
  goodsNum: number
  createTime: Date
  updateTime: Date
  dayNum: number
  allNum: number
  actionTime: Date
  state: number
  bindNum: number
}

export interface BuffRow {
  userId: string
  mainBuff: number
  secBuff: number
  subBuff: number
  faqiBuff: number
  armorBuff: number
  atkBuff: number
  blessedSpot: number
  furnaceBuff: number
  qiFlagBuff: number
}

export interface QuestRow {
  userId: string
  questId: number
}

export interface SkillRow {
  userId: string
  skillId: number
}

export interface WorkRow {
  userId: string
  workName: string
  itemId: number
  startTime: Date
}

export interface BossRow {
  id: number
  name: string
  level: number
  hp: number
  maxHp: number
  atk: number
}

export interface BossParticipant {
  bossId: number
  userId: string
  platform: string
  damage: number
}

export interface BankRow {
  userId: string
  saveStone: number
  saveTime: Date
  bankLevel: number
}

export interface PlotRow {
  userId: string
  plotIndex: number
  plantId: number
  plantAt: Date
  plantMinutes: number
}

export interface ShopRow {
  id: number
  sellerId: string
  sellerName: string
  goodsId: number
  price: number
  goodsNum: number
  createTime: Date
}

export interface PillUsedRow {
  userId: string
  pillId: number
  targetLevelId: string
  usedAt: Date
}

export interface BountyListRow {
  userId: string
  slot: number
  questKey: string
  dropJson: string
  successRate: number
  createdAt: Date
}

// ================= 关键：扩展 Koishi 全局 Tables =================

declare module 'koishi' {
  interface Tables {
    wj6y3_xiuxian_player: Player
    wj6y3_xiuxian_cd: CdRow
    wj6y3_xiuxian_sect: SectRow
    wj6y3_xiuxian_back: BackpackItem
    wj6y3_xiuxian_buff: BuffRow
    wj6y3_xiuxian_quest: QuestRow
    wj6y3_xiuxian_skill: SkillRow
    wj6y3_xiuxian_work: WorkRow
    wj6y3_xiuxian_boss: BossRow
    wj6y3_xiuxian_boss_participant: BossParticipant
    wj6y3_xiuxian_bank: BankRow
    wj6y3_xiuxian_plot: PlotRow
    wj6y3_xiuxian_shop: ShopRow
    wj6y3_xiuxian_pill_used: PillUsedRow
    wj6y3_xiuxian_bounty_list: BountyListRow
    monetary: MonetaryRow
  }
}

// ================= 表名常量（as const 保证字面量类型） =================

export const TABLE = {
  player: 'wj6y3_xiuxian_player',
  cd: 'wj6y3_xiuxian_cd',
  sect: 'wj6y3_xiuxian_sect',
  back: 'wj6y3_xiuxian_back',
  buff: 'wj6y3_xiuxian_buff',
  quest: 'wj6y3_xiuxian_quest',
  skill: 'wj6y3_xiuxian_skill',
  work: 'wj6y3_xiuxian_work',
  boss: 'wj6y3_xiuxian_boss',
  bossP: 'wj6y3_xiuxian_boss_participant',
  bank: 'wj6y3_xiuxian_bank',
  plot: 'wj6y3_xiuxian_plot',
  shop: 'wj6y3_xiuxian_shop',
  pillUsed: 'wj6y3_xiuxian_pill_used',
  bountyList: 'wj6y3_xiuxian_bounty_list',
} as const

// ================= defineModels：字段值必须是字面量 =================

export function defineModels(ctx: Context) {
  ctx.model.extend('wj6y3_xiuxian_player', {
    userId: 'string',
    platform: 'string',
    uid: 'unsigned',
    root: 'string',
    level: 'string',
    exercisesLevel: 'string',
    power: 'unsigned',
    isSign: 'timestamp',
    exp: 'double',
    userName: 'string',
    levelUpCd: 'timestamp',
    levelUpRate: 'integer',
    hp: 'double',
    maxhp: 'double',
    mp: 'double',
    maxmp: 'double',
    atk: 'double',
    atkPractice: 'integer',
    sectId: 'integer',
    sectPosition: 'integer',
    sectMissionId: 'integer',
    sectMissionDoneAt: 'timestamp',
    sectContribution: 'double',
    sectOfferingGet: 'timestamp',
    blessedSpotFlag: 'integer',
    blessedSpotName: 'string',
    plotCount: 'integer',
    riftCd: 'timestamp',
    riftDailyCount: 'integer',
    workRefreshCountTime: 'integer',
    workRefreshCount: 'integer',
    rebirth: 'integer',
    dualCultivation: 'integer',
    dualCultivationTime: 'timestamp',
    insightCd: 'timestamp',
  }, { primary: ['userId'] })

  ctx.model.extend('wj6y3_xiuxian_cd', {
    userId: 'string',
    type: 'integer',
    createTime: 'timestamp',
    scheduledTime: 'integer',
  }, { primary: ['userId'] })

  ctx.model.extend('wj6y3_xiuxian_sect', {
    sectId: 'unsigned',
    sectName: 'string',
    sectOwner: 'string',
    sectScale: 'double',
    sectFairyland: 'integer',
    sectMaterials: 'double',
    elixirRoomLevel: 'integer',
    sectUsedStone: 'double',
    offeringSnapshot: 'double',
    offeringSnapshotAt: 'timestamp',
  }, { primary: ['sectId'] })

  ctx.model.extend('wj6y3_xiuxian_back', {
    userId: 'string',
    goodsId: 'unsigned',
    goodsNum: 'integer',
    createTime: 'timestamp',
    updateTime: 'timestamp',
    dayNum: 'integer',
    allNum: 'integer',
    actionTime: 'timestamp',
    state: 'integer',
    bindNum: 'integer',
  }, { primary: ['userId', 'goodsId'] })

  ctx.model.extend('wj6y3_xiuxian_buff', {
    userId: 'string',
    mainBuff: 'integer',
    secBuff: 'integer',
    subBuff: 'integer',
    faqiBuff: 'integer',
    armorBuff: 'integer',
    atkBuff: 'double',
    blessedSpot: 'integer',
    furnaceBuff: 'integer',
    qiFlagBuff: 'integer',
  }, { primary: ['userId'] })

  ctx.model.extend('wj6y3_xiuxian_quest', {
    userId: 'string',
    questId: 'integer',
  }, { primary: ['userId'] })

  ctx.model.extend('wj6y3_xiuxian_skill', {
    userId: 'string',
    skillId: 'unsigned',
  }, { primary: ['userId', 'skillId'] })

  ctx.model.extend('wj6y3_xiuxian_work', {
    userId: 'string',
    workName: 'string',
    itemId: 'integer',
    startTime: 'timestamp',
  }, { primary: ['userId'] })

  ctx.model.extend('wj6y3_xiuxian_boss', {
    id: 'unsigned',
    name: 'string',
    level: 'integer',
    hp: 'double',
    maxHp: 'double',
    atk: 'double',
  }, { primary: ['id'] })

  ctx.model.extend('wj6y3_xiuxian_boss_participant', {
    bossId: 'unsigned',
    userId: 'string',
    platform: 'string',
    damage: 'double',
  }, { primary: ['bossId', 'userId'] })

  ctx.model.extend('wj6y3_xiuxian_bank', {
    userId: 'string',
    saveStone: 'double',
    saveTime: 'timestamp',
    bankLevel: 'integer',
  }, { primary: ['userId'] })

  ctx.model.extend('wj6y3_xiuxian_plot', {
    userId: 'string',
    plotIndex: 'integer',
    plantId: 'integer',
    plantAt: 'timestamp',
    plantMinutes: 'integer',
  }, { primary: ['userId', 'plotIndex'] })

  ctx.model.extend('wj6y3_xiuxian_shop', {
    id: 'unsigned',
    sellerId: 'string',
    sellerName: 'string',
    goodsId: 'integer',
    price: 'integer',
    goodsNum: 'integer',
    createTime: 'timestamp',
  }, { primary: ['id'] })

  ctx.model.extend('wj6y3_xiuxian_pill_used', {
    userId: 'string',
    pillId: 'unsigned',
    targetLevelId: 'string',
    usedAt: 'timestamp',
  }, { primary: ['userId', 'pillId'] })

  ctx.model.extend('wj6y3_xiuxian_bounty_list', {
    userId: 'string',
    slot: 'integer',
    questKey: 'string',
    dropJson: 'string',
    successRate: 'integer',
    createdAt: 'timestamp',
  }, { primary: ['userId', 'slot'] })
}

export interface MonetaryRow {
  uid: number
  currency: string
  value: number
}