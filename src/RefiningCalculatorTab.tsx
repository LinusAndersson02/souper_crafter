import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchPriceBook } from './pricing'
import { useLocalStorageState } from './useLocalStorage'
import {
  BUY_PRICE_TYPE_LABELS,
  REFINING_AUTO_BUY_CITY,
  REFINING_AUTO_SELL_CITY,
  REFINING_FAMILY_OPTIONS,
  REFINING_PRICE_SOURCE_LABELS,
  REFINING_SELL_PRICE_TYPE_LABELS,
  buildRefiningItemLabel,
  calculateRefiningPlans,
  collectRequiredRefiningPriceItemIds,
  describeDirectInputs,
  getDefaultRefiningBuyCity,
  getDefaultRefiningCity,
  getDefaultRefiningSellCity,
  type RefiningInputLine,
  type RefiningPlan,
  type RefiningPriceSource,
  type RefiningResult,
  type RefiningSellPriceType,
  type RefiningSettings,
} from './refining'
import type { BuyPriceType, GameData, MaterialGroup, PriceBook, RefiningItem, ServerRegion } from './types'

const REFINING_SETTINGS_STORAGE_KEY = 'souper-crafter-refining-settings-v1'
const REFINING_PLANS_STORAGE_KEY = 'souper-crafter-refining-plans-v1'
const ESTIMATE_WINDOW = '7d' as const
const DEFAULT_REFINING_QUANTITY = 250
const BUY_PRICE_TYPE_OPTIONS: BuyPriceType[] = ['INSTANT_BUY', 'BUY_ORDER', 'TRADE']

const DEFAULT_SETTINGS: RefiningSettings = {
  search: '',
  tierFilters: [],
  familyFilters: [],
  enchantmentFilters: [0],
  serverRegion: 'EU',
  hasPremium: true,
  includeBuyTaxes: true,
  resourcePriceSource: 'CURRENT',
  productPriceSource: 'CURRENT',
  stationFeePer100Nutrition: 0,
  defaultBuyCity: REFINING_AUTO_BUY_CITY,
  defaultBuyPriceType: 'BUY_ORDER',
  defaultSellCity: REFINING_AUTO_SELL_CITY,
  defaultSellPriceType: 'SELL_ORDER',
  stackFromTier: 2,
}

const REFINING_BUY_PRICE_TYPE_LABELS: Record<BuyPriceType, string> = {
  ...BUY_PRICE_TYPE_LABELS,
  INSTANT_BUY: 'Sell Order',
}

const EMPTY_PRICE_BOOK: PriceBook = {
  values: {},
  fetchedAt: null,
  error: null,
}

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const DECIMAL_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
const COUNT_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })

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

function formatPerItem(value: number, quantity: number): string {
  if (quantity <= 0) {
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

function toggleValueInList<T extends string | number>(values: T[], value: T): T[] {
  if (values.includes(value)) {
    return values.filter((entry) => entry !== value)
  }

  return [...values, value].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
  )
}

function formatAgeHours(hours: number): string {
  if (hours >= 48) {
    return `${(hours / 24).toFixed(1)}d`
  }

  return `${hours.toFixed(1)}h`
}

function resolveRowStatus(result: RefiningResult) {
  if (result.missingPrices.length > 0) {
    return {
      symbol: '!',
      className: 'row-status-icon missing',
      title: `Missing ${result.missingPrices.length} price${result.missingPrices.length === 1 ? '' : 's'}.`,
    }
  }

  if (result.priceAgeHours !== null) {
    if (result.priceAgeHours >= 24) {
      return {
        symbol: '●',
        className: 'row-status-icon stale-critical',
        title: `At least one live price used by this refining row is ${formatAgeHours(result.priceAgeHours)} old.`,
      }
    }

    if (result.priceAgeHours >= 4) {
      return {
        symbol: '●',
        className: 'row-status-icon stale-warning',
        title: `At least one live price used by this refining row is ${formatAgeHours(result.priceAgeHours)} old.`,
      }
    }

    return {
      symbol: '●',
      className: 'row-status-icon ready',
      title: 'All live prices used by this refining row are fresher than 4 hours.',
    }
  }

  if (result.avgSoldPerDay30d !== null) {
    return {
      symbol: '◐',
      className: 'row-status-icon partial',
      title: '30 day volume history is available, but no live order timestamps are available for this row.',
    }
  }

  if (result.avgPrice30d !== null) {
    return {
      symbol: '◐',
      className: 'row-status-icon partial',
      title: '30 day price history is available.',
    }
  }

  return {
    symbol: '○',
    className: 'row-status-icon spot',
    title: 'Only current spot pricing is available.',
  }
}

function buildInfoTitle(result: RefiningResult): string {
  const primaryStep = result.steps[result.steps.length - 1]
  return [
    `Return Rate: ${formatPct((primaryStep?.returnRate ?? 0) * 100)}`,
    `Purchased Inputs: ${formatSilver(result.totalInputCost)}`,
    `Return Credit: ${formatSilver(result.totalReturnValue)}`,
    `Station Fee: ${formatSilver(result.totalStationFee)}`,
    `Market Fee: ${formatSilver(result.marketFee)}`,
    `Sold/Day: ${formatCount(result.avgSoldPerDay30d)}`,
  ].join('\n')
}

function buildDefaultPlan(item: RefiningItem, gameData: GameData, settings: RefiningSettings): RefiningPlan {
  const refineCity = getDefaultRefiningCity(item, gameData.categoryPresetCity)
  return {
    itemId: item.itemId,
    quantity: DEFAULT_REFINING_QUANTITY,
    refineCity,
    buyCity: getDefaultRefiningBuyCity(item, settings.defaultBuyCity),
    sellCity: getDefaultRefiningSellCity(refineCity, settings.defaultSellCity),
    buyPriceType: settings.defaultBuyPriceType,
    sellPriceType: settings.defaultSellPriceType,
  }
}

function normalizeSettings(rawSettings: RefiningSettings, availableTiers: number[], cityOptions: string[]): RefiningSettings {
  const tierSet = new Set(availableTiers)
  const familySet = new Set<MaterialGroup>(REFINING_FAMILY_OPTIONS.map((option) => option.value))
  const enchantmentSet = new Set([0, 1, 2, 3, 4])
  const citySet = new Set(cityOptions)

  return {
    search: typeof rawSettings.search === 'string' ? rawSettings.search : '',
    tierFilters: Array.isArray(rawSettings.tierFilters)
      ? rawSettings.tierFilters.filter((tier): tier is number => typeof tier === 'number' && tierSet.has(tier))
      : [],
    familyFilters: Array.isArray(rawSettings.familyFilters)
      ? rawSettings.familyFilters.filter(
          (family): family is MaterialGroup => typeof family === 'string' && familySet.has(family as MaterialGroup),
        )
      : [],
    enchantmentFilters: Array.isArray(rawSettings.enchantmentFilters)
      ? rawSettings.enchantmentFilters.filter(
          (level): level is number => typeof level === 'number' && enchantmentSet.has(level),
        )
      : [0],
    serverRegion:
      rawSettings.serverRegion === 'EU' || rawSettings.serverRegion === 'US' || rawSettings.serverRegion === 'ASIA'
        ? rawSettings.serverRegion
        : DEFAULT_SETTINGS.serverRegion,
    hasPremium: typeof rawSettings.hasPremium === 'boolean' ? rawSettings.hasPremium : DEFAULT_SETTINGS.hasPremium,
    includeBuyTaxes:
      typeof rawSettings.includeBuyTaxes === 'boolean' ? rawSettings.includeBuyTaxes : DEFAULT_SETTINGS.includeBuyTaxes,
    resourcePriceSource:
      rawSettings.resourcePriceSource === 'AVERAGE_30D' || rawSettings.resourcePriceSource === 'CURRENT'
        ? rawSettings.resourcePriceSource
        : DEFAULT_SETTINGS.resourcePriceSource,
    productPriceSource:
      rawSettings.productPriceSource === 'AVERAGE_30D' || rawSettings.productPriceSource === 'CURRENT'
        ? rawSettings.productPriceSource
        : DEFAULT_SETTINGS.productPriceSource,
    stationFeePer100Nutrition:
      typeof rawSettings.stationFeePer100Nutrition === 'number' && Number.isFinite(rawSettings.stationFeePer100Nutrition)
        ? Math.max(0, rawSettings.stationFeePer100Nutrition)
        : DEFAULT_SETTINGS.stationFeePer100Nutrition,
    defaultBuyCity:
      typeof rawSettings.defaultBuyCity === 'string' &&
      (rawSettings.defaultBuyCity === REFINING_AUTO_BUY_CITY || citySet.has(rawSettings.defaultBuyCity))
        ? rawSettings.defaultBuyCity
        : DEFAULT_SETTINGS.defaultBuyCity,
    defaultBuyPriceType:
      rawSettings.defaultBuyPriceType === 'TRADE' ||
      rawSettings.defaultBuyPriceType === 'INSTANT_BUY' ||
      rawSettings.defaultBuyPriceType === 'BUY_ORDER'
        ? rawSettings.defaultBuyPriceType
        : DEFAULT_SETTINGS.defaultBuyPriceType,
    defaultSellCity:
      typeof rawSettings.defaultSellCity === 'string' &&
      (rawSettings.defaultSellCity === REFINING_AUTO_SELL_CITY || citySet.has(rawSettings.defaultSellCity))
        ? rawSettings.defaultSellCity
        : DEFAULT_SETTINGS.defaultSellCity,
    defaultSellPriceType:
      rawSettings.defaultSellPriceType === 'TRADE' || rawSettings.defaultSellPriceType === 'SELL_ORDER'
        ? rawSettings.defaultSellPriceType
        : DEFAULT_SETTINGS.defaultSellPriceType,
    stackFromTier:
      typeof rawSettings.stackFromTier === 'number' && Number.isFinite(rawSettings.stackFromTier)
        ? Math.max(2, Math.round(rawSettings.stackFromTier))
        : DEFAULT_SETTINGS.stackFromTier,
  }
}

function normalizePlan(
  rawPlan: unknown,
  gameData: GameData,
  refiningItemsById: Map<string, RefiningItem>,
  settings: RefiningSettings,
): RefiningPlan | null {
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return null
  }

  const candidate = rawPlan as Partial<RefiningPlan>
  const item = typeof candidate.itemId === 'string' ? refiningItemsById.get(candidate.itemId) : null
  if (!item) {
    return null
  }

  const defaultPlan = buildDefaultPlan(item, gameData, settings)
  const cityOptions = new Set(['Caerleon', ...gameData.cityNames])

  return {
    itemId: item.itemId,
    quantity:
      typeof candidate.quantity === 'number' && Number.isFinite(candidate.quantity)
        ? Math.max(1, Math.round(candidate.quantity))
        : defaultPlan.quantity,
    refineCity: typeof candidate.refineCity === 'string' && cityOptions.has(candidate.refineCity) ? candidate.refineCity : defaultPlan.refineCity,
    buyCity: typeof candidate.buyCity === 'string' && cityOptions.has(candidate.buyCity) ? candidate.buyCity : defaultPlan.buyCity,
    sellCity: typeof candidate.sellCity === 'string' && cityOptions.has(candidate.sellCity) ? candidate.sellCity : defaultPlan.sellCity,
    buyPriceType:
      candidate.buyPriceType === 'TRADE' || candidate.buyPriceType === 'INSTANT_BUY' || candidate.buyPriceType === 'BUY_ORDER'
        ? candidate.buyPriceType
        : defaultPlan.buyPriceType,
    sellPriceType:
      candidate.sellPriceType === 'TRADE' || candidate.sellPriceType === 'SELL_ORDER'
        ? candidate.sellPriceType
        : defaultPlan.sellPriceType,
  }
}

export function RefiningCalculatorTab({ gameData }: { gameData: GameData }) {
  const [settings, setSettings] = useLocalStorageState<RefiningSettings>(REFINING_SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS)
  const [plans, setPlans] = useLocalStorageState<RefiningPlan[]>(REFINING_PLANS_STORAGE_KEY, [])
  const [priceBook, setPriceBook] = useState<PriceBook>(EMPTY_PRICE_BOOK)
  const [priceLoading, setPriceLoading] = useState(false)
  const [priceWarning, setPriceWarning] = useState<string | null>(null)
  const [expandedRows, setExpandedRows] = useState<string[]>([])
  const requestAbortRef = useRef<AbortController | null>(null)
  const previousDefaultBuyCityRef = useRef<string>(DEFAULT_SETTINGS.defaultBuyCity)
  const previousDefaultBuyPriceTypeRef = useRef<BuyPriceType>(DEFAULT_SETTINGS.defaultBuyPriceType)
  const previousDefaultSellPriceTypeRef = useRef<RefiningSellPriceType>(DEFAULT_SETTINGS.defaultSellPriceType)

  const refiningItems = useMemo(() => gameData.refiningItems, [gameData.refiningItems])
  const refiningItemsById = useMemo(() => new Map(refiningItems.map((item) => [item.itemId, item])), [refiningItems])
  const knownMarketItemIdSet = useMemo(() => new Set(gameData.knownMarketItemIds), [gameData.knownMarketItemIds])
  const marketCityOptions = useMemo(() => ['Caerleon', ...gameData.cityNames], [gameData.cityNames])

  const safeSettings = useMemo(
    () =>
      normalizeSettings(
        settings,
        [...new Set(refiningItems.map((item) => item.tier).filter((tier): tier is number => tier !== null))],
        marketCityOptions,
      ),
    [marketCityOptions, refiningItems, settings],
  )

  useEffect(() => {
    if (JSON.stringify(safeSettings) !== JSON.stringify(settings)) {
      setSettings(safeSettings)
    }
  }, [safeSettings, setSettings, settings])

  useEffect(() => {
    const previousBuyCity = previousDefaultBuyCityRef.current
    if (previousBuyCity === safeSettings.defaultBuyCity) {
      return
    }

    previousDefaultBuyCityRef.current = safeSettings.defaultBuyCity
    setPlans((previous) =>
      previous.map((plan) => {
        const item = refiningItemsById.get(plan.itemId)
        if (!item) {
          return plan
        }

        return {
          ...plan,
          buyCity: getDefaultRefiningBuyCity(item, safeSettings.defaultBuyCity),
        }
      }),
    )
  }, [refiningItemsById, safeSettings.defaultBuyCity, setPlans])

  useEffect(() => {
    const previousSellPriceType = previousDefaultSellPriceTypeRef.current
    if (previousSellPriceType === safeSettings.defaultSellPriceType) {
      return
    }

    previousDefaultSellPriceTypeRef.current = safeSettings.defaultSellPriceType
    setPlans((previous) =>
      previous.map((plan) => ({
        ...plan,
        sellPriceType: safeSettings.defaultSellPriceType,
      })),
    )
  }, [safeSettings.defaultSellPriceType, setPlans])

  useEffect(() => {
    const previousBuyPriceType = previousDefaultBuyPriceTypeRef.current
    if (previousBuyPriceType === safeSettings.defaultBuyPriceType) {
      return
    }

    previousDefaultBuyPriceTypeRef.current = safeSettings.defaultBuyPriceType
    setPlans((previous) =>
      previous.map((plan) => ({
        ...plan,
        buyPriceType: safeSettings.defaultBuyPriceType,
      })),
    )
  }, [safeSettings.defaultBuyPriceType, setPlans])

  useEffect(() => {
    const normalizedPlans = plans
      .map((plan) => normalizePlan(plan, gameData, refiningItemsById, safeSettings))
      .filter((plan): plan is RefiningPlan => plan !== null)

    if (JSON.stringify(normalizedPlans) !== JSON.stringify(plans)) {
      setPlans(normalizedPlans)
    }
  }, [gameData, plans, refiningItemsById, safeSettings, setPlans])

  useEffect(() => {
    setExpandedRows((previous) => previous.filter((itemId) => plans.some((plan) => plan.itemId === itemId)))
  }, [plans])

  const tierOptions = useMemo(
    () => [...new Set(refiningItems.map((item) => item.tier).filter((tier): tier is number => tier !== null))].sort((a, b) => a - b),
    [refiningItems],
  )

  const filteredItems = useMemo(() => {
    const normalizedSearch = safeSettings.search.trim().toLowerCase()

    return refiningItems.filter((item) => {
      if (safeSettings.tierFilters.length > 0 && (item.tier === null || !safeSettings.tierFilters.includes(item.tier))) {
        return false
      }

      if (safeSettings.familyFilters.length > 0 && !safeSettings.familyFilters.includes(item.craftingCategory)) {
        return false
      }

      if (safeSettings.enchantmentFilters.length > 0 && !safeSettings.enchantmentFilters.includes(item.enchantment)) {
        return false
      }

      if (normalizedSearch.length > 0) {
        const haystack = `${item.displayName} ${item.marketItemId}`.toLowerCase()
        if (!haystack.includes(normalizedSearch)) {
          return false
        }
      }

      return true
    })
  }, [refiningItems, safeSettings])

  const selectedPlansById = useMemo(() => new Map(plans.map((plan) => [plan.itemId, plan])), [plans])

  const requiredItemIds = useMemo(
    () =>
      collectRequiredRefiningPriceItemIds({
        plans,
        refiningItemsById,
        knownMarketItemIds: knownMarketItemIdSet,
        settings: safeSettings,
      }),
    [plans, refiningItemsById, knownMarketItemIdSet, safeSettings],
  )

  const pricingLocations = useMemo(() => {
    const locations = new Set<string>()
    for (const plan of plans) {
      locations.add(plan.buyCity)
      locations.add(plan.sellCity)
    }

    return [...locations]
  }, [plans])

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

      const message = error instanceof Error ? error.message : 'Unable to fetch refining prices.'
      setPriceBook((previous) => ({ ...previous, error: message }))
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

    const timer = window.setTimeout(() => {
      void refreshPrices()
    }, 250)

    return () => window.clearTimeout(timer)
  }, [refreshPrices, requiredItemIds])

  const view = useMemo(
    () =>
      calculateRefiningPlans({
        plans,
        refiningItemsById,
        settings: safeSettings,
        priceBook,
        cityProfiles: gameData.cityProfiles,
        knownMarketItemIds: knownMarketItemIdSet,
      }),
    [gameData.cityProfiles, knownMarketItemIdSet, plans, priceBook, refiningItemsById, safeSettings],
  )

  const breakdown = useMemo(() => {
    const outputs = new Map<string, { label: string; sellCity: string; quantity: number; revenue: number }>()
    const inputs = new Map<string, RefiningInputLine>()

    for (const result of view.results) {
      const outputKey = `${result.item.marketItemId}|${result.plan.sellCity}`
      const existingOutput = outputs.get(outputKey) ?? {
        label: buildRefiningItemLabel(result.item),
        sellCity: result.plan.sellCity,
        quantity: 0,
        revenue: 0,
      }

      existingOutput.quantity += result.plan.quantity
      existingOutput.revenue += result.revenue
      outputs.set(outputKey, existingOutput)

      for (const line of result.terminalInputs) {
        const key = `${line.marketItemId}|${line.buyCity}`
        const existing = inputs.get(key)
        if (existing) {
          existing.quantity += line.quantity
          existing.totalCost += line.totalCost
        } else {
          inputs.set(key, { ...line })
        }
      }
    }

    return {
      outputs: [...outputs.values()].sort((a, b) => {
        const cityComparison = a.sellCity.localeCompare(b.sellCity)
        if (cityComparison !== 0) {
          return cityComparison
        }

        return a.label.localeCompare(b.label)
      }),
      inputs: [...inputs.values()].sort((a, b) => {
        const cityComparison = a.buyCity.localeCompare(b.buyCity)
        if (cityComparison !== 0) {
          return cityComparison
        }

        return a.displayName.localeCompare(b.displayName)
      }),
      outputTotals: {
        quantity: [...outputs.values()].reduce((sum, entry) => sum + entry.quantity, 0),
        revenue: [...outputs.values()].reduce((sum, entry) => sum + entry.revenue, 0),
      },
      inputTotals: {
        quantity: [...inputs.values()].reduce((sum, line) => sum + line.quantity, 0),
        totalCost: [...inputs.values()].reduce((sum, line) => sum + line.totalCost, 0),
      },
    }
  }, [view.results])

  const toggleSelection = (item: RefiningItem) => {
    setPlans((previous) => {
      const existing = previous.find((plan) => plan.itemId === item.itemId)
      if (existing) {
        return previous.filter((plan) => plan.itemId !== item.itemId)
      }

      return [...previous, buildDefaultPlan(item, gameData, safeSettings)]
    })
  }

  const addAllFiltered = () => {
    setPlans((previous) => {
      const next = [...previous]
      const existingIds = new Set(previous.map((plan) => plan.itemId))

      for (const item of filteredItems) {
        if (existingIds.has(item.itemId)) {
          continue
        }

        next.push(buildDefaultPlan(item, gameData, safeSettings))
        existingIds.add(item.itemId)
      }

      return next
    })
  }

  const updatePlan = (itemId: string, patch: Partial<RefiningPlan>) => {
    setPlans((previous) =>
      previous.map((plan) => {
        if (plan.itemId !== itemId) {
          return plan
        }

        return { ...plan, ...patch }
      }),
    )
  }

  const removePlan = (itemId: string) => {
    setExpandedRows((previous) => previous.filter((entry) => entry !== itemId))
    setPlans((previous) => previous.filter((plan) => plan.itemId !== itemId))
  }

  const bulkBuyPriceType = useMemo<'MIXED' | BuyPriceType>(() => {
    if (plans.length === 0) {
      return safeSettings.defaultBuyPriceType
    }

    const [firstPlan, ...restPlans] = plans
    return restPlans.every((plan) => plan.buyPriceType === firstPlan.buyPriceType) ? firstPlan.buyPriceType : 'MIXED'
  }, [plans, safeSettings.defaultBuyPriceType])

  const applyBuyPriceTypeToAll = (buyPriceType: BuyPriceType) => {
    setPlans((previous) => previous.map((plan) => ({ ...plan, buyPriceType })))
  }

  return (
    <>
      <section className="panel picker-panel">
        <div className="panel-title-row">
          <div>
            <h2>Refining Items</h2>
            <p>
              Showing {filteredItems.length} refining targets ({refiningItems.length} total)
            </p>
          </div>
          <button type="button" className="link-btn" onClick={addAllFiltered} disabled={filteredItems.length === 0}>
            Add All Filtered
          </button>
        </div>

        <div className="picker-filters">
          <label>
            Search
            <input
              type="text"
              placeholder="e.g. Cedar Planks or T5 cloth"
              value={safeSettings.search}
              onChange={(event) => setSettings((previous) => ({ ...previous, search: event.target.value }))}
            />
          </label>

          <div className="filter-group">
            <span>Tier</span>
            <div className="toggle-row">
              <button
                type="button"
                className={safeSettings.tierFilters.length === 0 ? 'toggle-chip active' : 'toggle-chip'}
                onClick={() => setSettings((previous) => ({ ...previous, tierFilters: [] }))}
              >
                All
              </button>
              {tierOptions.map((tier) => (
                <button
                  type="button"
                  key={tier}
                  className={safeSettings.tierFilters.includes(tier) ? 'toggle-chip active' : 'toggle-chip'}
                  onClick={() =>
                    setSettings((previous) => ({
                      ...previous,
                      tierFilters: toggleValueInList(previous.tierFilters, tier),
                    }))
                  }
                >
                  T{tier}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <span>Family</span>
            <div className="toggle-row">
              <button
                type="button"
                className={safeSettings.familyFilters.length === 0 ? 'toggle-chip active' : 'toggle-chip'}
                onClick={() => setSettings((previous) => ({ ...previous, familyFilters: [] }))}
              >
                All
              </button>
              {REFINING_FAMILY_OPTIONS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={safeSettings.familyFilters.includes(option.value) ? 'toggle-chip active' : 'toggle-chip'}
                  onClick={() =>
                    setSettings((previous) => ({
                      ...previous,
                      familyFilters: toggleValueInList(previous.familyFilters, option.value),
                    }))
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
                onClick={() => setSettings((previous) => ({ ...previous, enchantmentFilters: [] }))}
              >
                All
              </button>
              {[0, 1, 2, 3, 4].map((enchantment) => (
                <button
                  type="button"
                  key={enchantment}
                  className={safeSettings.enchantmentFilters.includes(enchantment) ? 'toggle-chip active' : 'toggle-chip'}
                  onClick={() =>
                    setSettings((previous) => ({
                      ...previous,
                      enchantmentFilters: toggleValueInList(previous.enchantmentFilters, enchantment),
                    }))
                  }
                >
                  .{enchantment}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="picker-results">
          {filteredItems.map((item) => (
            <button
              type="button"
              key={item.itemId}
              onClick={() => toggleSelection(item)}
              className={selectedPlansById.has(item.itemId) ? 'selected' : ''}
            >
              <span>{buildRefiningItemLabel(item)}</span>
              <strong>{selectedPlansById.has(item.itemId) ? 'Remove' : 'Add'}</strong>
            </button>
          ))}
        </div>

        <div className="picker-footer-note">
          <span>{plans.length} refining plans selected</span>
          <span>Profits stack from lower tiers using the baseline row formula.</span>
        </div>
      </section>

      <section className="panel settings-panel global-bar-panel">
        <div className="panel-title-row">
          <h2>Refining Settings</h2>
          <p>
            {priceBook.fetchedAt
              ? `Last update: ${new Date(priceBook.fetchedAt).toLocaleString()} · ${ESTIMATE_WINDOW} estimates`
              : `No price snapshot yet · ${ESTIMATE_WINDOW} estimates`}
          </p>
        </div>

        <div className="settings-sections">
          <div className="settings-card">
            <div className="settings-card-header">
              <h3>Market Context</h3>
              <p>Region, premium state, station fee, and manual price refresh.</p>
            </div>
            <div className="global-bar-grid">
              <label>
                Server Region
                <select
                  value={safeSettings.serverRegion}
                  onChange={(event) =>
                    setSettings((previous) => ({ ...previous, serverRegion: event.target.value as ServerRegion }))
                  }
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
                  onChange={(event) =>
                    setSettings((previous) => ({ ...previous, hasPremium: event.target.value === 'premium' }))
                  }
                >
                  <option value="premium">Premium</option>
                  <option value="standard">No Premium</option>
                </select>
              </label>

              <label>
                Station Fee / 100 Nutrition
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={safeSettings.stationFeePer100Nutrition}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      stationFeePer100Nutrition: Math.max(
                        0,
                        parseNumericInput(event.target.value, previous.stationFeePer100Nutrition),
                      ),
                    }))
                  }
                />
              </label>

              <div className="settings-action">
                <span>Price Snapshot</span>
                <button type="button" className="refresh-btn" onClick={() => void refreshPrices()} disabled={priceLoading}>
                  {priceLoading ? 'Refreshing prices...' : 'Refresh Prices'}
                </button>
              </div>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card-header">
              <h3>Price Behavior</h3>
              <p>Choose how refining inputs and outputs are valued.</p>
            </div>
            <div className="global-bar-grid">
              <div className="field-card">
                <span>Include Buy Taxes</span>
                <div className="toggle-row field-toggle-row">
                  <button
                    type="button"
                    className={safeSettings.includeBuyTaxes ? 'toggle-chip active' : 'toggle-chip'}
                    onClick={() => setSettings((previous) => ({ ...previous, includeBuyTaxes: true }))}
                  >
                    On
                  </button>
                  <button
                    type="button"
                    className={!safeSettings.includeBuyTaxes ? 'toggle-chip active' : 'toggle-chip'}
                    onClick={() => setSettings((previous) => ({ ...previous, includeBuyTaxes: false }))}
                  >
                    Off
                  </button>
                </div>
              </div>

              <label>
                Resource Price Source
                <select
                  value={safeSettings.resourcePriceSource}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      resourcePriceSource: event.target.value as RefiningPriceSource,
                    }))
                  }
                >
                  {Object.entries(REFINING_PRICE_SOURCE_LABELS).map(([value, label]) => (
                    <option key={`refining-resource-price-source-${value}`} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Product Price Source
                <select
                  value={safeSettings.productPriceSource}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      productPriceSource: event.target.value as RefiningPriceSource,
                    }))
                  }
                >
                  {Object.entries(REFINING_PRICE_SOURCE_LABELS).map(([value, label]) => (
                    <option key={`refining-product-price-source-${value}`} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="settings-card settings-card-wide">
            <div className="settings-card-header">
              <h3>Plan Defaults</h3>
              <p>These defaults apply to new refining plans and overwrite current plans when changed.</p>
            </div>
            <div className="global-bar-grid">
              <label>
                Default Buy City
                <select
                  value={safeSettings.defaultBuyCity}
                  onChange={(event) =>
                    setSettings((previous) => ({ ...previous, defaultBuyCity: event.target.value }))
                  }
                >
                  <option value={REFINING_AUTO_BUY_CITY}>Auto (resource city)</option>
                  {marketCityOptions.map((city) => (
                    <option key={`refining-buy-${city}`} value={city}>
                      {city}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Default Buy Price
                <select
                  value={safeSettings.defaultBuyPriceType}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      defaultBuyPriceType: event.target.value as BuyPriceType,
                    }))
                  }
                >
                  {Object.entries(REFINING_BUY_PRICE_TYPE_LABELS).map(([value, label]) => (
                    <option key={`refining-default-buy-type-${value}`} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Default Sell City
                <select
                  value={safeSettings.defaultSellCity}
                  onChange={(event) =>
                    setSettings((previous) => ({ ...previous, defaultSellCity: event.target.value }))
                  }
                >
                  <option value={REFINING_AUTO_SELL_CITY}>Auto (refining city)</option>
                  {marketCityOptions.map((city) => (
                    <option key={`refining-sell-${city}`} value={city}>
                      {city}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Default Sell Price
                <select
                  value={safeSettings.defaultSellPriceType}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      defaultSellPriceType: event.target.value as RefiningSellPriceType,
                    }))
                  }
                >
                  {Object.entries(REFINING_SELL_PRICE_TYPE_LABELS).map(([value, label]) => (
                    <option key={`refining-default-sell-type-${value}`} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Stack From Tier
                <select
                  value={safeSettings.stackFromTier}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      stackFromTier: Math.max(2, parseNumericInput(event.target.value, previous.stackFromTier)),
                    }))
                  }
                >
                  {tierOptions.map((tier) => (
                    <option key={`refining-stack-tier-${tier}`} value={tier}>
                      T{tier}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      </section>

      <section className="summary-cards">
        <article className="summary-card">
          <h4>Refining Plans</h4>
          <p>{view.summary.plannedItems}</p>
        </article>
        <article className="summary-card">
          <h4>Total Cost</h4>
          <p>{formatSilver(view.summary.totalCost)}</p>
        </article>
        <article className="summary-card">
          <h4>Total Revenue</h4>
          <p>{formatSilver(view.summary.totalRevenue)}</p>
        </article>
        <article className={`summary-card ${view.summary.totalProfit >= 0 ? 'profit' : 'loss'}`}>
          <h4>Total Profit</h4>
          <p>{formatSilver(view.summary.totalProfit)}</p>
        </article>
        <article className={`summary-card ${view.summary.totalProfit >= 0 ? 'profit' : 'loss'}`}>
          <h4>Total Profit %</h4>
          <p>{formatPct(view.summary.totalProfitPct)}</p>
        </article>
      </section>

      {priceBook.error && <p className="banner error">{priceBook.error}</p>}
      {priceWarning && <p className="banner warning">{priceWarning}</p>}

      <section className="panel table-panel planner-panel">
        <div className="panel-title-row planner-panel-header">
          <div>
            <h2>Refining Planner</h2>
            <p>Each row uses direct input cost, return credit, station fee, and stacked previous-tier profit.</p>
          </div>

          <div className="planner-panel-actions">
            <label className="planner-inline-control">
              Apply Buy Type To All
              <select
                value={bulkBuyPriceType}
                onChange={(event) => applyBuyPriceTypeToAll(event.target.value as BuyPriceType)}
                disabled={plans.length === 0}
              >
                <option value="MIXED" disabled>
                  Mixed
                </option>
                {BUY_PRICE_TYPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {REFINING_BUY_PRICE_TYPE_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setExpandedRows([])
                setPlans([])
              }}
              disabled={plans.length === 0}
            >
              Clear All
            </button>
          </div>
        </div>

        {view.results.length === 0 ? (
          <p className="muted">Select refining items above to build a refining plan.</p>
        ) : (
          <div className="table-wrap planner-table-wrap">
            <table className="planner-table">
              <thead>
                <tr>
                  <th />
                  <th>Item</th>
                  <th>Qty</th>
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
                {view.results.map((result) => {
                  const isExpanded = expandedRows.includes(result.item.itemId)
                  const rowStatus = resolveRowStatus(result)

                  return (
                    <Fragment key={result.item.itemId}>
                      <tr className={`planner-summary-row ${result.netProfit >= 0 ? 'profit-row' : 'loss-row'} ${isExpanded ? 'expanded' : ''}`}>
                        <td>
                          <button
                            type="button"
                            className={`row-toggle ${isExpanded ? 'expanded' : ''}`}
                            aria-expanded={isExpanded}
                            onClick={() =>
                              setExpandedRows((previous) =>
                                previous.includes(result.item.itemId)
                                  ? previous.filter((entry) => entry !== result.item.itemId)
                                  : [...previous, result.item.itemId],
                              )
                            }
                          >
                            <span>▸</span>
                          </button>
                        </td>
                        <td>
                          <div className="item-cell">
                            <div className="item-cell-header">
                              <strong>{buildRefiningItemLabel(result.item)}</strong>
                              <div className="item-cell-actions">
                                <button type="button" className="info-icon-btn" title={buildInfoTitle(result)}>
                                  i
                                </button>
                                <span className={rowStatus.className} title={rowStatus.title}>
                                  {rowStatus.symbol}
                                </span>
                              </div>
                            </div>
                            <span>{REFINING_FAMILY_OPTIONS.find((option) => option.value === result.item.craftingCategory)?.label ?? result.item.craftingCategory}</span>
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
                              updatePlan(result.item.itemId, {
                                quantity: Math.max(1, parseNumericInput(event.target.value, result.plan.quantity)),
                              })
                            }
                          />
                        </td>
                        <td>{formatCount(result.avgSoldPerDay30d)}</td>
                        <td>{formatSilver(result.sellPriceUnit)}</td>
                        <td>{formatSilver(result.totalCost)}</td>
                        <td>{formatPerItem(result.netProfit, result.plan.quantity)}</td>
                        <td>{formatSilver(result.netProfit)}</td>
                        <td>{formatPct(result.marginPct)}</td>
                        <td>
                          <button type="button" className="row-remove" onClick={() => removePlan(result.item.itemId)}>
                            Remove
                          </button>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="planner-expand-row">
                          <td colSpan={10}>
                            <div className="planner-expand-inner">
                              <div className="detail-metrics compact-metrics summary-chip-grid">
                                <span>Refine City: {result.plan.refineCity}</span>
                                <span>Buy City: {result.plan.buyCity}</span>
                                <span>Sell City: {result.plan.sellCity}</span>
                                <span>Buy Type: {REFINING_BUY_PRICE_TYPE_LABELS[result.plan.buyPriceType]}</span>
                                <span>Sell Type: {REFINING_SELL_PRICE_TYPE_LABELS[result.plan.sellPriceType]}</span>
                                <span>Stack From: T{safeSettings.stackFromTier}</span>
                                <span>Purchased Inputs: {formatSilver(result.totalInputCost)}</span>
                                <span>Return Credit: {formatSilver(result.totalReturnValue)}</span>
                                <span>Station Fee: {formatSilver(result.totalStationFee)}</span>
                                <span>Market Fee: {formatSilver(result.marketFee)}</span>
                                <span>Revenue: {formatSilver(result.revenue)}</span>
                                <span>Profit %: {formatPct(result.marginPct)}</span>
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
                                      updatePlan(result.item.itemId, {
                                        quantity: Math.max(1, parseNumericInput(event.target.value, result.plan.quantity)),
                                      })
                                    }
                                  />
                                </label>

                                <label>
                                  Refine City
                                  <select
                                    value={result.plan.refineCity}
                                    onChange={(event) => updatePlan(result.item.itemId, { refineCity: event.target.value })}
                                  >
                                    {marketCityOptions.map((city) => (
                                      <option key={city} value={city}>
                                        {city}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                <label>
                                  Buy City
                                  <select
                                    value={result.plan.buyCity}
                                    onChange={(event) => updatePlan(result.item.itemId, { buyCity: event.target.value })}
                                  >
                                    {marketCityOptions.map((city) => (
                                      <option key={city} value={city}>
                                        {city}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                <label>
                                  Sell City
                                  <select
                                    value={result.plan.sellCity}
                                    onChange={(event) => updatePlan(result.item.itemId, { sellCity: event.target.value })}
                                  >
                                    {marketCityOptions.map((city) => (
                                      <option key={city} value={city}>
                                        {city}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                <label>
                                  Sell Price Type
                                  <select
                                    value={result.plan.sellPriceType}
                                    onChange={(event) =>
                                      updatePlan(result.item.itemId, {
                                        sellPriceType: event.target.value as RefiningSellPriceType,
                                      })
                                    }
                                  >
                                    {Object.entries(REFINING_SELL_PRICE_TYPE_LABELS).map(([value, label]) => (
                                      <option key={`refining-plan-sell-type-${result.item.itemId}-${value}`} value={value}>
                                        {label}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                <label>
                                  Buy Price Type
                                  <select
                                    value={result.plan.buyPriceType}
                                    onChange={(event) =>
                                      updatePlan(result.item.itemId, { buyPriceType: event.target.value as BuyPriceType })
                                    }
                                  >
                                    {Object.entries(REFINING_BUY_PRICE_TYPE_LABELS).map(([value, label]) => (
                                      <option key={value} value={value}>
                                        {label}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>

                              {result.missingPrices.length > 0 && (
                                <div className="missing-block">
                                  <strong>Missing prices:</strong>
                                  <ul>
                                    {result.missingPrices.map((entry) => (
                                      <li key={entry}>{entry}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              <div className="materials-section">
                                <h4>Refining Steps</h4>
                                <div className="materials-table-wrap">
                                  <table className="materials-table">
                                    <thead>
                                      <tr>
                                        <th>Step</th>
                                        <th>Direct Inputs</th>
                                        <th>Qty</th>
                                        <th>Return</th>
                                        <th>Input Cost</th>
                                        <th>Fees</th>
                                        <th>Step Profit</th>
                                        <th>Total Profit</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {result.steps.map((step, index) => (
                                        <tr key={`${step.marketItemId}-${index}`}>
                                          <td>{step.displayName}</td>
                                          <td title={describeDirectInputs(step.directInputs)}>{describeDirectInputs(step.directInputs)}</td>
                                          <td>{DECIMAL_FORMATTER.format(step.quantity)}</td>
                                          <td>{formatPct(step.returnRate * 100)}</td>
                                          <td>{formatSilver(step.resourceCost)}</td>
                                          <td>{formatSilver(step.stationFee + step.marketFee)}</td>
                                          <td>{formatSilver(step.stepProfit)}</td>
                                          <td>{formatSilver(step.totalProfit)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                    <tfoot>
                                      <tr className="table-summary-row">
                                        <td>Total</td>
                                        <td>All</td>
                                        <td>{DECIMAL_FORMATTER.format(result.steps.reduce((sum, step) => sum + step.quantity, 0))}</td>
                                        <td>--</td>
                                        <td>{formatSilver(result.steps.reduce((sum, step) => sum + step.resourceCost, 0))}</td>
                                        <td>{formatSilver(result.totalStationFee + result.marketFee)}</td>
                                        <td>{formatSilver(result.steps.reduce((sum, step) => sum + step.stepProfit, 0))}</td>
                                        <td>{formatSilver(result.netProfit)}</td>
                                      </tr>
                                    </tfoot>
                                  </table>
                                </div>
                              </div>

                              <div className="materials-section">
                                <h4>Purchased Inputs</h4>
                                <div className="materials-table-wrap">
                                  <table className="materials-table">
                                    <thead>
                                      <tr>
                                        <th>Material</th>
                                        <th>Market City</th>
                                        <th>Needed</th>
                                        <th>Unit</th>
                                        <th>Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {result.terminalInputs.map((line) => (
                                        <tr key={`${line.marketItemId}-${line.buyCity}`}>
                                          <td>{line.displayName}</td>
                                          <td>{line.buyCity}</td>
                                          <td>{DECIMAL_FORMATTER.format(line.quantity)}</td>
                                          <td>{formatSilver(line.unitPrice)}</td>
                                          <td>{formatSilver(line.totalCost)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                    <tfoot>
                                      <tr className="table-summary-row">
                                        <td>Total</td>
                                        <td>All</td>
                                        <td>{DECIMAL_FORMATTER.format(result.terminalInputs.reduce((sum, line) => sum + line.quantity, 0))}</td>
                                        <td>--</td>
                                        <td>{formatSilver(result.totalInputCost)}</td>
                                      </tr>
                                    </tfoot>
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
          <h2>Refining Breakdown</h2>
          <p>Aggregated outputs and terminal base inputs across all refining plans.</p>
        </div>

        {view.results.length === 0 ? (
          <p className="muted">No refining plan yet.</p>
        ) : (
          <div className="breakdown-grid">
            <div className="breakdown-block">
              <h3>Outputs</h3>
              <div className="materials-table-wrap">
                <table className="materials-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Sell City</th>
                      <th>Quantity</th>
                      <th>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.outputs.map((entry) => (
                      <tr key={`${entry.label}-${entry.sellCity}`}>
                        <td>{entry.label}</td>
                        <td>{entry.sellCity}</td>
                        <td>{DECIMAL_FORMATTER.format(entry.quantity)}</td>
                        <td>{formatSilver(entry.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="table-summary-row">
                      <td>Total</td>
                      <td>All</td>
                      <td>{DECIMAL_FORMATTER.format(breakdown.outputTotals.quantity)}</td>
                      <td>{formatSilver(breakdown.outputTotals.revenue)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="breakdown-block">
              <h3>Purchased Inputs</h3>
              <div className="materials-table-wrap">
                <table className="materials-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Market City</th>
                      <th>Needed</th>
                      <th>Unit</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.inputs.map((line) => (
                      <tr key={`${line.marketItemId}-${line.buyCity}`}>
                        <td>{line.displayName}</td>
                        <td>{line.buyCity}</td>
                        <td>{DECIMAL_FORMATTER.format(line.quantity)}</td>
                        <td>{formatSilver(line.unitPrice)}</td>
                        <td>{formatSilver(line.totalCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="table-summary-row">
                      <td>Total</td>
                      <td>All</td>
                      <td>{DECIMAL_FORMATTER.format(breakdown.inputTotals.quantity)}</td>
                      <td>--</td>
                      <td>{formatSilver(breakdown.inputTotals.totalCost)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  )
}
