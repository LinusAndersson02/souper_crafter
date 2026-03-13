import { getCachedPricePoint } from './pricing'
import {
  BUY_PRICE_TYPE_LABELS,
  getDefaultMaterialCityForGroup,
  getMarketListingTaxPct,
  getMarketSalesTaxPct,
} from './calculator'
import type {
  BuyPriceType,
  CityProfile,
  MaterialGroup,
  PriceBook,
  PriceWindow,
  RecipeResource,
  RefiningItem,
  ServerRegion,
} from './types'

const ESTIMATE_WINDOW: PriceWindow = '7d'
const TOTAL_NUTRITION_PER_ITEM_VALUE = 0.1125
export const REFINING_AUTO_BUY_CITY = 'AUTO_RESOURCE_CITY'
export const REFINING_AUTO_SELL_CITY = 'AUTO_REFINING_CITY'
export type RefiningSellPriceType = 'SELL_ORDER' | 'TRADE'
export type RefiningPriceSource = 'CURRENT' | 'AVERAGE_30D'

const ABUNDANT_RESOURCE_CITY_BY_GROUP: Record<MaterialGroup, string> = {
  wood: 'Lymhurst',
  fiber: 'Thetford',
  hide: 'Bridgewatch',
  ore: 'Fort Sterling',
  rock: 'Martlock',
  other: 'Caerleon',
}

export const REFINING_FAMILY_OPTIONS: ReadonlyArray<{ value: MaterialGroup; label: string }> = [
  { value: 'wood', label: 'Planks' },
  { value: 'fiber', label: 'Cloth' },
  { value: 'hide', label: 'Leather' },
  { value: 'ore', label: 'Bars' },
]

export const REFINING_SELL_PRICE_TYPE_LABELS: Record<RefiningSellPriceType, string> = {
  SELL_ORDER: 'Sell Order',
  TRADE: 'Trade (-5%)',
}

export const REFINING_PRICE_SOURCE_LABELS: Record<RefiningPriceSource, string> = {
  CURRENT: 'Current',
  AVERAGE_30D: 'Average (30d)',
}

export interface RefiningSettings {
  search: string
  tierFilters: number[]
  familyFilters: MaterialGroup[]
  enchantmentFilters: number[]
  serverRegion: ServerRegion
  hasPremium: boolean
  includeBuyTaxes: boolean
  resourcePriceSource: RefiningPriceSource
  productPriceSource: RefiningPriceSource
  stationFeePer100Nutrition: number
  defaultBuyCity: string
  defaultBuyPriceType: BuyPriceType
  defaultSellCity: string
  defaultSellPriceType: RefiningSellPriceType
  stackFromTier: number
}

export interface RefiningPlan {
  itemId: string
  quantity: number
  refineCity: string
  buyCity: string
  sellCity: string
  buyPriceType: BuyPriceType
  sellPriceType: RefiningSellPriceType
}

export interface RefiningInputLine {
  itemId: string
  marketItemId: string
  displayName: string
  quantity: number
  buyCity: string
  unitPrice: number
  totalCost: number
}

export interface RefiningStepInputLine {
  itemId: string
  marketItemId: string
  displayName: string
  quantity: number
  unitPrice: number
  totalCost: number
  marketCity: string
  sourceKind: 'RAW_RESOURCE' | 'PREVIOUS_PRODUCT'
}

export interface RefiningStepLine {
  itemId: string
  marketItemId: string
  displayName: string
  quantity: number
  refineCity: string
  returnRate: number
  sellPriceUnit: number
  revenue: number
  marketFee: number
  stationFee: number
  resourceCost: number
  returnValue: number
  stepProfit: number
  stackedPreviousProfit: number
  totalProfit: number
  directInputs: RefiningStepInputLine[]
}

export interface RefiningResult {
  plan: RefiningPlan
  item: RefiningItem
  terminalInputs: RefiningInputLine[]
  steps: RefiningStepLine[]
  totalInputCost: number
  totalStationFee: number
  totalReturnValue: number
  marketFee: number
  totalCost: number
  sellPriceUnit: number
  priceAgeHours: number | null
  revenue: number
  netProfit: number
  marginPct: number | null
  avgSoldPerDay30d: number | null
  avgPrice30d: number | null
  missingPrices: string[]
}

export interface RefiningView {
  results: RefiningResult[]
  summary: {
    plannedItems: number
    totalCost: number
    totalRevenue: number
    totalProfit: number
    totalProfitPct: number | null
  }
}

type RecipeBreakdown = {
  rawInputs: Array<RecipeResource & { marketItemId: string; displayNameLabel: string }>
  previousRefinedInput:
    | {
        item: RefiningItem
        count: number
        displayNameLabel: string
      }
    | null
}

type RefiningComputation = {
  steps: RefiningStepLine[]
  purchasedInputs: Map<string, RefiningInputLine>
  totalInputCost: number
  totalStationFee: number
  totalReturnValue: number
  totalMarketFee: number
  totalProfit: number
  priceTimestamps: Array<string | null>
  missingPrices: string[]
}

function parseTierAndEnchantment(itemId: string): { tier: number | null; enchantment: number } {
  const tierMatch = itemId.toUpperCase().match(/^T(\d+)/)
  const enchantmentMatch = itemId.toUpperCase().match(/@(\d+)$/) ?? itemId.toUpperCase().match(/_LEVEL(\d+)$/)

  return {
    tier: tierMatch ? Number(tierMatch[1]) : null,
    enchantment: enchantmentMatch ? Number(enchantmentMatch[1]) : 0,
  }
}

export function buildRefiningItemLabel(item: { displayName: string; tier: number | null; enchantment: number }): string {
  const tierText = item.tier === null ? '--' : `T${item.tier}.${item.enchantment}`
  return `${item.displayName} [${tierText}]`
}

function normalizeMarketItemId(itemId: string, knownMarketItemIds: Set<string>): string {
  const levelMatch = itemId.match(/_LEVEL(\d+)$/)
  if (levelMatch) {
    const enchantment = Number(levelMatch[1])
    const candidate = `${itemId}@${enchantment}`
    if (knownMarketItemIds.has(candidate)) {
      return candidate
    }
  }

  return itemId
}

function resolvePricePoint(
  priceBook: PriceBook,
  serverRegion: ServerRegion,
  location: string,
  itemId: string,
) {
  return getCachedPricePoint(priceBook.values, serverRegion, ESTIMATE_WINDOW, location, itemId)
}

function resolveAveragePrice30d(
  priceBook: PriceBook,
  settings: RefiningSettings,
  location: string,
  itemId: string,
): number | null {
  return resolvePricePoint(priceBook, settings.serverRegion, location, itemId)?.avgPrice30d ?? null
}

function resolveAverageSoldPerDay(
  priceBook: PriceBook,
  settings: RefiningSettings,
  location: string,
  itemId: string,
): number | null {
  return resolvePricePoint(priceBook, settings.serverRegion, location, itemId)?.avgSoldPerDay30d ?? null
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

function resolveOutputSaleUnitPrice(
  priceBook: PriceBook,
  settings: RefiningSettings,
  sellPriceType: RefiningSellPriceType,
  location: string,
  itemId: string,
): number {
  const pricePoint = resolvePricePoint(priceBook, settings.serverRegion, location, itemId)

  if (!pricePoint) {
    return 0
  }

  const referenceAverage = pricePoint.avgPrice30d ?? pricePoint.estimated ?? pricePoint.sellOrder ?? pricePoint.buyOrder ?? 0
  const referenceCurrent = pricePoint.sellOrder ?? pricePoint.estimated ?? pricePoint.buyOrder ?? 0
  const referencePrice = settings.productPriceSource === 'AVERAGE_30D' ? referenceAverage : referenceCurrent

  if (sellPriceType === 'TRADE') {
    return referencePrice * 0.95
  }

  return referencePrice
}

function resolveOutputSaleTimestamp(
  priceBook: PriceBook,
  settings: RefiningSettings,
  location: string,
  itemId: string,
): string | null {
  const pricePoint = resolvePricePoint(priceBook, settings.serverRegion, location, itemId)
  return pricePoint?.sellOrderUpdatedAt ?? pricePoint?.buyOrderUpdatedAt ?? null
}

function resolveMaterialPurchaseUnitPrice(
  priceBook: PriceBook,
  settings: RefiningSettings,
  buyPriceType: BuyPriceType,
  location: string,
  itemId: string,
): number {
  const pricePoint = resolvePricePoint(priceBook, settings.serverRegion, location, itemId)
  const listingTaxPct = getMarketListingTaxPct(settings.hasPremium)

  if (!pricePoint) {
    return 0
  }

  const referenceAverage = pricePoint.avgPrice30d ?? pricePoint.estimated ?? pricePoint.sellOrder ?? pricePoint.buyOrder ?? 0
  const currentBuyOrder = pricePoint.buyOrder ?? pricePoint.estimated ?? 0
  const currentSellOrder = pricePoint.sellOrder ?? pricePoint.estimated ?? 0

  if (buyPriceType === 'TRADE') {
    const referenceTrade = settings.resourcePriceSource === 'AVERAGE_30D' ? referenceAverage : pricePoint.estimated ?? currentSellOrder
    return referenceTrade * 0.95
  }

  if (buyPriceType === 'BUY_ORDER') {
    const basePrice = settings.resourcePriceSource === 'AVERAGE_30D' ? referenceAverage : currentBuyOrder
    return settings.includeBuyTaxes ? basePrice * (1 + listingTaxPct / 100) : basePrice
  }

  const basePrice = settings.resourcePriceSource === 'AVERAGE_30D' ? referenceAverage : currentSellOrder
  return settings.includeBuyTaxes ? basePrice * 1.025 : basePrice
}

function resolveMaterialPurchaseTimestamp(
  priceBook: PriceBook,
  settings: RefiningSettings,
  buyPriceType: BuyPriceType,
  location: string,
  itemId: string,
): string | null {
  const pricePoint = resolvePricePoint(priceBook, settings.serverRegion, location, itemId)

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

function getReturnRateFromBonus(totalBonus: number): number {
  if (totalBonus <= 0) {
    return 0
  }

  return totalBonus / (1 + totalBonus)
}

function resolveRefineCityProfile(cityProfiles: CityProfile[], cityName: string): CityProfile {
  return (
    cityProfiles.find((city) => city.cityName === cityName) ?? {
      clusterId: '0000',
      cityName,
      baseCraftBonus: 0,
      categoryBonuses: {},
    }
  )
}

function resolveRefiningReturnRate(category: MaterialGroup, cityProfiles: CityProfile[], cityName: string): number {
  const cityProfile = resolveRefineCityProfile(cityProfiles, cityName)
  const totalBonus = cityProfile.baseCraftBonus + (cityProfile.categoryBonuses[category] ?? 0)
  return getReturnRateFromBonus(totalBonus)
}

export function getDefaultRefiningCity(item: RefiningItem, categoryPresetCity: Record<string, string>): string {
  return getDefaultMaterialCityForGroup(item.craftingCategory, 'Caerleon', categoryPresetCity)
}

export function getDefaultRefiningBuyCity(item: RefiningItem, defaultBuyCity: string): string {
  return defaultBuyCity === REFINING_AUTO_BUY_CITY
    ? (ABUNDANT_RESOURCE_CITY_BY_GROUP[item.craftingCategory] ?? 'Caerleon')
    : defaultBuyCity
}

export function getDefaultRefiningSellCity(refineCity: string, defaultSellCity: string): string {
  return defaultSellCity === REFINING_AUTO_SELL_CITY ? refineCity : defaultSellCity
}

function mergeInputLine(target: Map<string, RefiningInputLine>, nextLine: RefiningInputLine): void {
  const key = `${nextLine.marketItemId}|${nextLine.buyCity}`
  const existing = target.get(key)
  if (!existing) {
    target.set(key, { ...nextLine })
    return
  }

  existing.quantity += nextLine.quantity
  existing.totalCost += nextLine.totalCost
}

function shouldStackPreviousTier(currentItem: RefiningItem, settings: RefiningSettings): boolean {
  if (currentItem.tier === null) {
    return false
  }

  return currentItem.tier > settings.stackFromTier
}

function looksLikeMetadataName(value: string): boolean {
  return /^[A-Z0-9_@]+$/.test(value)
}

function inferDisplayNameFromMarketItemId(marketItemId: string): string {
  const normalized = marketItemId.toUpperCase().replace(/@\d+$/, '').replace(/_LEVEL\d+$/, '')

  if (normalized.includes('_WOOD')) return 'Logs'
  if (normalized.includes('_FIBER')) return 'Fiber'
  if (normalized.includes('_HIDE')) return 'Hide'
  if (normalized.includes('_ORE')) return 'Ore'
  if (normalized.includes('_ROCK')) return 'Stone'
  if (normalized.includes('_PLANKS')) return 'Planks'
  if (normalized.includes('_CLOTH')) return 'Cloth'
  if (normalized.includes('_LEATHER')) return 'Leather'
  if (normalized.includes('_METALBAR')) return 'Bars'
  if (normalized.includes('_STONEBLOCK')) return 'Stone Blocks'

  return normalized
    .replace(/^T\d+_/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1)}${part.slice(1).toLowerCase()}`)
    .join(' ')
}

function buildRecipeResourceLabel(
  resource: Pick<RecipeResource, 'itemId' | 'displayName'>,
  knownMarketItemIds: Set<string>,
): string {
  const marketItemId = normalizeMarketItemId(resource.itemId, knownMarketItemIds)
  const parsed = parseTierAndEnchantment(marketItemId)
  const displayName = resource.displayName && !looksLikeMetadataName(resource.displayName)
    ? resource.displayName
    : inferDisplayNameFromMarketItemId(marketItemId)

  return buildRefiningItemLabel({
    displayName,
    tier: parsed.tier,
    enchantment: parsed.enchantment,
  })
}

function describeDirectInputs(inputs: RefiningStepInputLine[]): string {
  return inputs.map((input) => `${input.quantity}x ${input.displayName}`).join(' + ')
}

function analyzeRecipe(
  item: RefiningItem,
  refiningItemsById: Map<string, RefiningItem>,
  knownMarketItemIds: Set<string>,
): RecipeBreakdown {
  const rawInputs: RecipeBreakdown['rawInputs'] = []
  let previousRefinedInput: RecipeBreakdown['previousRefinedInput'] = null

  for (const resource of item.recipe) {
    const refinedDependency = refiningItemsById.get(resource.itemId)
    if (refinedDependency) {
      previousRefinedInput = {
        item: refinedDependency,
        count: resource.count,
        displayNameLabel: buildRefiningItemLabel(refinedDependency),
      }
      continue
    }

    rawInputs.push({
      ...resource,
      marketItemId: normalizeMarketItemId(resource.itemId, knownMarketItemIds),
      displayNameLabel: buildRecipeResourceLabel(resource, knownMarketItemIds),
    })
  }

  return { rawInputs, previousRefinedInput }
}

function computeRefiningChain(params: {
  item: RefiningItem
  quantity: number
  plan: RefiningPlan
  settings: RefiningSettings
  priceBook: PriceBook
  cityProfiles: CityProfile[]
  refiningItemsById: Map<string, RefiningItem>
  knownMarketItemIds: Set<string>
}): RefiningComputation {
  const { item, quantity, plan, settings, priceBook, cityProfiles, refiningItemsById, knownMarketItemIds } = params
  const recipe = analyzeRecipe(item, refiningItemsById, knownMarketItemIds)
  const directInputs: RefiningStepInputLine[] = []
  const purchasedInputs = new Map<string, RefiningInputLine>()
  const missingPrices: string[] = []
  const priceTimestamps: Array<string | null> = []

  for (const rawInput of recipe.rawInputs) {
    const inputQuantity = rawInput.count * quantity
    const unitPrice = resolveMaterialPurchaseUnitPrice(
      priceBook,
      settings,
      plan.buyPriceType,
      plan.buyCity,
      rawInput.marketItemId,
    )

    directInputs.push({
      itemId: rawInput.itemId,
      marketItemId: rawInput.marketItemId,
      displayName: rawInput.displayNameLabel,
      quantity: inputQuantity,
      unitPrice,
      totalCost: inputQuantity * unitPrice,
      marketCity: plan.buyCity,
      sourceKind: 'RAW_RESOURCE',
    })

    mergeInputLine(purchasedInputs, {
      itemId: rawInput.itemId,
      marketItemId: rawInput.marketItemId,
      displayName: rawInput.displayNameLabel,
      quantity: inputQuantity,
      buyCity: plan.buyCity,
      unitPrice,
      totalCost: inputQuantity * unitPrice,
    })

    if (unitPrice <= 0) {
      missingPrices.push(`${rawInput.marketItemId} (${plan.buyCity}, ${BUY_PRICE_TYPE_LABELS[plan.buyPriceType].toLowerCase()})`)
    }
    priceTimestamps.push(
      resolveMaterialPurchaseTimestamp(priceBook, settings, plan.buyPriceType, plan.buyCity, rawInput.marketItemId),
    )
  }

  let previousComputation: RefiningComputation | null = null
  if (recipe.previousRefinedInput) {
    const previousQuantity = recipe.previousRefinedInput.count * quantity
    const previousUnitPrice = resolveOutputSaleUnitPrice(
      priceBook,
      settings,
      plan.sellPriceType,
      plan.sellCity,
      recipe.previousRefinedInput.item.marketItemId,
    )

    directInputs.push({
      itemId: recipe.previousRefinedInput.item.itemId,
      marketItemId: recipe.previousRefinedInput.item.marketItemId,
      displayName: recipe.previousRefinedInput.displayNameLabel,
      quantity: previousQuantity,
      unitPrice: previousUnitPrice,
      totalCost: previousQuantity * previousUnitPrice,
      marketCity: plan.sellCity,
      sourceKind: 'PREVIOUS_PRODUCT',
    })

    if (previousUnitPrice <= 0) {
      missingPrices.push(
        `${recipe.previousRefinedInput.item.marketItemId} (${plan.sellCity}, ${REFINING_SELL_PRICE_TYPE_LABELS[plan.sellPriceType].toLowerCase()})`,
      )
    }
    priceTimestamps.push(
      resolveOutputSaleTimestamp(priceBook, settings, plan.sellCity, recipe.previousRefinedInput.item.marketItemId),
    )

    if (shouldStackPreviousTier(item, settings)) {
      previousComputation = computeRefiningChain({
        item: recipe.previousRefinedInput.item,
        quantity: previousQuantity,
        plan,
        settings,
        priceBook,
        cityProfiles,
        refiningItemsById,
        knownMarketItemIds,
      })

      for (const line of previousComputation.purchasedInputs.values()) {
        mergeInputLine(purchasedInputs, line)
      }
      priceTimestamps.push(...previousComputation.priceTimestamps)
      missingPrices.push(...previousComputation.missingPrices)
    } else {
      mergeInputLine(purchasedInputs, {
        itemId: recipe.previousRefinedInput.item.itemId,
        marketItemId: recipe.previousRefinedInput.item.marketItemId,
        displayName: recipe.previousRefinedInput.displayNameLabel,
        quantity: previousQuantity,
        buyCity: plan.sellCity,
        unitPrice: previousUnitPrice,
        totalCost: previousQuantity * previousUnitPrice,
      })
    }
  }

  const resourceCost = directInputs.reduce((sum, input) => sum + input.totalCost, 0)
  const returnRate = resolveRefiningReturnRate(item.craftingCategory, cityProfiles, plan.refineCity)
  const returnValue = resourceCost * returnRate
  const sellPriceUnit = resolveOutputSaleUnitPrice(priceBook, settings, plan.sellPriceType, plan.sellCity, item.marketItemId)
  const revenue = sellPriceUnit * quantity
  const stationFeePerItem = item.tier === 2 && item.enchantment === 0 ? 0 : ((item.itemValue * TOTAL_NUTRITION_PER_ITEM_VALUE) * Math.max(0, settings.stationFeePer100Nutrition)) / 100
  const stationFee = stationFeePerItem * quantity
  const marketFee =
    plan.sellPriceType === 'SELL_ORDER'
      ? revenue * ((getMarketListingTaxPct(settings.hasPremium) + getMarketSalesTaxPct()) / 100)
      : 0
  const stepProfit = revenue - resourceCost + returnValue - stationFee - marketFee
  const stackedPreviousProfit = previousComputation?.totalProfit ?? 0
  const totalProfit = stepProfit + stackedPreviousProfit

  if (sellPriceUnit <= 0) {
    missingPrices.push(`${item.marketItemId} (${plan.sellCity}, ${REFINING_SELL_PRICE_TYPE_LABELS[plan.sellPriceType].toLowerCase()})`)
  }
  priceTimestamps.push(resolveOutputSaleTimestamp(priceBook, settings, plan.sellCity, item.marketItemId))

  const currentStep: RefiningStepLine = {
    itemId: item.itemId,
    marketItemId: item.marketItemId,
    displayName: buildRefiningItemLabel(item),
    quantity,
    refineCity: plan.refineCity,
    returnRate,
    sellPriceUnit,
    revenue,
    marketFee,
    stationFee,
    resourceCost,
    returnValue,
    stepProfit,
    stackedPreviousProfit,
    totalProfit,
    directInputs,
  }

  return {
    steps: [...(previousComputation?.steps ?? []), currentStep],
    purchasedInputs,
    totalInputCost: [...purchasedInputs.values()].reduce((sum, line) => sum + line.totalCost, 0),
    totalStationFee: stationFee + (previousComputation?.totalStationFee ?? 0),
    totalReturnValue: returnValue + (previousComputation?.totalReturnValue ?? 0),
    totalMarketFee: marketFee + (previousComputation?.totalMarketFee ?? 0),
    totalProfit,
    priceTimestamps,
    missingPrices: [...new Set(missingPrices)],
  }
}

export function collectRequiredRefiningPriceItemIds(params: {
  plans: RefiningPlan[]
  refiningItemsById: Map<string, RefiningItem>
  knownMarketItemIds: Set<string>
  settings: RefiningSettings
}): string[] {
  const { plans, refiningItemsById, knownMarketItemIds } = params
  const requiredIds = new Set<string>()

  const walk = (itemId: string): void => {
    const refiningItem = refiningItemsById.get(itemId)
    if (!refiningItem) {
      requiredIds.add(normalizeMarketItemId(itemId, knownMarketItemIds))
      return
    }

    requiredIds.add(refiningItem.marketItemId)

    for (const resource of refiningItem.recipe) {
      walk(resource.itemId)
    }
  }

  for (const plan of plans) {
    const item = refiningItemsById.get(plan.itemId)
    if (!item) {
      continue
    }

    walk(plan.itemId)
  }

  return [...requiredIds]
}

export function calculateRefiningPlans(params: {
  plans: RefiningPlan[]
  refiningItemsById: Map<string, RefiningItem>
  settings: RefiningSettings
  priceBook: PriceBook
  cityProfiles: CityProfile[]
  knownMarketItemIds: Set<string>
}): RefiningView {
  const { plans, refiningItemsById, settings, priceBook, cityProfiles, knownMarketItemIds } = params
  const results: RefiningResult[] = []

  for (const plan of plans) {
    const item = refiningItemsById.get(plan.itemId)
    if (!item) {
      continue
    }

    const quantity = Math.max(1, plan.quantity)
    const computation = computeRefiningChain({
      item,
      quantity,
      plan,
      settings,
      priceBook,
      cityProfiles,
      refiningItemsById,
      knownMarketItemIds,
    })

    const terminalInputs = [...computation.purchasedInputs.values()].sort((a, b) => {
      const cityComparison = a.buyCity.localeCompare(b.buyCity)
      if (cityComparison !== 0) {
        return cityComparison
      }

      const tierComparison = (parseTierAndEnchantment(a.marketItemId).tier ?? 0) - (parseTierAndEnchantment(b.marketItemId).tier ?? 0)
      if (tierComparison !== 0) {
        return tierComparison
      }

      return a.displayName.localeCompare(b.displayName)
    })
    const sellPriceUnit = resolveOutputSaleUnitPrice(priceBook, settings, plan.sellPriceType, plan.sellCity, item.marketItemId)
    const revenue = sellPriceUnit * quantity
    const totalCost = revenue - computation.totalProfit
    const netRevenueAfterSellFees = revenue - (plan.sellPriceType === 'SELL_ORDER'
      ? revenue * ((getMarketListingTaxPct(settings.hasPremium) + getMarketSalesTaxPct()) / 100)
      : 0)
    const marginPct = netRevenueAfterSellFees > 0 ? (computation.totalProfit / netRevenueAfterSellFees) * 100 : null

    results.push({
      plan,
      item,
      terminalInputs,
      steps: computation.steps,
      totalInputCost: computation.totalInputCost,
      totalStationFee: computation.totalStationFee,
      totalReturnValue: computation.totalReturnValue,
      marketFee: computation.totalMarketFee,
      totalCost,
      sellPriceUnit,
      priceAgeHours: resolveMaxPriceAgeHours(computation.priceTimestamps),
      revenue,
      netProfit: computation.totalProfit,
      marginPct,
      avgSoldPerDay30d: resolveAverageSoldPerDay(priceBook, settings, plan.sellCity, item.marketItemId),
      avgPrice30d: resolveAveragePrice30d(priceBook, settings, plan.sellCity, item.marketItemId),
      missingPrices: computation.missingPrices,
    })
  }

  const totalCost = results.reduce((sum, result) => sum + result.totalCost, 0)
  const totalRevenue = results.reduce((sum, result) => sum + result.revenue, 0)
  const totalProfit = results.reduce((sum, result) => sum + result.netProfit, 0)
  const totalNetRevenueAfterSellFees = results.reduce(
    (sum, result) => sum + (result.revenue - (result.steps[result.steps.length - 1]?.marketFee ?? 0)),
    0,
  )

  return {
    results,
    summary: {
      plannedItems: results.length,
      totalCost,
      totalRevenue,
      totalProfit,
      totalProfitPct: totalNetRevenueAfterSellFees > 0 ? (totalProfit / totalNetRevenueAfterSellFees) * 100 : null,
    },
  }
}

export { BUY_PRICE_TYPE_LABELS, describeDirectInputs }
