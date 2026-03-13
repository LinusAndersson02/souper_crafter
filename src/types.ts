export const ROYAL_CLUSTER_IDS = ['0000', '1000', '2000', '3004', '4000'] as const

export type RoyalClusterId = (typeof ROYAL_CLUSTER_IDS)[number]

export type PriceWindow = '24h' | '7d' | '30d'

export type ServerRegion = 'US' | 'EU' | 'ASIA'

export type BuyPriceType = 'TRADE' | 'INSTANT_BUY' | 'BUY_ORDER'
export type ArtifactFilter = 'NON_ARTIFACT' | 'RUNE' | 'SOUL' | 'RELIC' | 'OTHER'

export type MaterialGroup = 'wood' | 'fiber' | 'ore' | 'hide' | 'rock' | 'other'

export type SellTarget =
  | 'Black Market'
  | 'Caerleon'
  | 'Thetford'
  | 'Lymhurst'
  | 'Bridgewatch'
  | 'Martlock'
  | 'Fort Sterling'

export type EnchantmentLevel = 0 | 1 | 2 | 3 | 4

export interface RecipeResource {
  itemId: string
  count: number
  displayName: string
}

export interface CraftItem {
  itemId: string
  displayName: string
  tier: number | null
  craftingCategory: string
  weight: number
  itemValue: number
  itemValueByEnchantment: Partial<Record<EnchantmentLevel, number>>
  recipe: RecipeResource[]
  availableEnchantments: EnchantmentLevel[]
  journal: CraftJournalInfo | null
}

export interface RefiningItem {
  itemId: string
  marketItemId: string
  displayName: string
  tier: number | null
  enchantment: EnchantmentLevel
  craftingCategory: MaterialGroup
  weight: number
  itemValue: number
  recipe: RecipeResource[]
}

export interface CraftJournalInfo {
  emptyItemId: string
  emptyDisplayName: string
  fullItemId: string
  fullDisplayName: string
  maxFame: number
  fameByEnchantment: Partial<Record<EnchantmentLevel, number>>
}

export interface CraftVariant {
  variantId: string
  baseItemId: string
  displayName: string
  enchantment: EnchantmentLevel
  marketItemId: string
  tierLabel: string
}

export interface SelectedCraftPlan {
  variantId: string
  baseItemId: string
  enchantment: EnchantmentLevel
  quantity: number
  craftCity: string
  sellCity: SellTarget
  buyPriceType: BuyPriceType
  materialCityByGroup: Partial<Record<MaterialGroup, string>>
  artifactBuyCity: string
}

export interface CityProfile {
  clusterId: RoyalClusterId
  cityName: string
  baseCraftBonus: number
  categoryBonuses: Record<string, number>
}

export interface GameData {
  items: CraftItem[]
  refiningItems: RefiningItem[]
  cityProfiles: CityProfile[]
  categoryPresetCity: Record<string, string>
  categories: string[]
  cityNames: string[]
  knownMarketItemIds: string[]
}

export interface DailyBonusSetting {
  category: string
  percent: 10 | 20
}

export interface PriceHistoryPoint {
  timestamp: string
  avgPrice: number | null
  itemCount: number | null
}

export interface AppSettings {
  search: string
  tierFilters: number[]
  categoryFilter: 'ALL' | string
  artifactFilters: ArtifactFilter[]
  enchantmentFilters: EnchantmentLevel[]
  serverRegion: ServerRegion
  hasPremium: boolean
  targetCity: SellTarget
  includeJournals: boolean
  craftingStationFeePer100Nutrition: number
  transportEmvPct: number
  transportSilverPerKg: number
  dailyBonusA: DailyBonusSetting
  dailyBonusB: DailyBonusSetting
}

export interface CachedPricePoint {
  estimated: number | null
  sellOrder: number | null
  buyOrder: number | null
  sellOrderUpdatedAt: string | null
  buyOrderUpdatedAt: string | null
  avgSoldPerDay30d: number | null
  avgPrice30d: number | null
  history30d: PriceHistoryPoint[]
}

export interface PriceBook {
  values: Record<string, CachedPricePoint>
  fetchedAt: string | null
  error: string | null
}

export interface MaterialCostLine {
  baseItemId: string
  marketItemId: string
  displayName: string
  materialGroup: MaterialGroup | null
  buyCity: string
  baseQuantity: number
  quantity: number
  returnedQuantity: number
  unitPrice: number | null
  totalCost: number | null
  isArtifact: boolean
}

export interface JournalLine {
  amount: number
  buyCity: string
  sellCity: string
  emptyItemId: string
  emptyDisplayName: string
  fullItemId: string
  fullDisplayName: string
  famePerCraft: number
  journalMaxFame: number
  buyUnitPrice: number | null
  sellUnitPrice: number | null
  buyTotalCost: number | null
  sellTotalRevenue: number | null
  netValue: number | null
}

export interface PlannedCraftResult {
  plan: SelectedCraftPlan
  variant: CraftVariant
  baseItem: CraftItem
  craftCity: string
  sellCity: SellTarget
  returnRate: number
  materialLines: MaterialCostLine[]
  journalLine: JournalLine | null
  missingPrices: string[]
  estimatedMarketValue: number | null
  sellPriceUnit: number | null
  priceAgeHours: number | null
  avgSoldPerDay30d: number | null
  avgPrice30d: number | null
  materialBaseCost: number | null
  materialEffectiveCost: number | null
  productRevenue: number | null
  journalCost: number | null
  journalRevenue: number | null
  itemValuePerCraft: number | null
  stationNutrition: number | null
  stationFee: number | null
  marketFee: number | null
  transportFee: number | null
  totalCost: number | null
  revenue: number | null
  netProfit: number | null
  marginPct: number | null
}

export interface CraftPlanSummary {
  plannedCrafts: number
  readyCrafts: number
  totalCost: number
  totalRevenue: number
  totalStationFee: number
  totalMarketFee: number
  totalProfit: number
  totalProfitPct: number | null
}

export interface PlannedCraftView {
  results: PlannedCraftResult[]
  summary: CraftPlanSummary
}
