import { getCachedPricePoint } from './pricing'
import type {
  AppSettings,
  BuyPriceType,
  CityProfile,
  CraftItem,
  CraftVariant,
  EnchantmentLevel,
  JournalLine,
  MaterialCostLine,
  MaterialGroup,
  PlannedCraftResult,
  PlannedCraftView,
  PriceBook,
  SelectedCraftPlan,
  SellTarget,
} from './types'

const ENCHANTMENT_LEVELS: EnchantmentLevel[] = [1, 2, 3, 4]
const ESTIMATE_WINDOW = '7d' as const
const TOTAL_NUTRITION_PER_ITEM_VALUE = 0.1125

export const BUY_PRICE_TYPE_LABELS: Record<BuyPriceType, string> = {
  TRADE: 'Trade (-5%)',
  INSTANT_BUY: 'Instant Buy',
  BUY_ORDER: 'Buy Order',
}

export const MATERIAL_GROUP_LABELS: Record<MaterialGroup, string> = {
  wood: 'Wood / Planks',
  fiber: 'Fiber / Cloth',
  ore: 'Ore / Metal Bars',
  hide: 'Hide / Leather',
  rock: 'Stone / Blocks',
  other: 'Other Materials',
}

const MATERIAL_GROUP_ORDER: MaterialGroup[] = ['wood', 'fiber', 'ore', 'hide', 'rock', 'other']

const DAILY_BONUS_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'hide', label: 'Hide' },
  { value: 'axe', label: 'Axe' },
  { value: 'quarterstaff', label: 'Quarterstaff' },
  { value: 'froststaff', label: 'Frost Staff' },
  { value: 'plate_shoes', label: 'Plate Shoes' },
  { value: 'offhand', label: 'Off-Hand' },
  { value: 'rock', label: 'Stone' },
  { value: 'crossbow', label: 'Crossbow' },
  { value: 'dagger', label: 'Dagger' },
  { value: 'cursestaff', label: 'Cursed Staff' },
  { value: 'plate_armor', label: 'Plate Armor' },
  { value: 'cloth_shoes', label: 'Cloth Shoes' },
  { value: 'fiber', label: 'Fiber' },
  { value: 'sword', label: 'Sword' },
  { value: 'bow', label: 'Bow' },
  { value: 'arcanestaff', label: 'Arcane Staff' },
  { value: 'leather_helmet', label: 'Leather Helmet' },
  { value: 'leather_shoes', label: 'Leather Shoes' },
  { value: 'wood', label: 'Wood' },
  { value: 'hammer', label: 'Hammer' },
  { value: 'spear', label: 'Spear' },
  { value: 'holystaff', label: 'Holy Staff' },
  { value: 'plate_helmet', label: 'Plate Helmet' },
  { value: 'cloth_armor', label: 'Cloth Armor' },
  { value: 'ore', label: 'Ore' },
  { value: 'mace', label: 'Mace' },
  { value: 'naturestaff', label: 'Nature Staff' },
  { value: 'firestaff', label: 'Fire Staff' },
  { value: 'leather_armor', label: 'Leather Armor' },
  { value: 'cloth_helmet', label: 'Cloth Helmet' },
  { value: 'knuckles', label: 'War Gloves' },
  { value: 'shapeshifterstaff', label: 'Shapeshifter Staff' },
  { value: 'gatherergear', label: 'Gathering Gear' },
  { value: 'tools', label: 'Tools' },
  { value: 'food', label: 'Food' },
  { value: 'cape', label: 'Capes' },
  { value: 'bag', label: 'Bags' },
  { value: 'potion', label: 'Potions' },
] as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function stripEnchantmentSuffix(itemId: string): string {
  return itemId.replace(/@\d$/, '')
}

export function isArtifactItem(itemId: string): boolean {
  return stripEnchantmentSuffix(itemId).toUpperCase().includes('ARTEFACT')
}

function isReturnEligibleResource(itemId: string): boolean {
  return !isArtifactItem(itemId)
}

function resolveMarketItemId(
  baseItemId: string,
  enchantment: EnchantmentLevel,
  knownMarketItemIds: Set<string>,
): string | null {
  if (enchantment === 0) {
    return baseItemId
  }

  const candidates = [
    `${baseItemId}_LEVEL${enchantment}@${enchantment}`,
    `${baseItemId}@${enchantment}`,
    `${baseItemId}_LEVEL${enchantment}`,
  ]

  for (const candidate of candidates) {
    if (knownMarketItemIds.has(candidate)) {
      return candidate
    }
  }

  return null
}

export function inferMaterialGroup(itemId: string): MaterialGroup {
  const normalizedId = stripEnchantmentSuffix(itemId).toUpperCase()

  if (normalizedId.includes('_PLANKS') || normalizedId.endsWith('_WOOD')) {
    return 'wood'
  }

  if (normalizedId.includes('_CLOTH') || normalizedId.endsWith('_FIBER')) {
    return 'fiber'
  }

  if (normalizedId.includes('_METALBAR') || normalizedId.endsWith('_ORE')) {
    return 'ore'
  }

  if (normalizedId.includes('_LEATHER') || normalizedId.endsWith('_HIDE')) {
    return 'hide'
  }

  if (normalizedId.includes('_STONEBLOCK') || normalizedId.endsWith('_ROCK')) {
    return 'rock'
  }

  return 'other'
}

function isEnchantableResource(itemId: string): boolean {
  if (isArtifactItem(itemId)) {
    return false
  }

  const normalizedId = stripEnchantmentSuffix(itemId).toUpperCase()

  return /(?:_PLANKS|_CLOTH|_METALBAR|_LEATHER|_STONEBLOCK|_WOOD|_FIBER|_ORE|_HIDE|_ROCK)$/.test(
    normalizedId,
  )
}

function resolveResourceMarketItemId(
  baseResourceItemId: string,
  enchantment: EnchantmentLevel,
  knownMarketItemIds: Set<string>,
): string {
  if (enchantment === 0 || !isEnchantableResource(baseResourceItemId)) {
    return baseResourceItemId
  }

  return resolveMarketItemId(baseResourceItemId, enchantment, knownMarketItemIds) ?? baseResourceItemId
}

function sumNullable(values: Array<number | null>): number | null {
  let sum = 0

  for (const value of values) {
    if (value === null) {
      return null
    }

    sum += value
  }

  return sum
}

function deduplicate(values: string[]): string[] {
  return [...new Set(values)]
}

function localProductionBonusToReturnRate(localProductionBonus: number): number {
  const normalizedBonus = clamp(localProductionBonus, 0, 10)
  return clamp(1 - 1 / (1 + normalizedBonus), 0, 0.95)
}

function getPricePoint(
  priceBook: PriceBook,
  settings: AppSettings,
  location: string,
  itemId: string,
): {
  estimated: number | null
  sellOrder: number | null
  buyOrder: number | null
  sellOrderUpdatedAt: string | null
  buyOrderUpdatedAt: string | null
  avgSoldPerDay30d: number | null
  avgPrice30d: number | null
} | null {
  return getCachedPricePoint(priceBook.values, settings.serverRegion, ESTIMATE_WINDOW, location, itemId)
}

function getTimestampAgeHours(timestamp: string | null): number | null {
  if (!timestamp) {
    return null
  }

  const parsed = Date.parse(timestamp)
  if (Number.isNaN(parsed)) {
    return null
  }

  return Math.max(0, (Date.now() - parsed) / (1000 * 60 * 60))
}

function resolveMaxPriceAgeHours(timestamps: Array<string | null>): number | null {
  const ages = timestamps
    .map((timestamp) => getTimestampAgeHours(timestamp))
    .filter((age): age is number => age !== null)

  if (ages.length === 0) {
    return null
  }

  return Math.max(...ages)
}

function resolveEstimatedPrice(
  priceBook: PriceBook,
  settings: AppSettings,
  location: string,
  itemId: string,
): number | null {
  return getPricePoint(priceBook, settings, location, itemId)?.estimated ?? null
}

function resolveAverageSoldPerDay(
  priceBook: PriceBook,
  settings: AppSettings,
  location: string,
  itemId: string,
): number | null {
  return getPricePoint(priceBook, settings, location, itemId)?.avgSoldPerDay30d ?? null
}

function resolveAveragePrice30d(
  priceBook: PriceBook,
  settings: AppSettings,
  location: string,
  itemId: string,
): number | null {
  return getPricePoint(priceBook, settings, location, itemId)?.avgPrice30d ?? null
}

function resolveOutputSaleUnitPrice(
  priceBook: PriceBook,
  settings: AppSettings,
  location: string,
  itemId: string,
  preferBlackMarketOrder: boolean,
): number {
  const pricePoint = getPricePoint(priceBook, settings, location, itemId)

  return (
    pricePoint?.estimated ??
    (preferBlackMarketOrder
      ? pricePoint?.buyOrder ?? null
      : pricePoint?.sellOrder ?? pricePoint?.buyOrder ?? null) ??
    0
  )
}

function resolveOutputSaleTimestamp(
  priceBook: PriceBook,
  settings: AppSettings,
  location: string,
  itemId: string,
  preferBlackMarketOrder: boolean,
): string | null {
  const pricePoint = getPricePoint(priceBook, settings, location, itemId)
  if (!pricePoint) {
    return null
  }

  return preferBlackMarketOrder
    ? pricePoint.buyOrderUpdatedAt ?? pricePoint.sellOrderUpdatedAt
    : pricePoint.sellOrderUpdatedAt ?? pricePoint.buyOrderUpdatedAt
}

function resolveMaterialPurchaseUnitPrice(
  priceBook: PriceBook,
  settings: AppSettings,
  buyPriceType: BuyPriceType,
  location: string,
  itemId: string,
): number | null {
  const pricePoint = getPricePoint(priceBook, settings, location, itemId)
  const listingTaxPct = getMarketListingTaxPct(settings.hasPremium)

  switch (buyPriceType) {
    case 'TRADE': {
      const estimated = pricePoint?.estimated ?? null
      return estimated !== null ? estimated * 0.95 : null
    }
    case 'INSTANT_BUY': {
      const sellOrder = pricePoint?.sellOrder ?? null
      return sellOrder !== null ? sellOrder * 1.025 : null
    }
    case 'BUY_ORDER': {
      const buyOrder = pricePoint?.buyOrder ?? null
      return buyOrder !== null ? buyOrder * (1 + listingTaxPct / 100) : null
    }
    default:
      return null
  }
}

function resolveMaterialPurchaseTimestamp(
  priceBook: PriceBook,
  settings: AppSettings,
  buyPriceType: BuyPriceType,
  location: string,
  itemId: string,
): string | null {
  const pricePoint = getPricePoint(priceBook, settings, location, itemId)

  switch (buyPriceType) {
    case 'INSTANT_BUY':
      return pricePoint?.sellOrderUpdatedAt ?? null
    case 'BUY_ORDER':
      return pricePoint?.buyOrderUpdatedAt ?? null
    case 'TRADE':
    default:
      return null
  }
}

function resolveDailyBonusRate(itemCategory: string, settings: AppSettings): number {
  let total = 0

  if (settings.dailyBonusA.category.length > 0 && settings.dailyBonusA.category === itemCategory) {
    total += settings.dailyBonusA.percent / 100
  }

  if (settings.dailyBonusB.category.length > 0 && settings.dailyBonusB.category === itemCategory) {
    total += settings.dailyBonusB.percent / 100
  }

  return total
}

function resolveReturnRate(itemCategory: string, city: CityProfile, settings: AppSettings): number {
  const cityCategoryBonus = city.categoryBonuses[itemCategory] ?? 0
  return localProductionBonusToReturnRate(city.baseCraftBonus + cityCategoryBonus + resolveDailyBonusRate(itemCategory, settings))
}

export function getDefaultCraftCity(
  baseItem: CraftItem,
  cityProfiles: CityProfile[],
  categoryPresetCity: Record<string, string>,
): string {
  const preferredCity = categoryPresetCity[baseItem.craftingCategory]
  if (preferredCity && cityProfiles.some((city) => city.cityName === preferredCity)) {
    return preferredCity
  }

  return cityProfiles[0]?.cityName ?? 'Thetford'
}

export function getDefaultMaterialCityForGroup(
  materialGroup: MaterialGroup,
  craftCity: string,
  categoryPresetCity: Record<string, string>,
): string {
  return categoryPresetCity[materialGroup] ?? craftCity
}

export function getMaterialGroupsForItem(baseItem: CraftItem): MaterialGroup[] {
  const groups = new Set<MaterialGroup>()

  for (const resource of baseItem.recipe) {
    if (isArtifactItem(resource.itemId)) {
      continue
    }

    groups.add(inferMaterialGroup(resource.itemId))
  }

  return MATERIAL_GROUP_ORDER.filter((group) => groups.has(group))
}

export function hasArtifactInputs(baseItem: CraftItem): boolean {
  return baseItem.recipe.some((resource) => isArtifactItem(resource.itemId))
}

function getJournalFameForPlan(baseItem: CraftItem, enchantment: EnchantmentLevel): number {
  if (!baseItem.journal) {
    return 0
  }

  return (
    baseItem.journal.fameByEnchantment[enchantment] ??
    baseItem.journal.fameByEnchantment[0] ??
    0
  )
}

function getItemValueForPlan(baseItem: CraftItem, enchantment: EnchantmentLevel): number {
  return baseItem.itemValueByEnchantment[enchantment] ?? baseItem.itemValueByEnchantment[0] ?? baseItem.itemValue ?? 0
}

function resolveCraftCityProfile(
  plan: SelectedCraftPlan,
  baseItem: CraftItem,
  cityProfiles: CityProfile[],
  categoryPresetCity: Record<string, string>,
): CityProfile {
  const explicitCity = cityProfiles.find((city) => city.cityName === plan.craftCity)
  if (explicitCity) {
    return explicitCity
  }

  const defaultCity = getDefaultCraftCity(baseItem, cityProfiles, categoryPresetCity)
  return cityProfiles.find((city) => city.cityName === defaultCity) ?? cityProfiles[0]
}

function resolveArtifactBuyCity(plan: SelectedCraftPlan, craftCity: string): string {
  return plan.artifactBuyCity === 'AUTO' || plan.artifactBuyCity.length === 0
    ? craftCity
    : plan.artifactBuyCity
}

function resolveResourceBuyCity(
  resourceItemId: string,
  plan: SelectedCraftPlan,
  craftCity: string,
  categoryPresetCity: Record<string, string>,
): string {
  if (isArtifactItem(resourceItemId)) {
    return resolveArtifactBuyCity(plan, craftCity)
  }

  const materialGroup = inferMaterialGroup(resourceItemId)
  return (
    plan.materialCityByGroup[materialGroup] ??
    getDefaultMaterialCityForGroup(materialGroup, craftCity, categoryPresetCity)
  )
}

export function toVariantId(itemId: string, enchantment: EnchantmentLevel): string {
  return `${itemId}#${enchantment}`
}

export function buildTierLabel(tier: number | null, enchantment: EnchantmentLevel): string {
  return `${tier ?? '?'} .${enchantment}`
}

export function buildCraftVariant(
  baseItem: CraftItem,
  enchantment: EnchantmentLevel,
  knownMarketItemIds: Set<string>,
): CraftVariant | null {
  const marketItemId = resolveMarketItemId(baseItem.itemId, enchantment, knownMarketItemIds)

  if (marketItemId === null) {
    return null
  }

  return {
    variantId: toVariantId(baseItem.itemId, enchantment),
    baseItemId: baseItem.itemId,
    displayName: baseItem.displayName,
    enchantment,
    marketItemId,
    tierLabel: buildTierLabel(baseItem.tier, enchantment),
  }
}

function createVariantForPlan(
  plan: SelectedCraftPlan,
  baseItem: CraftItem,
  knownMarketItemIds: Set<string>,
): { variant: CraftVariant; outputIdResolved: boolean } {
  const resolved = buildCraftVariant(baseItem, plan.enchantment, knownMarketItemIds)

  if (resolved) {
    return {
      variant: resolved,
      outputIdResolved: true,
    }
  }

  return {
    variant: {
      variantId: plan.variantId,
      baseItemId: baseItem.itemId,
      displayName: baseItem.displayName,
      enchantment: plan.enchantment,
      marketItemId: baseItem.itemId,
      tierLabel: buildTierLabel(baseItem.tier, plan.enchantment),
    },
    outputIdResolved: false,
  }
}

export function collectRequiredPriceItemIds(params: {
  plans: SelectedCraftPlan[]
  itemsById: Map<string, CraftItem>
  knownMarketItemIds: Set<string>
  includeJournals: boolean
}): string[] {
  const { plans, itemsById, knownMarketItemIds, includeJournals } = params
  const requiredIds = new Set<string>()

  for (const plan of plans) {
    const baseItem = itemsById.get(plan.baseItemId)
    if (!baseItem) {
      continue
    }

    requiredIds.add(resolveMarketItemId(baseItem.itemId, plan.enchantment, knownMarketItemIds) ?? baseItem.itemId)

    for (const resource of baseItem.recipe) {
      requiredIds.add(resolveResourceMarketItemId(resource.itemId, plan.enchantment, knownMarketItemIds))
    }

    if (includeJournals && baseItem.journal) {
      requiredIds.add(baseItem.journal.emptyItemId)
      requiredIds.add(baseItem.journal.fullItemId)
    }
  }

  return [...requiredIds]
}

function calculateSinglePlan(params: {
  plan: SelectedCraftPlan
  baseItem: CraftItem
  settings: AppSettings
  priceBook: PriceBook
  cityProfiles: CityProfile[]
  categoryPresetCity: Record<string, string>
  knownMarketItemIds: Set<string>
}): PlannedCraftResult {
  const {
    plan,
    baseItem,
    settings,
    priceBook,
    cityProfiles,
    categoryPresetCity,
    knownMarketItemIds,
  } = params

  const { variant, outputIdResolved } = createVariantForPlan(plan, baseItem, knownMarketItemIds)
  const craftCityProfile = resolveCraftCityProfile(plan, baseItem, cityProfiles, categoryPresetCity)
  const craftCity = craftCityProfile.cityName
  const sellCity = plan.sellCity
  const quantity = Math.max(1, plan.quantity)
  const returnRate = resolveReturnRate(baseItem.craftingCategory, craftCityProfile, settings)
  const priceTimestamps: Array<string | null> = []

  const materialLines: MaterialCostLine[] = baseItem.recipe.map((resource) => {
    const marketItemId = resolveResourceMarketItemId(resource.itemId, plan.enchantment, knownMarketItemIds)
    const buyCity = resolveResourceBuyCity(resource.itemId, plan, craftCity, categoryPresetCity)
    const baseQuantity = resource.count * quantity
    const returnEligible = isReturnEligibleResource(resource.itemId)
    const lineQuantity = returnEligible ? Math.ceil(baseQuantity * (1 - returnRate)) : baseQuantity
    const resolvedUnitPrice = resolveMaterialPurchaseUnitPrice(
      priceBook,
      settings,
      plan.buyPriceType,
      buyCity,
      marketItemId,
    )
    priceTimestamps.push(
      resolveMaterialPurchaseTimestamp(priceBook, settings, plan.buyPriceType, buyCity, marketItemId),
    )
    const unitPrice = resolvedUnitPrice ?? 0

    return {
      baseItemId: resource.itemId,
      marketItemId,
      displayName: resource.displayName,
      materialGroup: isArtifactItem(resource.itemId) ? null : inferMaterialGroup(resource.itemId),
      buyCity,
      baseQuantity,
      quantity: lineQuantity,
      returnedQuantity: returnEligible ? Math.max(0, baseQuantity - lineQuantity) : 0,
      unitPrice,
      totalCost: unitPrice * lineQuantity,
      isArtifact: isArtifactItem(resource.itemId),
    }
  })

  const sellPriceUnit = resolveOutputSaleUnitPrice(
    priceBook,
    settings,
    sellCity,
    variant.marketItemId,
    sellCity === 'Black Market',
  )
  priceTimestamps.push(
    resolveOutputSaleTimestamp(priceBook, settings, sellCity, variant.marketItemId, sellCity === 'Black Market'),
  )
  const avgSoldPerDay30d = resolveAverageSoldPerDay(priceBook, settings, sellCity, variant.marketItemId)
  const avgPrice30d = resolveAveragePrice30d(priceBook, settings, sellCity, variant.marketItemId)
  const craftCityPrice = resolveEstimatedPrice(priceBook, settings, craftCity, variant.marketItemId)
  const craftCityPrice30d = resolveAveragePrice30d(priceBook, settings, craftCity, variant.marketItemId)
  const sellCityPrice30d = resolveAveragePrice30d(priceBook, settings, sellCity, variant.marketItemId)

  const missingPrices: string[] = []

  if (!outputIdResolved && plan.enchantment > 0) {
    missingPrices.push(`No market variant found for ${baseItem.displayName} [${buildTierLabel(baseItem.tier, plan.enchantment)}]`)
  }

  const materialEffectiveCost = sumNullable(materialLines.map((line) => line.totalCost))
  const materialBaseCost = sumNullable(
    materialLines.map((line) => (line.unitPrice ?? 0) * line.baseQuantity),
  )
  const journalFamePerCraft = settings.includeJournals ? getJournalFameForPlan(baseItem, plan.enchantment) : 0
  const journalAmount =
    baseItem.journal && baseItem.journal.maxFame > 0 ? (journalFamePerCraft / baseItem.journal.maxFame) * quantity : 0
  const journalBuyCity = craftCity
  const journalSellCity = craftCity
  const journalBuyUnitPrice =
    baseItem.journal && journalAmount > 0
      ? resolveMaterialPurchaseUnitPrice(
          priceBook,
          settings,
          plan.buyPriceType,
          journalBuyCity,
          baseItem.journal.emptyItemId,
        )
      : null
  if (baseItem.journal && journalAmount > 0) {
    priceTimestamps.push(
      resolveMaterialPurchaseTimestamp(priceBook, settings, plan.buyPriceType, journalBuyCity, baseItem.journal.emptyItemId),
    )
  }
  const journalSellUnitPrice =
    baseItem.journal && journalAmount > 0
      ? resolveOutputSaleUnitPrice(priceBook, settings, journalSellCity, baseItem.journal.fullItemId, false)
      : null
  if (baseItem.journal && journalAmount > 0) {
    priceTimestamps.push(
      resolveOutputSaleTimestamp(priceBook, settings, journalSellCity, baseItem.journal.fullItemId, false),
    )
  }
  const journalLine: JournalLine | null =
    baseItem.journal && journalAmount > 0
      ? {
          amount: journalAmount,
          buyCity: journalBuyCity,
          sellCity: journalSellCity,
          emptyItemId: baseItem.journal.emptyItemId,
          emptyDisplayName: baseItem.journal.emptyDisplayName,
          fullItemId: baseItem.journal.fullItemId,
          fullDisplayName: baseItem.journal.fullDisplayName,
          famePerCraft: journalFamePerCraft,
          journalMaxFame: baseItem.journal.maxFame,
          buyUnitPrice: journalBuyUnitPrice ?? 0,
          sellUnitPrice: journalSellUnitPrice ?? 0,
          buyTotalCost: (journalBuyUnitPrice ?? 0) * journalAmount,
          sellTotalRevenue: (journalSellUnitPrice ?? 0) * journalAmount,
          netValue: ((journalSellUnitPrice ?? 0) - (journalBuyUnitPrice ?? 0)) * journalAmount,
        }
      : null
  const journalCost = journalLine?.buyTotalCost ?? 0
  const journalRevenue = journalLine?.sellTotalRevenue ?? 0

  const transportReferenceValue = craftCityPrice30d ?? sellCityPrice30d ?? 0
  const selectedItemValue = getItemValueForPlan(baseItem, plan.enchantment)
  const itemValuePerCraft = selectedItemValue > 0 ? selectedItemValue : null
  const stationNutrition =
    itemValuePerCraft !== null ? itemValuePerCraft * TOTAL_NUTRITION_PER_ITEM_VALUE * quantity : null
  const stationFee =
    stationNutrition !== null
      ? (stationNutrition * Math.max(0, settings.craftingStationFeePer100Nutrition)) / 100
      : null

  const marketTaxPct = getMarketListingTaxPct(settings.hasPremium) + getMarketSalesTaxPct()
  const productRevenue = sellPriceUnit * quantity
  const revenue = productRevenue + journalRevenue
  const marketFee = revenue !== null ? revenue * (marketTaxPct / 100) : null

  const transportFee =
    sellCity === 'Black Market'
      ? Math.max(
          transportReferenceValue * quantity * (Math.max(0, settings.transportEmvPct) / 100),
          Math.max(0, baseItem.weight * quantity) * Math.max(0, settings.transportSilverPerKg),
        )
      : 0

  const totalCost =
    materialEffectiveCost !== null && transportFee !== null && stationFee !== null
      ? materialEffectiveCost + journalCost + stationFee + transportFee
      : null

  const netProfit =
    revenue !== null && marketFee !== null && totalCost !== null ? revenue - marketFee - totalCost : null

  const marginPct = netProfit !== null && totalCost !== null && totalCost > 0 ? (netProfit / totalCost) * 100 : null

  return {
    plan,
    variant,
    baseItem,
    craftCity,
    sellCity,
    returnRate,
    materialLines,
    journalLine,
    missingPrices: deduplicate(missingPrices),
    estimatedMarketValue: craftCityPrice ?? sellPriceUnit,
    sellPriceUnit,
    priceAgeHours: resolveMaxPriceAgeHours(priceTimestamps),
    avgSoldPerDay30d,
    avgPrice30d,
    materialBaseCost,
    materialEffectiveCost,
    productRevenue,
    journalCost,
    journalRevenue,
    itemValuePerCraft,
    stationNutrition,
    stationFee,
    marketFee,
    transportFee,
    totalCost,
    revenue,
    netProfit,
    marginPct,
  }
}

export function calculatePlannedCrafts(params: {
  plans: SelectedCraftPlan[]
  itemsById: Map<string, CraftItem>
  settings: AppSettings
  priceBook: PriceBook
  cityProfiles: CityProfile[]
  categoryPresetCity: Record<string, string>
  knownMarketItemIds: Set<string>
}): PlannedCraftView {
  const { plans, itemsById, settings, priceBook, cityProfiles, categoryPresetCity, knownMarketItemIds } = params

  const results: PlannedCraftResult[] = []

  for (const plan of plans) {
    const baseItem = itemsById.get(plan.baseItemId)
    if (!baseItem) {
      continue
    }

    results.push(
      calculateSinglePlan({
        plan,
        baseItem,
        settings,
        priceBook,
        cityProfiles,
        categoryPresetCity,
        knownMarketItemIds,
      }),
    )
  }

  const readyResults = results.filter(
    (result) => result.totalCost !== null && result.revenue !== null && result.marketFee !== null,
  )

  const summary = {
    plannedCrafts: results.length,
    readyCrafts: readyResults.length,
    totalCost: readyResults.reduce((sum, result) => sum + (result.totalCost ?? 0), 0),
    totalRevenue: readyResults.reduce((sum, result) => sum + (result.revenue ?? 0), 0),
    totalStationFee: readyResults.reduce((sum, result) => sum + (result.stationFee ?? 0), 0),
    totalMarketFee: readyResults.reduce((sum, result) => sum + (result.marketFee ?? 0), 0),
    totalProfit: readyResults.reduce((sum, result) => sum + (result.netProfit ?? 0), 0),
    totalProfitPct: null as number | null,
  }

  summary.totalProfitPct = summary.totalCost > 0 ? (summary.totalProfit / summary.totalCost) * 100 : null

  return {
    results,
    summary,
  }
}

export function getAllEnchantments(): EnchantmentLevel[] {
  return [0, ...ENCHANTMENT_LEVELS]
}

export function buildDailyBonusOptionList(): ReadonlyArray<{ value: string; label: string }> {
  return DAILY_BONUS_OPTIONS
}

export function getMarketListingTaxPct(hasPremium: boolean): number {
  return 2.5 + (hasPremium ? 4 : 6.5)
}

export function getMarketSalesTaxPct(): number {
  return 2.5
}

export function getSellTargets(cityNames: string[]): SellTarget[] {
  return ['Black Market', 'Caerleon', ...cityNames.filter((city): city is Exclude<SellTarget, 'Black Market' | 'Caerleon'> => city !== 'Black Market' && city !== 'Caerleon')]
}
