import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  BUY_PRICE_TYPE_LABELS,
  MATERIAL_GROUP_LABELS,
  buildDailyBonusOptionList,
  buildCraftVariant,
  calculatePlannedCrafts,
  collectRequiredPriceItemIds,
  getAllEnchantments,
  getDefaultCraftCity,
  getDefaultMaterialCityForGroup,
  getMaterialGroupsForItem,
  hasArtifactInputs,
} from './calculator'
import { loadGameData } from './dataLoader'
import { fetchPriceBook } from './pricing'
import type {
  AppSettings,
  ArtifactFilter,
  BuyPriceType,
  CraftItem,
  CraftVariant,
  EnchantmentLevel,
  GameData,
  MaterialGroup,
  PlannedCraftResult,
  PriceBook,
  SelectedCraftPlan,
  SellTarget,
  ServerRegion,
} from './types'
import { useLocalStorageState } from './useLocalStorage'

const SETTINGS_STORAGE_KEY = 'souper-crafter-settings-v6'
const PLANS_STORAGE_KEY = 'souper-crafter-selected-plans-v3'
const ESTIMATE_WINDOW = '7d' as const
const DEFAULT_NEW_PLAN_QUANTITY = 10

const ALL_ENCHANTMENTS = getAllEnchantments()
const DAILY_BONUS_OPTIONS = buildDailyBonusOptionList()
const DAILY_BONUS_CATEGORY_OPTIONS = DAILY_BONUS_OPTIONS.filter((option) => option.value !== '')
const DAILY_BONUS_CATEGORY_VALUES = new Set(DAILY_BONUS_CATEGORY_OPTIONS.map((option) => option.value))
const DAILY_BONUS_CATEGORY_LABELS = new Map(DAILY_BONUS_CATEGORY_OPTIONS.map((option) => [option.value, option.label]))
const BUY_PRICE_TYPE_OPTIONS: BuyPriceType[] = ['INSTANT_BUY', 'BUY_ORDER', 'TRADE']
const ARTIFACT_FILTER_OPTIONS: ReadonlyArray<{ value: ArtifactFilter; label: string }> = [
  { value: 'NON_ARTIFACT', label: 'Regular' },
  { value: 'RUNE', label: 'Rune Artifact' },
  { value: 'SOUL', label: 'Soul Artifact' },
  { value: 'RELIC', label: 'Relic Artifact' },
  { value: 'OTHER', label: 'Other Artifact' },
]

const DEFAULT_SETTINGS: AppSettings = {
  search: '',
  tierFilters: [],
  categoryFilter: 'ALL',
  artifactFilters: [],
  enchantmentFilters: [0],
  serverRegion: 'EU',
  hasPremium: true,
  targetCity: 'Black Market',
  dailyBonusA: {
    category: '',
    percent: 10,
  },
  dailyBonusB: {
    category: '',
    percent: 10,
  },
}

const EMPTY_PRICE_BOOK: PriceBook = {
  values: {},
  fetchedAt: null,
  error: null,
}

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

const DECIMAL_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})

const COUNT_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
})

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatSilver(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--'
  }

  return CURRENCY_FORMATTER.format(Math.round(value))
}

function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--'
  }

  return `${DECIMAL_FORMATTER.format(value)}%`
}

function formatCount(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--'
  }

  return COUNT_FORMATTER.format(value)
}

function formatWeight(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--'
  }

  return `${COUNT_FORMATTER.format(value)} kg`
}

function formatPerItem(value: number | null, quantity: number): string {
  if (value === null || Number.isNaN(value) || quantity <= 0) {
    return '--'
  }

  return formatSilver(value / quantity)
}

function parseNumericInput(value: string, fallback: number): number {
  if (value.trim().length === 0) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function compareVariants(a: CraftVariant, b: CraftVariant): number {
  const nameComparison = a.displayName.localeCompare(b.displayName)
  if (nameComparison !== 0) {
    return nameComparison
  }

  return a.enchantment - b.enchantment
}

function buildVariantLabel(variant: CraftVariant): string {
  return `${variant.displayName} [${variant.tierLabel}]`
}

function normalizeSearchCategory(item: CraftItem): string | null {
  const rawCategory = item.craftingCategory.trim().toLowerCase()
  const normalizedItemId = item.itemId.toUpperCase()

  if (DAILY_BONUS_CATEGORY_VALUES.has(rawCategory)) {
    return rawCategory
  }

  if (
    rawCategory === 'cape' ||
    rawCategory === 'capes' ||
    rawCategory.startsWith('accessoires_capes_') ||
    rawCategory.startsWith('tokens_capes_') ||
    normalizedItemId.includes('_CAPE')
  ) {
    return 'cape'
  }

  if (
    rawCategory === 'offhands' ||
    rawCategory === 'shieldtype_shield' ||
    (normalizedItemId.startsWith('T') && normalizedItemId.includes('_OFF_'))
  ) {
    return 'offhand'
  }

  if (
    rawCategory === 'tools' ||
    rawCategory === 'axes' ||
    rawCategory === 'knifes' ||
    rawCategory === 'picks' ||
    rawCategory === 'sickle' ||
    normalizedItemId.includes('_TOOL_')
  ) {
    return 'tools'
  }

  if (normalizedItemId.includes('_ARMOR_CLOTH_')) {
    return 'cloth_armor'
  }

  if (normalizedItemId.includes('_HEAD_CLOTH_')) {
    return 'cloth_helmet'
  }

  if (normalizedItemId.includes('_SHOES_CLOTH_')) {
    return 'cloth_shoes'
  }

  if (normalizedItemId.includes('_ARMOR_LEATHER_')) {
    return 'leather_armor'
  }

  if (normalizedItemId.includes('_HEAD_LEATHER_')) {
    return 'leather_helmet'
  }

  if (normalizedItemId.includes('_SHOES_LEATHER_')) {
    return 'leather_shoes'
  }

  if (normalizedItemId.includes('_ARMOR_PLATE_')) {
    return 'plate_armor'
  }

  if (normalizedItemId.includes('_HEAD_PLATE_')) {
    return 'plate_helmet'
  }

  if (normalizedItemId.includes('_SHOES_PLATE_')) {
    return 'plate_shoes'
  }

  return null
}

function resolveArtifactFilter(item: CraftItem): ArtifactFilter {
  const artifactInput = item.recipe.find((resource) => resource.itemId.toUpperCase().includes('ARTEFACT'))
  if (!artifactInput) {
    return 'NON_ARTIFACT'
  }

  const normalizedArtifactId = artifactInput.itemId.toUpperCase()

  if (normalizedArtifactId.includes('_KEEPER') || normalizedArtifactId.includes('_HERETIC')) {
    return 'RUNE'
  }

  if (normalizedArtifactId.includes('_UNDEAD')) {
    return 'SOUL'
  }

  if (
    normalizedArtifactId.includes('_HELL') ||
    normalizedArtifactId.includes('_MORGANA') ||
    normalizedArtifactId.includes('_DEMON')
  ) {
    return 'RELIC'
  }

  return 'OTHER'
}

function buildCollapsedInfoTitle(result: PlannedCraftResult): string {
  return [
    `Return Rate: ${formatPct(result.returnRate * 100)}`,
    `Output Weight: ${formatWeight(result.baseItem.weight * result.plan.quantity)}`,
    `Market Fee: ${formatSilver(result.marketFee)}`,
    `Transport Fee: ${formatSilver(result.transportFee)}`,
    `Nutrition: ${result.stationNutrition !== null ? DECIMAL_FORMATTER.format(result.stationNutrition) : '--'}`,
    `Estimated Item Value: ${formatSilver(result.itemValuePerCraft)}`,
  ].join('\n')
}

function resolveRowStatus(result: { missingPrices: string[]; avgSoldPerDay30d: number | null; avgPrice30d: number | null }) {
  const historyText =
    result.avgSoldPerDay30d !== null
      ? '30 day volume history is available.'
      : result.avgPrice30d !== null
        ? '30 day price history is available, but sold/day volume is not.'
        : 'Only live spot pricing is available for this sell city.'

  if (result.missingPrices.length > 0) {
    return {
      symbol: '!',
      className: 'row-status-icon missing',
      title: `${result.missingPrices.length} missing price${result.missingPrices.length === 1 ? '' : 's'}. ${historyText}`,
    }
  }

  if (result.avgSoldPerDay30d !== null) {
    return {
      symbol: '●',
      className: 'row-status-icon ready',
      title: `All required prices are present. ${historyText}`,
    }
  }

  if (result.avgPrice30d !== null) {
    return {
      symbol: '◐',
      className: 'row-status-icon partial',
      title: `All required prices are present. ${historyText}`,
    }
  }

  return {
    symbol: '○',
    className: 'row-status-icon spot',
    title: `All required prices are present. ${historyText}`,
  }
}

function toggleValueInList<T extends string | number>(values: T[], value: T): T[] {
  if (values.includes(value)) {
    return values.filter((entry) => entry !== value)
  }

  return [...values, value].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
  )
}

function getSellTargetOptions(cityNames: string[]): SellTarget[] {
  return ['Black Market', 'Caerleon', ...(cityNames as Array<Exclude<SellTarget, 'Black Market' | 'Caerleon'>>)]
}

function normalizeSettings(rawSettings: AppSettings, gameData: GameData | null): AppSettings {
  const allowedEnchantments = new Set<number>(ALL_ENCHANTMENTS)
  const validSellTargets = new Set<SellTarget>(gameData ? getSellTargetOptions(gameData.cityNames) : ['Black Market', 'Caerleon'])
  const validTiers = new Set(
    gameData
      ? gameData.items.map((item) => item.tier).filter((tier): tier is number => tier !== null)
      : [],
  )

  const tierFilters = Array.isArray(rawSettings.tierFilters)
    ? rawSettings.tierFilters.filter((tier): tier is number => typeof tier === 'number' && validTiers.has(tier))
    : []

  const enchantmentFilters: EnchantmentLevel[] = Array.isArray(rawSettings.enchantmentFilters)
    ? rawSettings.enchantmentFilters.filter(
        (level): level is EnchantmentLevel => typeof level === 'number' && allowedEnchantments.has(level),
      )
    : [0]

  const categoryFilter =
    typeof rawSettings.categoryFilter === 'string' &&
    (rawSettings.categoryFilter === 'ALL' || DAILY_BONUS_CATEGORY_VALUES.has(rawSettings.categoryFilter))
      ? rawSettings.categoryFilter
      : 'ALL'

  const validArtifactValues = new Set(ARTIFACT_FILTER_OPTIONS.map((option) => option.value))
  const artifactFilters = Array.isArray(rawSettings.artifactFilters)
    ? rawSettings.artifactFilters.filter(
        (value): value is ArtifactFilter => typeof value === 'string' && validArtifactValues.has(value as ArtifactFilter),
      )
    : typeof (rawSettings as AppSettings & { artifactFilter?: unknown }).artifactFilter === 'string' &&
        validArtifactValues.has((rawSettings as AppSettings & { artifactFilter?: ArtifactFilter }).artifactFilter as ArtifactFilter)
      ? [((rawSettings as AppSettings & { artifactFilter?: ArtifactFilter }).artifactFilter as ArtifactFilter)]
      : []

  const serverRegion =
    rawSettings.serverRegion === 'EU' || rawSettings.serverRegion === 'US' || rawSettings.serverRegion === 'ASIA'
      ? rawSettings.serverRegion
      : 'EU'

  const targetCity = validSellTargets.has(rawSettings.targetCity) ? rawSettings.targetCity : 'Black Market'
  const validDailyBonusValues = new Set(DAILY_BONUS_OPTIONS.map((option) => option.value))

  const dailyBonusA =
    validDailyBonusValues.has(rawSettings.dailyBonusA?.category ?? '')
      ? rawSettings.dailyBonusA
      : DEFAULT_SETTINGS.dailyBonusA

  const dailyBonusB =
    validDailyBonusValues.has(rawSettings.dailyBonusB?.category ?? '')
      ? rawSettings.dailyBonusB
      : DEFAULT_SETTINGS.dailyBonusB

  return {
    search: typeof rawSettings.search === 'string' ? rawSettings.search : '',
    tierFilters,
    categoryFilter,
    artifactFilters,
    enchantmentFilters: enchantmentFilters.length > 0 ? enchantmentFilters : [0],
    serverRegion,
    hasPremium: typeof rawSettings.hasPremium === 'boolean' ? rawSettings.hasPremium : true,
    targetCity,
    dailyBonusA: {
      category: dailyBonusA?.category ?? '',
      percent: dailyBonusA?.percent === 20 ? 20 : 10,
    },
    dailyBonusB: {
      category: dailyBonusB?.category ?? '',
      percent: dailyBonusB?.percent === 20 ? 20 : 10,
    },
  }
}

function buildDefaultMaterialCityMap(
  baseItem: CraftItem,
  craftCity: string,
  categoryPresetCity: Record<string, string>,
): Partial<Record<MaterialGroup, string>> {
  return Object.fromEntries(
    getMaterialGroupsForItem(baseItem).map((group) => [group, getDefaultMaterialCityForGroup(group, craftCity, categoryPresetCity)]),
  ) as Partial<Record<MaterialGroup, string>>
}

function buildDefaultPlan(variant: CraftVariant, baseItem: CraftItem, gameData: GameData, targetCity: SellTarget): SelectedCraftPlan {
  const craftCity = getDefaultCraftCity(baseItem, gameData.cityProfiles, gameData.categoryPresetCity)

  return {
    variantId: variant.variantId,
    baseItemId: variant.baseItemId,
    enchantment: variant.enchantment,
    quantity: DEFAULT_NEW_PLAN_QUANTITY,
    craftCity,
    sellCity: targetCity,
    buyPriceType: 'INSTANT_BUY',
    materialCityByGroup: buildDefaultMaterialCityMap(baseItem, craftCity, gameData.categoryPresetCity),
    artifactBuyCity: 'AUTO',
  }
}

function normalizeSelectedPlan(rawPlan: unknown, gameData: GameData, targetCity: SellTarget): SelectedCraftPlan | null {
  if (!isRecord(rawPlan)) {
    return null
  }

  const itemsById = new Map(gameData.items.map((item) => [item.itemId, item]))
  const baseItemId = typeof rawPlan.baseItemId === 'string' ? rawPlan.baseItemId : ''
  const baseItem = itemsById.get(baseItemId)
  if (!baseItem) {
    return null
  }

  const requestedEnchantment = typeof rawPlan.enchantment === 'number' ? rawPlan.enchantment : 0
  const enchantment = baseItem.availableEnchantments.includes(requestedEnchantment as EnchantmentLevel)
    ? (requestedEnchantment as EnchantmentLevel)
    : baseItem.availableEnchantments[0]

  const variant = buildCraftVariant(baseItem, enchantment, new Set(gameData.knownMarketItemIds))
  if (!variant) {
    return null
  }

  const craftCityOptions = new Set(gameData.cityNames)
  const sellTargetOptions = new Set(getSellTargetOptions(gameData.cityNames))
  const marketCityOptions = new Set(['Caerleon', ...gameData.cityNames])

  const defaultCraftCity = getDefaultCraftCity(baseItem, gameData.cityProfiles, gameData.categoryPresetCity)
  const defaultMaterialCityByGroup = buildDefaultMaterialCityMap(baseItem, defaultCraftCity, gameData.categoryPresetCity)

  const legacyManualCraftCity = typeof rawPlan.manualCraftCity === 'string' ? rawPlan.manualCraftCity : ''
  const craftCity =
    typeof rawPlan.craftCity === 'string' && craftCityOptions.has(rawPlan.craftCity)
      ? rawPlan.craftCity
      : rawPlan.craftCityMode === 'MANUAL' && craftCityOptions.has(legacyManualCraftCity)
        ? legacyManualCraftCity
        : defaultCraftCity

  const materialCityByGroup: Partial<Record<MaterialGroup, string>> = {
    ...buildDefaultMaterialCityMap(baseItem, craftCity, gameData.categoryPresetCity),
  }

  const rawMaterialMap = rawPlan.materialCityByGroup
  if (isRecord(rawMaterialMap)) {
    for (const group of getMaterialGroupsForItem(baseItem)) {
      const value = rawMaterialMap[group]
      if (typeof value === 'string' && marketCityOptions.has(value)) {
        materialCityByGroup[group] = value
      }
    }
  } else {
    const legacyManualMaterialCity = typeof rawPlan.manualMaterialCity === 'string' ? rawPlan.manualMaterialCity : ''
    if (rawPlan.materialBuyMode === 'MANUAL' && marketCityOptions.has(legacyManualMaterialCity)) {
      for (const group of getMaterialGroupsForItem(baseItem)) {
        materialCityByGroup[group] = legacyManualMaterialCity
      }
    } else {
      Object.assign(materialCityByGroup, defaultMaterialCityByGroup)
    }
  }

  const rawBuyPriceType = rawPlan.buyPriceType
  const legacyMaterialPricingMode = rawPlan.materialPricingMode
  let buyPriceType: BuyPriceType = 'INSTANT_BUY'

  if (rawBuyPriceType === 'TRADE' || rawBuyPriceType === 'INSTANT_BUY' || rawBuyPriceType === 'BUY_ORDER') {
    buyPriceType = rawBuyPriceType
  } else if (legacyMaterialPricingMode === 'TRADE_DISCOUNT') {
    buyPriceType = 'TRADE'
  } else if (legacyMaterialPricingMode === 'BUY_ORDER') {
    buyPriceType = 'BUY_ORDER'
  }

  const artifactBuyCity =
    typeof rawPlan.artifactBuyCity === 'string' && (rawPlan.artifactBuyCity === 'AUTO' || marketCityOptions.has(rawPlan.artifactBuyCity))
      ? rawPlan.artifactBuyCity
      : 'AUTO'

  const sellCity =
    typeof rawPlan.sellCity === 'string' && sellTargetOptions.has(rawPlan.sellCity as SellTarget)
      ? (rawPlan.sellCity as SellTarget)
      : typeof rawPlan.sellTarget === 'string' && sellTargetOptions.has(rawPlan.sellTarget as SellTarget)
        ? (rawPlan.sellTarget as SellTarget)
        : targetCity

  return {
    variantId: variant.variantId,
    baseItemId: baseItem.itemId,
    enchantment,
    quantity:
      typeof rawPlan.quantity === 'number' && Number.isFinite(rawPlan.quantity)
        ? Math.max(1, Math.round(rawPlan.quantity))
        : DEFAULT_NEW_PLAN_QUANTITY,
    craftCity,
    sellCity,
    buyPriceType,
    materialCityByGroup,
    artifactBuyCity,
  }
}

function App() {
  const [settings, setSettings] = useLocalStorageState<AppSettings>(SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS)
  const [selectedPlans, setSelectedPlans] = useLocalStorageState<SelectedCraftPlan[]>(PLANS_STORAGE_KEY, [])

  const [gameData, setGameData] = useState<GameData | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [dataLoading, setDataLoading] = useState(true)

  const [priceBook, setPriceBook] = useState<PriceBook>(EMPTY_PRICE_BOOK)
  const [priceWarning, setPriceWarning] = useState<string | null>(null)
  const [priceLoading, setPriceLoading] = useState(false)
  const [expandedRows, setExpandedRows] = useState<string[]>([])

  const requestAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    document.title = 'Black Market Profit Calculator'
  }, [])

  useEffect(() => {
    let isMounted = true

    const bootstrap = async () => {
      setDataLoading(true)
      setDataError(null)

      try {
        const data = await loadGameData()
        if (!isMounted) {
          return
        }

        setGameData(data)
      } catch (error) {
        if (!isMounted) {
          return
        }

        const message = error instanceof Error ? error.message : 'Failed to load local Albion data files.'
        setDataError(message)
      } finally {
        if (isMounted) {
          setDataLoading(false)
        }
      }
    }

    void bootstrap()

    return () => {
      isMounted = false
      requestAbortRef.current?.abort()
    }
  }, [])

  const safeSettings = useMemo(() => normalizeSettings(settings, gameData), [settings, gameData])

  useEffect(() => {
    const normalized = normalizeSettings(settings, gameData)
    if (JSON.stringify(normalized) !== JSON.stringify(settings)) {
      setSettings(normalized)
    }
  }, [gameData, setSettings, settings])

  const knownMarketItemIdSet = useMemo(() => new Set(gameData?.knownMarketItemIds ?? []), [gameData])

  const itemsById = useMemo(() => {
    if (!gameData) {
      return new Map<string, CraftItem>()
    }

    return new Map(gameData.items.map((item) => [item.itemId, item]))
  }, [gameData])

  useEffect(() => {
    if (!gameData) {
      return
    }

    setSelectedPlans((previous) => {
      const sanitized: SelectedCraftPlan[] = []
      const seenVariantIds = new Set<string>()

      for (const rawPlan of previous) {
        const normalized = normalizeSelectedPlan(rawPlan, gameData, safeSettings.targetCity)
        if (!normalized || seenVariantIds.has(normalized.variantId)) {
          continue
        }

        seenVariantIds.add(normalized.variantId)
        sanitized.push(normalized)
      }

      return JSON.stringify(sanitized) !== JSON.stringify(previous) ? sanitized : previous
    })
  }, [gameData, safeSettings.targetCity, setSelectedPlans])

  useEffect(() => {
    setExpandedRows((previous) =>
      previous.filter((variantId) => selectedPlans.some((plan) => plan.variantId === variantId)),
    )
  }, [selectedPlans])

  const sellTargetOptions = useMemo(
    () => (gameData ? getSellTargetOptions(gameData.cityNames) : ['Black Market', 'Caerleon']),
    [gameData],
  )

  const marketCityOptions = useMemo(() => (gameData ? ['Caerleon', ...gameData.cityNames] : ['Caerleon']), [gameData])

  const searchCategoryByItemId = useMemo(() => {
    if (!gameData) {
      return new Map<string, string | null>()
    }

    return new Map(gameData.items.map((item) => [item.itemId, normalizeSearchCategory(item)]))
  }, [gameData])

  const artifactFilterByItemId = useMemo(() => {
    if (!gameData) {
      return new Map<string, ArtifactFilter>()
    }

    return new Map(gameData.items.map((item) => [item.itemId, resolveArtifactFilter(item)]))
  }, [gameData])

  const categoryOptions = useMemo(() => {
    if (!gameData) {
      return []
    }

    const availableCategories = new Set(
      [...searchCategoryByItemId.values()].filter((value): value is string => typeof value === 'string' && value.length > 0),
    )

    return DAILY_BONUS_CATEGORY_OPTIONS.filter((option) => availableCategories.has(option.value)).map((option) => ({
      value: option.value,
      label: DAILY_BONUS_CATEGORY_LABELS.get(option.value) ?? option.label,
    }))
  }, [gameData, searchCategoryByItemId])

  const tierOptions = useMemo(() => {
    if (!gameData) {
      return []
    }

    return [...new Set(gameData.items.map((item) => item.tier).filter((tier): tier is number => tier !== null))].sort(
      (a, b) => a - b,
    )
  }, [gameData])

  const filteredBaseItems = useMemo(() => {
    if (!gameData) {
      return []
    }

    const normalizedSearch = safeSettings.search.trim().toLowerCase()

    return gameData.items.filter((item) => {
      const normalizedCategory = searchCategoryByItemId.get(item.itemId) ?? null
      const artifactFilter = artifactFilterByItemId.get(item.itemId) ?? 'NON_ARTIFACT'

      if (
        safeSettings.tierFilters.length > 0 &&
        (item.tier === null || !safeSettings.tierFilters.includes(item.tier))
      ) {
        return false
      }

      if (safeSettings.categoryFilter !== 'ALL' && normalizedCategory !== safeSettings.categoryFilter) {
        return false
      }

      if (safeSettings.artifactFilters.length > 0 && !safeSettings.artifactFilters.includes(artifactFilter)) {
        return false
      }

      if (normalizedSearch.length > 0) {
        const matchName = item.displayName.toLowerCase().includes(normalizedSearch)
        const matchId = item.itemId.toLowerCase().includes(normalizedSearch)
        if (!matchName && !matchId) {
          return false
        }
      }

      return true
    })
  }, [
    artifactFilterByItemId,
    gameData,
    safeSettings.artifactFilters,
    safeSettings.categoryFilter,
    safeSettings.search,
    safeSettings.tierFilters,
    searchCategoryByItemId,
  ])

  const pickerVariants = useMemo(() => {
    const variants: CraftVariant[] = []

    for (const item of filteredBaseItems) {
      const enchantments =
        safeSettings.enchantmentFilters.length > 0
          ? item.availableEnchantments.filter((level) => safeSettings.enchantmentFilters.includes(level))
          : item.availableEnchantments

      for (const enchantment of enchantments) {
        const variant = buildCraftVariant(item, enchantment, knownMarketItemIdSet)
        if (variant) {
          variants.push(variant)
        }
      }
    }

    variants.sort(compareVariants)
    return variants
  }, [filteredBaseItems, knownMarketItemIdSet, safeSettings.enchantmentFilters])

  const selectedPlansById = useMemo(
    () => new Map(selectedPlans.map((plan) => [plan.variantId, plan])),
    [selectedPlans],
  )

  const requiredItemIds = useMemo(
    () => collectRequiredPriceItemIds({ plans: selectedPlans, itemsById, knownMarketItemIds: knownMarketItemIdSet }),
    [selectedPlans, itemsById, knownMarketItemIdSet],
  )

  const requiredFingerprint = useMemo(() => requiredItemIds.join('|'), [requiredItemIds])

  const pricingLocations = useMemo(() => {
    if (!gameData) {
      return []
    }

    return ['Black Market', 'Caerleon', ...gameData.cityNames]
  }, [gameData])

  const refreshPrices = useCallback(async () => {
    if (requiredItemIds.length === 0 || pricingLocations.length === 0) {
      setPriceBook(EMPTY_PRICE_BOOK)
      setPriceWarning(null)
      return
    }

    requestAbortRef.current?.abort()
    const controller = new AbortController()
    requestAbortRef.current = controller

    setPriceLoading(true)
    setPriceWarning(null)

    try {
      const result = await fetchPriceBook(
        requiredItemIds,
        pricingLocations,
        safeSettings.serverRegion,
        ESTIMATE_WINDOW,
        controller.signal,
      )

      setPriceBook({
        values: result.values,
        fetchedAt: new Date().toISOString(),
        error: null,
      })
      setPriceWarning(result.warning)
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }

      const message = error instanceof Error ? error.message : 'Unable to fetch market prices.'
      setPriceBook((previous) => ({
        ...previous,
        error: message,
      }))
    } finally {
      if (!controller.signal.aborted) {
        setPriceLoading(false)
      }
    }
  }, [pricingLocations, requiredItemIds, safeSettings.serverRegion])

  useEffect(() => {
    if (requiredItemIds.length === 0) {
      setPriceBook(EMPTY_PRICE_BOOK)
      setPriceWarning(null)
      return
    }

    const timer = setTimeout(() => {
      void refreshPrices()
    }, 250)

    return () => {
      clearTimeout(timer)
    }
  }, [refreshPrices, requiredFingerprint, requiredItemIds.length, safeSettings.serverRegion])

  const plannedView = useMemo(() => {
    if (!gameData) {
      return {
        results: [],
        summary: {
          plannedCrafts: 0,
          readyCrafts: 0,
          totalCost: 0,
          totalRevenue: 0,
          totalMarketFee: 0,
          totalProfit: 0,
        },
      }
    }

    return calculatePlannedCrafts({
      plans: selectedPlans,
      itemsById,
      settings: safeSettings,
      priceBook,
      cityProfiles: gameData.cityProfiles,
      categoryPresetCity: gameData.categoryPresetCity,
      knownMarketItemIds: knownMarketItemIdSet,
    })
  }, [gameData, selectedPlans, itemsById, safeSettings, priceBook, knownMarketItemIdSet])

  const breakdown = useMemo(() => {
    const outputs = new Map<
      string,
      { label: string; sellCity: string; quantity: number; revenue: number; weight: number }
    >()
    const inputs = new Map<
      string,
      {
        displayName: string
        marketItemId: string
        typeLabel: string
        buyCity: string
        quantity: number
        recipeQuantity: number
        returnedQuantity: number
        unitPrice: number
        totalCost: number
      }
    >()

    for (const result of plannedView.results) {
      const outputKey = `${result.variant.marketItemId}|${result.sellCity}`
      const existingOutput = outputs.get(outputKey) ?? {
        label: buildVariantLabel(result.variant),
        sellCity: result.sellCity,
        quantity: 0,
        revenue: 0,
        weight: 0,
      }

      existingOutput.quantity += result.plan.quantity
      existingOutput.revenue += result.revenue ?? 0
      existingOutput.weight += result.baseItem.weight * result.plan.quantity
      outputs.set(outputKey, existingOutput)

      for (const line of result.materialLines) {
        const inputKey = `${line.marketItemId}|${line.buyCity}`
        const existingInput = inputs.get(inputKey) ?? {
          displayName: line.displayName,
          marketItemId: line.marketItemId,
          typeLabel: line.isArtifact ? 'Artifact' : MATERIAL_GROUP_LABELS[line.materialGroup ?? 'other'],
          buyCity: line.buyCity,
          quantity: 0,
          recipeQuantity: 0,
          returnedQuantity: 0,
          unitPrice: line.unitPrice ?? 0,
          totalCost: 0,
        }

        existingInput.quantity += line.quantity
        existingInput.recipeQuantity += line.baseQuantity
        existingInput.returnedQuantity += line.returnedQuantity
        existingInput.totalCost += line.totalCost ?? 0
        inputs.set(inputKey, existingInput)
      }
    }

    return {
      outputs: [...outputs.values()].sort((a, b) => a.label.localeCompare(b.label)),
      inputs: [...inputs.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }
  }, [plannedView.results])

  const bulkBuyPriceType = useMemo(() => {
    if (selectedPlans.length === 0) {
      return 'INSTANT_BUY'
    }

    const first = selectedPlans[0].buyPriceType
    return selectedPlans.every((plan) => plan.buyPriceType === first) ? first : 'MIXED'
  }, [selectedPlans])

  const toggleVariantSelection = (variant: CraftVariant) => {
    setSelectedPlans((previous) => {
      const existing = previous.find((plan) => plan.variantId === variant.variantId)
      if (existing) {
        return previous.filter((plan) => plan.variantId !== variant.variantId)
      }

      if (!gameData) {
        return previous
      }

      const baseItem = itemsById.get(variant.baseItemId)
      if (!baseItem) {
        return previous
      }

      return [...previous, buildDefaultPlan(variant, baseItem, gameData, safeSettings.targetCity)]
    })
  }

  const removePlan = (variantId: string) => {
    setExpandedRows((previous) => previous.filter((entry) => entry !== variantId))
    setSelectedPlans((previous) => previous.filter((plan) => plan.variantId !== variantId))
  }

  const updatePlan = (variantId: string, patch: Partial<SelectedCraftPlan>) => {
    setSelectedPlans((previous) =>
      previous.map((plan) => {
        if (plan.variantId !== variantId) {
          return plan
        }

        const nextPlan = { ...plan, ...patch }
        if (patch.craftCity) {
          const baseItem = itemsById.get(plan.baseItemId)
          if (baseItem && !patch.materialCityByGroup) {
            const nextMaterialCityByGroup = { ...nextPlan.materialCityByGroup }
            for (const group of getMaterialGroupsForItem(baseItem)) {
              if (!nextMaterialCityByGroup[group]) {
                nextMaterialCityByGroup[group] = getDefaultMaterialCityForGroup(
                  group,
                  patch.craftCity,
                  gameData?.categoryPresetCity ?? {},
                )
              }
            }
            nextPlan.materialCityByGroup = nextMaterialCityByGroup
          }
        }

        return nextPlan
      }),
    )
  }

  const updateSettings = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((previous) => ({
      ...previous,
      [key]: value,
    }))
  }

  const applyBuyPriceTypeToAll = (buyPriceType: BuyPriceType) => {
    setSelectedPlans((previous) => previous.map((plan) => ({ ...plan, buyPriceType })))
  }

  const toggleExpandedRow = (variantId: string) => {
    setExpandedRows((previous) =>
      previous.includes(variantId)
        ? previous.filter((entry) => entry !== variantId)
        : [...previous, variantId],
    )
  }

  if (dataLoading) {
    return (
      <div className="loading-screen">
        <p>Loading Albion dataset...</p>
      </div>
    )
  }

  if (dataError || !gameData) {
    return (
      <div className="loading-screen error">
        <h1>Data Load Failed</h1>
        <p>{dataError ?? 'Unknown error.'}</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="top-header">
        <div>
          <p className="eyebrow">Albion Online</p>
          <h1>Black Market Profit Calculator</h1>
          <p className="subtitle">
            Minimal global settings, per-craft routing, and Black Market focused crafting plans.
          </p>
        </div>
        <button type="button" className="refresh-btn" onClick={() => void refreshPrices()} disabled={priceLoading}>
          {priceLoading ? 'Refreshing prices...' : 'Refresh Prices'}
        </button>
      </header>

      <section className="panel picker-panel">
        <div className="panel-title-row">
          <h2>Select Items</h2>
          <p>
            Showing {pickerVariants.length} variants ({filteredBaseItems.length} base items)
          </p>
        </div>

        <div className="picker-filters">
          <label>
            Search
            <input
              type="text"
              placeholder="e.g. Great Nature or Druidic"
              value={safeSettings.search}
              onChange={(event) => updateSettings('search', event.target.value)}
            />
          </label>

          <div className="filter-group">
            <span>Tier</span>
            <div className="toggle-row">
              <button
                type="button"
                className={safeSettings.tierFilters.length === 0 ? 'toggle-chip active' : 'toggle-chip'}
                onClick={() => updateSettings('tierFilters', [])}
              >
                All
              </button>
              {tierOptions.map((tier) => (
                <button
                  type="button"
                  key={tier}
                  className={safeSettings.tierFilters.includes(tier) ? 'toggle-chip active' : 'toggle-chip'}
                  onClick={() => updateSettings('tierFilters', toggleValueInList(safeSettings.tierFilters, tier))}
                >
                  T{tier}
                </button>
              ))}
            </div>
          </div>

          <label>
            Category
            <select
              value={safeSettings.categoryFilter}
              onChange={(event) => updateSettings('categoryFilter', event.target.value)}
            >
              <option value="ALL">All</option>
              {categoryOptions.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </select>
          </label>

          <div className="filter-group">
            <span>Artifact</span>
            <div className="toggle-row">
              <button
                type="button"
                className={safeSettings.artifactFilters.length === 0 ? 'toggle-chip active' : 'toggle-chip'}
                onClick={() => updateSettings('artifactFilters', [])}
              >
                All
              </button>
              {ARTIFACT_FILTER_OPTIONS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={safeSettings.artifactFilters.includes(option.value) ? 'toggle-chip active' : 'toggle-chip'}
                  onClick={() =>
                    updateSettings('artifactFilters', toggleValueInList(safeSettings.artifactFilters, option.value))
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <span>Enchantment</span>
            <div className="toggle-row">
              <button
                type="button"
                className={safeSettings.enchantmentFilters.length === 0 ? 'toggle-chip active' : 'toggle-chip'}
                onClick={() => updateSettings('enchantmentFilters', [])}
              >
                All
              </button>
              {ALL_ENCHANTMENTS.map((enchantment) => (
                <button
                  type="button"
                  key={enchantment}
                  className={
                    safeSettings.enchantmentFilters.includes(enchantment) ? 'toggle-chip active' : 'toggle-chip'
                  }
                  onClick={() =>
                    updateSettings(
                      'enchantmentFilters',
                      toggleValueInList(safeSettings.enchantmentFilters, enchantment as EnchantmentLevel),
                    )
                  }
                >
                  .{enchantment}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="picker-results">
          {pickerVariants.map((variant) => (
            <button
              type="button"
              key={variant.variantId}
              onClick={() => toggleVariantSelection(variant)}
              className={selectedPlansById.has(variant.variantId) ? 'selected' : ''}
            >
              <span>{buildVariantLabel(variant)}</span>
              <strong>{selectedPlansById.has(variant.variantId) ? 'Remove' : 'Add'}</strong>
            </button>
          ))}
        </div>

        <div className="picker-footer-note">
          <span>{selectedPlans.length} crafts selected</span>
          <span>Added items appear in the planner table below.</span>
        </div>
      </section>

      <section className="panel settings-panel global-bar-panel">
        <div className="panel-title-row">
          <h2>Global Settings</h2>
          <p>
            {priceBook.fetchedAt
              ? `Last update: ${new Date(priceBook.fetchedAt).toLocaleString()} · ${ESTIMATE_WINDOW} estimates`
              : `No price snapshot yet · ${ESTIMATE_WINDOW} estimates`}
          </p>
        </div>

        <div className="global-bar-grid">
          <label>
            Server Region
            <select
              value={safeSettings.serverRegion}
              onChange={(event) => updateSettings('serverRegion', event.target.value as ServerRegion)}
            >
              <option value="EU">Europe</option>
              <option value="US">Americas</option>
              <option value="ASIA">Asia</option>
            </select>
          </label>

          <label>
            Premium Status
            <select
              value={safeSettings.hasPremium ? 'premium' : 'standard'}
              onChange={(event) => updateSettings('hasPremium', event.target.value === 'premium')}
            >
              <option value="premium">Premium</option>
              <option value="standard">No Premium</option>
            </select>
          </label>

          <label>
            Target City
            <select
              value={safeSettings.targetCity}
              onChange={(event) => updateSettings('targetCity', event.target.value as SellTarget)}
            >
              {sellTargetOptions.map((target) => (
                <option key={target} value={target}>
                  {target}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="daily-bonus-grid">
          <label>
            Daily Bonus A
            <select
              value={safeSettings.dailyBonusA.category}
              onChange={(event) =>
                updateSettings('dailyBonusA', {
                  ...safeSettings.dailyBonusA,
                  category: event.target.value,
                })
              }
            >
              {DAILY_BONUS_OPTIONS.map((option) => (
                <option key={`bonus-a-${option.value || 'none'}`} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Bonus A %
            <select
              value={safeSettings.dailyBonusA.percent}
              onChange={(event) =>
                updateSettings('dailyBonusA', {
                  ...safeSettings.dailyBonusA,
                  percent: Number(event.target.value) as 10 | 20,
                })
              }
            >
              <option value={10}>10%</option>
              <option value={20}>20%</option>
            </select>
          </label>

          <label>
            Daily Bonus B
            <select
              value={safeSettings.dailyBonusB.category}
              onChange={(event) =>
                updateSettings('dailyBonusB', {
                  ...safeSettings.dailyBonusB,
                  category: event.target.value,
                })
              }
            >
              {DAILY_BONUS_OPTIONS.map((option) => (
                <option key={`bonus-b-${option.value || 'none'}`} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Bonus B %
            <select
              value={safeSettings.dailyBonusB.percent}
              onChange={(event) =>
                updateSettings('dailyBonusB', {
                  ...safeSettings.dailyBonusB,
                  percent: Number(event.target.value) as 10 | 20,
                })
              }
            >
              <option value={10}>10%</option>
              <option value={20}>20%</option>
            </select>
          </label>
        </div>
      </section>

      <section className="summary-cards">
        <article className="summary-card">
          <h4>Planned Crafts</h4>
          <p>{plannedView.summary.plannedCrafts}</p>
        </article>
        <article className="summary-card">
          <h4>Ready Prices</h4>
          <p>{plannedView.summary.readyCrafts}</p>
        </article>
        <article className="summary-card">
          <h4>Total Cost</h4>
          <p>{formatSilver(plannedView.summary.totalCost)}</p>
        </article>
        <article className="summary-card">
          <h4>Total Revenue</h4>
          <p>{formatSilver(plannedView.summary.totalRevenue)}</p>
        </article>
        <article className={`summary-card ${plannedView.summary.totalProfit >= 0 ? 'profit' : 'loss'}`}>
          <h4>Total Profit</h4>
          <p>{formatSilver(plannedView.summary.totalProfit)}</p>
        </article>
      </section>

      {priceBook.error && <p className="banner error">{priceBook.error}</p>}
      {priceWarning && <p className="banner warning">{priceWarning}</p>}

      <section className="panel table-panel planner-panel">
        <div className="panel-title-row planner-panel-header">
          <div>
            <h2>Craft Planner</h2>
            <p>Black Market outputs first, routing and materials on demand.</p>
          </div>

          <div className="planner-panel-actions">
            <label className="planner-inline-control">
              Apply Buy Type To All
              <select
                value={bulkBuyPriceType}
                onChange={(event) => applyBuyPriceTypeToAll(event.target.value as BuyPriceType)}
                disabled={selectedPlans.length === 0}
              >
                <option value="MIXED" disabled>
                  Mixed
                </option>
                {BUY_PRICE_TYPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {BUY_PRICE_TYPE_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setExpandedRows([])
                setSelectedPlans([])
              }}
              disabled={selectedPlans.length === 0}
            >
              Clear All
            </button>
          </div>
        </div>

        {plannedView.results.length === 0 ? (
          <p className="muted">Select items above to build a craft plan.</p>
        ) : (
          <div className="table-wrap planner-table-wrap">
            <table className="planner-table">
              <thead>
                <tr>
                  <th />
                  <th>Craft</th>
                  <th>Qty</th>
                  <th>Craft</th>
                  <th>Sell</th>
                  <th>Buy</th>
                  <th>Sold/Day</th>
                  <th>Unit Price</th>
                  <th>Total Cost</th>
                  <th>Profit/Item</th>
                  <th>Total Profit</th>
                  <th>Profit %</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plannedView.results.map((result) => {
                  const materialGroups = getMaterialGroupsForItem(result.baseItem)
                  const hasArtifacts = hasArtifactInputs(result.baseItem)
                  const isExpanded = expandedRows.includes(result.plan.variantId)
                  const rowStatus = resolveRowStatus(result)
                  const infoTitle = buildCollapsedInfoTitle(result)
                  const displayCategory = searchCategoryByItemId.get(result.baseItem.itemId)

                  return (
                    <Fragment key={result.plan.variantId}>
                      <tr
                        className={`planner-summary-row ${(result.netProfit ?? 0) >= 0 ? 'profit-row' : 'loss-row'} ${
                          isExpanded ? 'expanded' : ''
                        }`}
                      >
                        <td>
                          <button
                            type="button"
                            className={`row-toggle ${isExpanded ? 'expanded' : ''}`}
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? 'Collapse craft details' : 'Expand craft details'}
                            onClick={() => toggleExpandedRow(result.plan.variantId)}
                          >
                            <span>▸</span>
                          </button>
                        </td>
                        <td>
                          <div className="item-cell">
                            <div className="item-cell-header">
                              <strong>{buildVariantLabel(result.variant)}</strong>
                              <div className="item-cell-actions">
                                <button
                                  type="button"
                                  className="info-icon-btn"
                                  title={infoTitle}
                                  aria-label={`Info for ${buildVariantLabel(result.variant)}`}
                                >
                                  i
                                </button>
                                <span className={rowStatus.className} title={rowStatus.title} aria-label={rowStatus.title}>
                                  {rowStatus.symbol}
                                </span>
                              </div>
                            </div>
                            <span>
                              {displayCategory
                                ? (DAILY_BONUS_CATEGORY_LABELS.get(displayCategory) ?? displayCategory)
                                : result.baseItem.craftingCategory}
                            </span>
                          </div>
                        </td>
                        <td>
                          <input
                            className="qty-input qty-input-inline"
                            type="number"
                            min={1}
                            step={1}
                            value={result.plan.quantity}
                            onChange={(event) =>
                              updatePlan(result.plan.variantId, {
                                quantity: Math.max(1, parseNumericInput(event.target.value, result.plan.quantity)),
                              })
                            }
                          />
                        </td>
                        <td>{result.craftCity}</td>
                        <td>{result.sellCity}</td>
                        <td>{BUY_PRICE_TYPE_LABELS[result.plan.buyPriceType]}</td>
                        <td
                          title={
                            result.avgSoldPerDay30d === null
                              ? 'No usable 30 day market history for this item in the selected sell city.'
                              : 'Average amount sold per day over the last 30 days.'
                          }
                        >
                          {formatCount(result.avgSoldPerDay30d)}
                        </td>
                        <td>{formatSilver(result.sellPriceUnit)}</td>
                        <td>{formatSilver(result.totalCost)}</td>
                        <td>{formatPerItem(result.netProfit, result.plan.quantity)}</td>
                        <td>{formatSilver(result.netProfit)}</td>
                        <td>{formatPct(result.marginPct)}</td>
                        <td>
                          <button type="button" className="row-remove" onClick={() => removePlan(result.plan.variantId)}>
                            Remove
                          </button>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="planner-expand-row">
                          <td colSpan={13}>
                            <div className="planner-expand-inner">
                              <div className="detail-metrics compact-metrics summary-chip-grid">
                                <span>Unit Price: {formatSilver(result.sellPriceUnit)}</span>
                                <span>Material Cost: {formatSilver(result.materialEffectiveCost)}</span>
                                <span>Revenue: {formatSilver(result.revenue)}</span>
                                <span>Profit/Item: {formatPerItem(result.netProfit, result.plan.quantity)}</span>
                                <span>Profit %: {formatPct(result.marginPct)}</span>
                                <span>Sold/Day: {formatCount(result.avgSoldPerDay30d)}</span>
                              </div>

                              <div className="per-craft-options primary-grid">
                                <label>
                                  Quantity
                                  <input
                                    type="number"
                                    min={1}
                                    step={1}
                                    value={result.plan.quantity}
                                    onChange={(event) =>
                                      updatePlan(result.plan.variantId, {
                                        quantity: Math.max(1, parseNumericInput(event.target.value, result.plan.quantity)),
                                      })
                                    }
                                  />
                                </label>

                                <label>
                                  Craft City
                                  <select
                                    value={result.plan.craftCity}
                                    onChange={(event) => updatePlan(result.plan.variantId, { craftCity: event.target.value })}
                                  >
                                    {gameData.cityNames.map((cityName) => (
                                      <option key={cityName} value={cityName}>
                                        {cityName}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                <label>
                                  Sell City
                                  <select
                                    value={result.plan.sellCity}
                                    onChange={(event) =>
                                      updatePlan(result.plan.variantId, { sellCity: event.target.value as SellTarget })
                                    }
                                  >
                                    {sellTargetOptions.map((target) => (
                                      <option key={target} value={target}>
                                        {target}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                <label>
                                  Buy Price Type
                                  <select
                                    value={result.plan.buyPriceType}
                                    onChange={(event) =>
                                      updatePlan(result.plan.variantId, { buyPriceType: event.target.value as BuyPriceType })
                                    }
                                  >
                                    {BUY_PRICE_TYPE_OPTIONS.map((option) => (
                                      <option key={option} value={option}>
                                        {BUY_PRICE_TYPE_LABELS[option]}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>

                              <div className="per-craft-options material-grid">
                                {materialGroups.map((group) => (
                                  <label key={`${result.plan.variantId}-${group}`}>
                                    {MATERIAL_GROUP_LABELS[group]}
                                    <select
                                      value={result.plan.materialCityByGroup[group] ?? result.craftCity}
                                      onChange={(event) =>
                                        updatePlan(result.plan.variantId, {
                                          materialCityByGroup: {
                                            ...result.plan.materialCityByGroup,
                                            [group]: event.target.value,
                                          },
                                        })
                                      }
                                    >
                                      {marketCityOptions.map((cityName) => (
                                        <option key={cityName} value={cityName}>
                                          {cityName}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                ))}

                                {hasArtifacts && (
                                  <label>
                                    Artifact Buy City
                                    <select
                                      value={result.plan.artifactBuyCity}
                                      onChange={(event) => updatePlan(result.plan.variantId, { artifactBuyCity: event.target.value })}
                                    >
                                      <option value="AUTO">Auto (craft city)</option>
                                      {marketCityOptions.map((cityName) => (
                                        <option key={cityName} value={cityName}>
                                          {cityName}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                )}
                              </div>

                              {result.missingPrices.length > 0 && (
                                <div className="missing-block">
                                  <strong>Missing prices:</strong>
                                  <ul>
                                    {result.missingPrices.map((missingPrice) => (
                                      <li key={missingPrice}>{missingPrice}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              <div className="materials-section">
                                <h4>Input Materials</h4>
                                <div className="materials-table-wrap">
                                  <table className="materials-table">
                                    <thead>
                                      <tr>
                                        <th>Material</th>
                                        <th>Type</th>
                                        <th>Buy City</th>
                                        <th>Needed</th>
                                        <th>Recipe</th>
                                        <th>Returned</th>
                                        <th>Unit</th>
                                        <th>Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {result.materialLines.map((line) => (
                                        <tr key={`${result.plan.variantId}-${line.marketItemId}-${line.buyCity}`}>
                                          <td>
                                            <div className="material-name">
                                              <strong>{line.displayName}</strong>
                                              <span>{line.marketItemId}</span>
                                            </div>
                                          </td>
                                          <td>{line.isArtifact ? 'Artifact' : MATERIAL_GROUP_LABELS[line.materialGroup ?? 'other']}</td>
                                          <td>{line.buyCity}</td>
                                          <td>{DECIMAL_FORMATTER.format(line.quantity)}</td>
                                          <td>{DECIMAL_FORMATTER.format(line.baseQuantity)}</td>
                                          <td>{DECIMAL_FORMATTER.format(line.returnedQuantity)}</td>
                                          <td>{formatSilver(line.unitPrice)}</td>
                                          <td>{formatSilver(line.totalCost)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel breakdown-panel">
        <div className="panel-title-row">
          <h2>Plan Breakdown</h2>
          <p>Aggregated outputs and all required inputs for the current craft list.</p>
        </div>

        {plannedView.results.length === 0 ? (
          <p className="muted">No craft plan yet.</p>
        ) : (
          <div className="breakdown-grid">
            <div className="breakdown-block">
              <h3>Craft Outputs</h3>
              <div className="materials-table-wrap">
                <table className="materials-table">
                  <thead>
                    <tr>
                      <th>Craft</th>
                      <th>Sell City</th>
                      <th>Quantity</th>
                      <th>Output Weight</th>
                      <th>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.outputs.map((entry) => (
                      <tr key={`${entry.label}-${entry.sellCity}`}>
                        <td>{entry.label}</td>
                        <td>{entry.sellCity}</td>
                        <td>{entry.quantity}</td>
                        <td>{formatWeight(entry.weight)}</td>
                        <td>{formatSilver(entry.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="breakdown-block">
              <h3>Required Inputs</h3>
              <div className="materials-table-wrap">
                <table className="materials-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Type</th>
                      <th>Buy City</th>
                      <th>Needed</th>
                      <th>Recipe</th>
                      <th>Returned</th>
                      <th>Unit</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.inputs.map((entry) => (
                      <tr key={`${entry.marketItemId}-${entry.buyCity}`}>
                        <td>
                          <div className="material-name">
                            <strong>{entry.displayName}</strong>
                            <span>{entry.marketItemId}</span>
                          </div>
                        </td>
                        <td>{entry.typeLabel}</td>
                        <td>{entry.buyCity}</td>
                        <td>{DECIMAL_FORMATTER.format(entry.quantity)}</td>
                        <td>{DECIMAL_FORMATTER.format(entry.recipeQuantity)}</td>
                        <td>{DECIMAL_FORMATTER.format(entry.returnedQuantity)}</td>
                        <td>{formatSilver(entry.unitPrice)}</td>
                        <td>{formatSilver(entry.totalCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export default App
