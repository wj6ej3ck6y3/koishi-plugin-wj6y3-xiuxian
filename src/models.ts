import { Context } from 'koishi'

// ================= 行类型定义 =================

export interface Player {
  /** 主键：Koishi 用户 ID（跨平台唯一，取决于是否接入 account 服务） */
  uid: number
  /** 建号平台，仅作参考记录 */
  platform: string
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
  insightCd: Date
}

export interface CdRow {
  uid: number
  type: number
  createTime: Date
  scheduledTime: number
}

export interface SectRow {
  sectId: number
  sectName: string
  sectOwnerUid: number
  sectScale: number
  sectFairyland: number
  sectMaterials: number
  elixirRoomLevel: number
  sectUsedStone: number
  offeringSnapshot: number
  offeringSnapshotAt: Date
}

export interface BackpackItem {
  uid: number
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
  uid: number
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
  uid: number
  questId: number
}

export interface SkillRow {
  uid: number
  skillId: number
}

export interface WorkRow {
  uid: number
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
  uid: number
  platform: string
  damage: number
}

export interface BankRow {
  uid: number
  saveStone: number
  saveTime: Date
  bankLevel: number
}

export interface PlotRow {
  uid: number
  plotIndex: number
  plantId: number
  plantAt: Date
  plantMinutes: number
}

export interface ShopRow {
  id: number
  /** 0 表示系统挂单 */
  sellerUid: number
  sellerName: string
  goodsId: number
  price: number
  goodsNum: number
  createTime: Date
}

export interface PillUsedRow {
  uid: number
  pillId: number
  targetLevelId: string
  usedAt: Date
}

export interface BountyListRow {
  uid: number
  slot: number
  questKey: string
  dropJson: string
  successRate: number
  createdAt: Date
}

// ================= 扩展 Koishi 全局 Tables =================

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

// ================= 表名常量 =================

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

// ================= defineModels =================

export function defineModels(ctx: Context) {
  ctx.model.extend('wj6y3_xiuxian_player', {
    uid: 'unsigned',
    platform: 'string',
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
  }, { primary: ['uid'] })

  ctx.model.extend('wj6y3_xiuxian_cd', {
    uid: 'unsigned',
    type: 'integer',
    createTime: 'timestamp',
    scheduledTime: 'integer',
  }, { primary: ['uid'] })

  ctx.model.extend('wj6y3_xiuxian_sect', {
    sectId: 'unsigned',
    sectName: 'string',
    sectOwnerUid: 'unsigned',
    sectScale: 'double',
    sectFairyland: 'integer',
    sectMaterials: 'double',
    elixirRoomLevel: 'integer',
    sectUsedStone: 'double',
    offeringSnapshot: 'double',
    offeringSnapshotAt: 'timestamp',
  }, { primary: ['sectId'] })

  ctx.model.extend('wj6y3_xiuxian_back', {
    uid: 'unsigned',
    goodsId: 'unsigned',
    goodsNum: 'integer',
    createTime: 'timestamp',
    updateTime: 'timestamp',
    dayNum: 'integer',
    allNum: 'integer',
    actionTime: 'timestamp',
    state: 'integer',
    bindNum: 'integer',
  }, { primary: ['uid', 'goodsId'] })

  ctx.model.extend('wj6y3_xiuxian_buff', {
    uid: 'unsigned',
    mainBuff: 'integer',
    secBuff: 'integer',
    subBuff: 'integer',
    faqiBuff: 'integer',
    armorBuff: 'integer',
    atkBuff: 'double',
    blessedSpot: 'integer',
    furnaceBuff: 'integer',
    qiFlagBuff: 'integer',
  }, { primary: ['uid'] })

  ctx.model.extend('wj6y3_xiuxian_quest', {
    uid: 'unsigned',
    questId: 'integer',
  }, { primary: ['uid'] })

  ctx.model.extend('wj6y3_xiuxian_skill', {
    uid: 'unsigned',
    skillId: 'unsigned',
  }, { primary: ['uid', 'skillId'] })

  ctx.model.extend('wj6y3_xiuxian_work', {
    uid: 'unsigned',
    workName: 'string',
    itemId: 'integer',
    startTime: 'timestamp',
  }, { primary: ['uid'] })

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
    uid: 'unsigned',
    platform: 'string',
    damage: 'double',
  }, { primary: ['bossId', 'uid'] })

  ctx.model.extend('wj6y3_xiuxian_bank', {
    uid: 'unsigned',
    saveStone: 'double',
    saveTime: 'timestamp',
    bankLevel: 'integer',
  }, { primary: ['uid'] })

  ctx.model.extend('wj6y3_xiuxian_plot', {
    uid: 'unsigned',
    plotIndex: 'integer',
    plantId: 'integer',
    plantAt: 'timestamp',
    plantMinutes: 'integer',
  }, { primary: ['uid', 'plotIndex'] })

  ctx.model.extend('wj6y3_xiuxian_shop', {
    id: 'unsigned',
    sellerUid: 'unsigned',
    sellerName: 'string',
    goodsId: 'integer',
    price: 'integer',
    goodsNum: 'integer',
    createTime: 'timestamp',
  }, { primary: ['id'] })

  ctx.model.extend('wj6y3_xiuxian_pill_used', {
    uid: 'unsigned',
    pillId: 'unsigned',
    targetLevelId: 'string',
    usedAt: 'timestamp',
  }, { primary: ['uid', 'pillId'] })

  ctx.model.extend('wj6y3_xiuxian_bounty_list', {
    uid: 'unsigned',
    slot: 'integer',
    questKey: 'string',
    dropJson: 'string',
    successRate: 'integer',
    createdAt: 'timestamp',
  }, { primary: ['uid', 'slot'] })
}

export interface MonetaryRow {
  uid: number
  currency: string
  value: number
}