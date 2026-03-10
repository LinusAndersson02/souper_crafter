import type { CachedPricePoint, PriceHistoryPoint, PriceWindow, ServerRegion } from './types'

const API_BASE_BY_REGION: Record<ServerRegion, string> = {
  US: 'https://west.albion-online-data.com/api/v2',
  EU: 'https://europe.albion-online-data.com/api/v2',
  ASIA: 'https://east.albion-online-data.com/api/v2',
}

const ALL_QUALITIES = '1,2,3,4,5'
const THIRTY_DAY_WINDOW = 30

interface SpotPriceEntry {
  item_id?: string
  city?: string
  location?: string
  quality?: number
  sell_price_min?: number
  buy_price_max?: number
}

interface HistoryPoint {
  avg_price?: number
  item_count?: number
  timestamp?: string
}

interface HistoryEntry {
  item_id?: string
  city?: string
  location?: string
  quality?: number
  avg_price?: number
  data?: HistoryPoint[]
}

interface AggregatedSpotPoint {
  preferredSellOrder: number | null
  preferredBuyOrder: number | null
  fallbackSellOrder: number | null
  fallbackBuyOrder: number | null
}

interface HistoryAccumulator {
  qualityOneWeightedSum: number
  qualityOneWeight: number
  qualityOneFallbackSum: number
  qualityOneFallbackCount: number
  qualityOne30dWeightedSum: number
  qualityOne30dWeight: number
  qualityOne30dFallbackSum: number
  qualityOne30dFallbackCount: number
  allWeightedSum: number
  allWeight: number
  allFallbackSum: number
  allFallbackCount: number
  all30dWeightedSum: number
  all30dWeight: number
  all30dFallbackSum: number
  all30dFallbackCount: number
  totalSold30d: number
  hasSold30d: boolean
  series30d: Map<string, { weightedPriceSum: number; weightedPriceWeight: number; fallbackPriceSum: number; fallbackPriceCount: number; itemCount: number }>
}

export interface PriceFetchResult {
  values: Record<string, CachedPricePoint>
  warning: string | null
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return []
  }

  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function buildKey(serverRegion: ServerRegion, window: PriceWindow, location: string, itemId: string): string {
  return `${serverRegion}|${window}|${location}|${itemId}`
}

function createEmptyPricePoint(): CachedPricePoint {
  return {
    estimated: null,
    sellOrder: null,
    buyOrder: null,
    avgSoldPerDay30d: null,
    avgPrice30d: null,
    history30d: [],
  }
}

function mergePricePoint(
  values: Record<string, CachedPricePoint>,
  key: string,
  patch: Partial<CachedPricePoint>,
): void {
  const next: CachedPricePoint = {
    ...(values[key] ?? createEmptyPricePoint()),
  }

  let changed = false

  for (const [field, value] of Object.entries(patch) as Array<[keyof CachedPricePoint, CachedPricePoint[keyof CachedPricePoint]]>) {
    if (value === null || value === undefined) {
      continue
    }

    ;(next as unknown as Record<string, unknown>)[field] = value
    changed = true
  }

  if (changed || values[key]) {
    values[key] = next
  }
}

function normalizeLocation(entry: SpotPriceEntry | HistoryEntry): string {
  if (typeof entry.city === 'string' && entry.city.length > 0) {
    return entry.city
  }

  if (typeof entry.location === 'string' && entry.location.length > 0) {
    return entry.location
  }

  return ''
}

function normalizeResponseAsArray<T>(responseBody: unknown): T[] {
  if (Array.isArray(responseBody)) {
    return responseBody as T[]
  }

  if (responseBody && typeof responseBody === 'object') {
    const record = responseBody as Record<string, unknown>
    const nestedCandidates = [record.data, record.items, record.prices]

    for (const candidate of nestedCandidates) {
      if (Array.isArray(candidate)) {
        return candidate as T[]
      }
    }
  }

  return []
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as T
}

function minPositive(current: number | null, candidate: number | null): number | null {
  if (!candidate || candidate <= 0) {
    return current
  }

  if (!current || current <= 0) {
    return candidate
  }

  return Math.min(current, candidate)
}

function maxPositive(current: number | null, candidate: number | null): number | null {
  if (!candidate || candidate <= 0) {
    return current
  }

  if (!current || current <= 0) {
    return candidate
  }

  return Math.max(current, candidate)
}

function resolveEstimatedSpotValue(sellOrder: number | null, buyOrder: number | null): number | null {
  if (sellOrder && sellOrder > 0) {
    return sellOrder
  }

  if (buyOrder && buyOrder > 0) {
    return buyOrder
  }

  return null
}

function isPreferredQuality(quality: number | null): boolean {
  return quality === null || quality === 1
}

async function fetchSpotPrices(
  itemIds: string[],
  locations: string[],
  serverRegion: ServerRegion,
  window: PriceWindow,
  signal?: AbortSignal,
): Promise<Record<string, CachedPricePoint>> {
  if (itemIds.length === 0 || locations.length === 0) {
    return {}
  }

  const aggregates = new Map<string, AggregatedSpotPoint>()
  const locationParam = encodeURIComponent(locations.join(','))

  for (const chunk of chunkArray(itemIds, 80)) {
    const itemPath = chunk.map((itemId) => encodeURIComponent(itemId)).join(',')
    const url = `${API_BASE_BY_REGION[serverRegion]}/stats/prices/${itemPath}.json?locations=${locationParam}&qualities=${encodeURIComponent(ALL_QUALITIES)}`
    const payload = await fetchJson<unknown>(url, signal)
    const entries = normalizeResponseAsArray<SpotPriceEntry>(payload)

    for (const entry of entries) {
      const itemId = typeof entry.item_id === 'string' ? entry.item_id : ''
      const location = normalizeLocation(entry)
      if (itemId.length === 0 || location.length === 0) {
        continue
      }

      const key = buildKey(serverRegion, window, location, itemId)
      const aggregate = aggregates.get(key) ?? {
        preferredSellOrder: null,
        preferredBuyOrder: null,
        fallbackSellOrder: null,
        fallbackBuyOrder: null,
      }

      const sellOrder = toNumber(entry.sell_price_min)
      const buyOrder = toNumber(entry.buy_price_max)
      const quality = toNumber(entry.quality)

      aggregate.fallbackSellOrder = minPositive(aggregate.fallbackSellOrder, sellOrder)
      aggregate.fallbackBuyOrder = maxPositive(aggregate.fallbackBuyOrder, buyOrder)

      if (isPreferredQuality(quality)) {
        aggregate.preferredSellOrder = minPositive(aggregate.preferredSellOrder, sellOrder)
        aggregate.preferredBuyOrder = maxPositive(aggregate.preferredBuyOrder, buyOrder)
      }

      aggregates.set(key, aggregate)
    }
  }

  const values: Record<string, CachedPricePoint> = {}

  for (const [key, aggregate] of aggregates.entries()) {
    const sellOrder = aggregate.preferredSellOrder ?? aggregate.fallbackSellOrder
    const buyOrder = aggregate.preferredBuyOrder ?? aggregate.fallbackBuyOrder

    values[key] = {
      estimated: resolveEstimatedSpotValue(sellOrder, buyOrder),
      sellOrder,
      buyOrder,
      avgSoldPerDay30d: null,
      avgPrice30d: null,
      history30d: [],
    }
  }

  return values
}

function resolveWindowDays(window: PriceWindow): number {
  switch (window) {
    case '24h':
      return 1
    case '30d':
      return 30
    case '7d':
    default:
      return 7
  }
}

function accumulatePrice(
  accumulator: HistoryAccumulator,
  avgPrice: number | null,
  itemCount: number | null,
  preferredQuality: boolean,
): void {
  if (!avgPrice || avgPrice <= 0) {
    return
  }

  if (itemCount && itemCount > 0) {
    accumulator.allWeightedSum += avgPrice * itemCount
    accumulator.allWeight += itemCount

    if (preferredQuality) {
      accumulator.qualityOneWeightedSum += avgPrice * itemCount
      accumulator.qualityOneWeight += itemCount
    }

    return
  }

  accumulator.allFallbackSum += avgPrice
  accumulator.allFallbackCount += 1

  if (preferredQuality) {
    accumulator.qualityOneFallbackSum += avgPrice
    accumulator.qualityOneFallbackCount += 1
  }
}

function resolveAccumulatedAverage(
  weightedSum: number,
  weight: number,
  fallbackSum: number,
  fallbackCount: number,
): number | null {
  if (weight > 0) {
    return weightedSum / weight
  }

  if (fallbackCount > 0) {
    return fallbackSum / fallbackCount
  }

  return null
}

function buildHistorySeries(series30d: HistoryAccumulator['series30d']): PriceHistoryPoint[] {
  return [...series30d.entries()]
    .sort(([leftTimestamp], [rightTimestamp]) => Date.parse(leftTimestamp) - Date.parse(rightTimestamp))
    .map(([timestamp, aggregate]) => {
      let avgPrice: number | null = null

      if (aggregate.weightedPriceWeight > 0) {
        avgPrice = aggregate.weightedPriceSum / aggregate.weightedPriceWeight
      } else if (aggregate.fallbackPriceCount > 0) {
        avgPrice = aggregate.fallbackPriceSum / aggregate.fallbackPriceCount
      }

      return {
        timestamp,
        avgPrice,
        itemCount: aggregate.itemCount > 0 ? aggregate.itemCount : null,
      }
    })
}

async function fetchHistoryAverages(
  itemIds: string[],
  locations: string[],
  serverRegion: ServerRegion,
  window: PriceWindow,
  signal?: AbortSignal,
): Promise<Record<string, CachedPricePoint>> {
  if (itemIds.length === 0 || locations.length === 0) {
    return {}
  }

  const values: Record<string, CachedPricePoint> = {}
  const locationParam = encodeURIComponent(locations.join(','))
  const windowDays = resolveWindowDays(window)
  const now = Date.now()
  const cutoffWindow = now - windowDays * 24 * 60 * 60 * 1000
  const cutoff30d = now - THIRTY_DAY_WINDOW * 24 * 60 * 60 * 1000

  for (const chunk of chunkArray(itemIds, 30)) {
    const itemPath = chunk.map((itemId) => encodeURIComponent(itemId)).join(',')
    const url = `${API_BASE_BY_REGION[serverRegion]}/stats/history/${itemPath}.json?locations=${locationParam}&qualities=${encodeURIComponent(ALL_QUALITIES)}&time-scale=24`
    const payload = await fetchJson<unknown>(url, signal)
    const entries = normalizeResponseAsArray<HistoryEntry>(payload)
    const aggregateMap = new Map<string, HistoryAccumulator>()

    for (const entry of entries) {
      const itemId = typeof entry.item_id === 'string' ? entry.item_id : ''
      const location = normalizeLocation(entry)
      if (itemId.length === 0 || location.length === 0) {
        continue
      }

      const key = buildKey(serverRegion, window, location, itemId)
      const accumulator = aggregateMap.get(key) ?? {
        qualityOneWeightedSum: 0,
        qualityOneWeight: 0,
        qualityOneFallbackSum: 0,
        qualityOneFallbackCount: 0,
        qualityOne30dWeightedSum: 0,
        qualityOne30dWeight: 0,
        qualityOne30dFallbackSum: 0,
        qualityOne30dFallbackCount: 0,
        allWeightedSum: 0,
        allWeight: 0,
        allFallbackSum: 0,
        allFallbackCount: 0,
        all30dWeightedSum: 0,
        all30dWeight: 0,
        all30dFallbackSum: 0,
        all30dFallbackCount: 0,
        totalSold30d: 0,
        hasSold30d: false,
        series30d: new Map(),
      }

      const preferredQuality = isPreferredQuality(toNumber(entry.quality))
      const historyPoints = Array.isArray(entry.data) ? entry.data : []

      if (historyPoints.length > 0) {
        for (const point of historyPoints) {
          const avgPrice = toNumber(point.avg_price)
          const itemCount = toNumber(point.item_count)
          const timestamp = typeof point.timestamp === 'string' ? Date.parse(point.timestamp) : Number.NaN
          const timestampValid = !Number.isNaN(timestamp)
          const inWindow = !timestampValid || timestamp >= cutoffWindow
          const in30d = !timestampValid || timestamp >= cutoff30d

          if (inWindow) {
            accumulatePrice(accumulator, avgPrice, itemCount, preferredQuality)
          }

          if (in30d) {
            const timestampKey = typeof point.timestamp === 'string' && point.timestamp.length > 0 ? point.timestamp : null
            if (itemCount && itemCount > 0) {
              accumulator.all30dWeightedSum += avgPrice && avgPrice > 0 ? avgPrice * itemCount : 0
              accumulator.all30dWeight += avgPrice && avgPrice > 0 ? itemCount : 0

              if (preferredQuality) {
                accumulator.qualityOne30dWeightedSum += avgPrice && avgPrice > 0 ? avgPrice * itemCount : 0
                accumulator.qualityOne30dWeight += avgPrice && avgPrice > 0 ? itemCount : 0
              }

              if (timestampKey) {
                const seriesPoint = accumulator.series30d.get(timestampKey) ?? {
                  weightedPriceSum: 0,
                  weightedPriceWeight: 0,
                  fallbackPriceSum: 0,
                  fallbackPriceCount: 0,
                  itemCount: 0,
                }

                if (avgPrice && avgPrice > 0) {
                  seriesPoint.weightedPriceSum += avgPrice * itemCount
                  seriesPoint.weightedPriceWeight += itemCount
                }
                seriesPoint.itemCount += itemCount
                accumulator.series30d.set(timestampKey, seriesPoint)
              }
            } else if (avgPrice && avgPrice > 0) {
              accumulator.all30dFallbackSum += avgPrice
              accumulator.all30dFallbackCount += 1

              if (preferredQuality) {
                accumulator.qualityOne30dFallbackSum += avgPrice
                accumulator.qualityOne30dFallbackCount += 1
              }

              if (timestampKey) {
                const seriesPoint = accumulator.series30d.get(timestampKey) ?? {
                  weightedPriceSum: 0,
                  weightedPriceWeight: 0,
                  fallbackPriceSum: 0,
                  fallbackPriceCount: 0,
                  itemCount: 0,
                }

                seriesPoint.fallbackPriceSum += avgPrice
                seriesPoint.fallbackPriceCount += 1
                accumulator.series30d.set(timestampKey, seriesPoint)
              }
            }
          }

          if (in30d && itemCount && itemCount > 0) {
            accumulator.totalSold30d += itemCount
            accumulator.hasSold30d = true
          }
        }
      } else {
        accumulatePrice(accumulator, toNumber(entry.avg_price), null, preferredQuality)
        const fallbackAvgPrice = toNumber(entry.avg_price)
        if (fallbackAvgPrice && fallbackAvgPrice > 0) {
          accumulator.all30dFallbackSum += fallbackAvgPrice
          accumulator.all30dFallbackCount += 1

          if (preferredQuality) {
            accumulator.qualityOne30dFallbackSum += fallbackAvgPrice
            accumulator.qualityOne30dFallbackCount += 1
          }
        }
      }

      aggregateMap.set(key, accumulator)
    }

    for (const [key, accumulator] of aggregateMap.entries()) {
      const preferredEstimated = resolveAccumulatedAverage(
        accumulator.qualityOneWeightedSum,
        accumulator.qualityOneWeight,
        accumulator.qualityOneFallbackSum,
        accumulator.qualityOneFallbackCount,
      )
      const fallbackEstimated = resolveAccumulatedAverage(
        accumulator.allWeightedSum,
        accumulator.allWeight,
        accumulator.allFallbackSum,
        accumulator.allFallbackCount,
      )
      const preferredEstimated30d = resolveAccumulatedAverage(
        accumulator.qualityOne30dWeightedSum,
        accumulator.qualityOne30dWeight,
        accumulator.qualityOne30dFallbackSum,
        accumulator.qualityOne30dFallbackCount,
      )
      const fallbackEstimated30d = resolveAccumulatedAverage(
        accumulator.all30dWeightedSum,
        accumulator.all30dWeight,
        accumulator.all30dFallbackSum,
        accumulator.all30dFallbackCount,
      )

        values[key] = {
        estimated: preferredEstimated ?? fallbackEstimated,
        sellOrder: null,
        buyOrder: null,
        avgSoldPerDay30d: accumulator.hasSold30d ? accumulator.totalSold30d / THIRTY_DAY_WINDOW : null,
        avgPrice30d: preferredEstimated30d ?? fallbackEstimated30d,
        history30d: buildHistorySeries(accumulator.series30d),
      }
    }
  }

  return values
}

export async function fetchPriceBook(
  itemIds: string[],
  locations: string[],
  serverRegion: ServerRegion,
  window: PriceWindow,
  signal?: AbortSignal,
): Promise<PriceFetchResult> {
  const spotValues = await fetchSpotPrices(itemIds, locations, serverRegion, window, signal)

  try {
    const historyValues = await fetchHistoryAverages(itemIds, locations, serverRegion, window, signal)

    if (Object.keys(historyValues).length === 0) {
      return {
        values: spotValues,
        warning: 'History endpoint returned no data. Sold/day and estimate fallbacks are unavailable right now.',
      }
    }

    const mergedValues = { ...spotValues }
    for (const [key, point] of Object.entries(historyValues)) {
      mergePricePoint(mergedValues, key, point)
    }

    return {
      values: mergedValues,
      warning: null,
    }
  } catch {
    return {
      values: spotValues,
      warning: 'History pricing is unavailable right now. Falling back to current spot values and hiding sold/day.',
    }
  }
}

export function getCachedPricePoint(
  values: Record<string, CachedPricePoint>,
  serverRegion: ServerRegion,
  window: PriceWindow,
  location: string,
  itemId: string,
): CachedPricePoint | null {
  const value = values[buildKey(serverRegion, window, location, itemId)]
  if (!value) {
    return null
  }

  return {
    estimated: typeof value.estimated === 'number' && Number.isFinite(value.estimated) && value.estimated > 0
      ? value.estimated
      : null,
    sellOrder: typeof value.sellOrder === 'number' && Number.isFinite(value.sellOrder) && value.sellOrder > 0
      ? value.sellOrder
      : null,
    buyOrder: typeof value.buyOrder === 'number' && Number.isFinite(value.buyOrder) && value.buyOrder > 0
      ? value.buyOrder
      : null,
    avgSoldPerDay30d:
      typeof value.avgSoldPerDay30d === 'number' && Number.isFinite(value.avgSoldPerDay30d) && value.avgSoldPerDay30d >= 0
        ? value.avgSoldPerDay30d
        : null,
    avgPrice30d:
      typeof value.avgPrice30d === 'number' && Number.isFinite(value.avgPrice30d) && value.avgPrice30d > 0
        ? value.avgPrice30d
        : null,
    history30d: Array.isArray(value.history30d)
      ? value.history30d
          .filter((point): point is PriceHistoryPoint => typeof point?.timestamp === 'string')
          .map((point) => ({
            timestamp: point.timestamp,
            avgPrice:
              typeof point.avgPrice === 'number' && Number.isFinite(point.avgPrice) && point.avgPrice > 0
                ? point.avgPrice
                : null,
            itemCount:
              typeof point.itemCount === 'number' && Number.isFinite(point.itemCount) && point.itemCount >= 0
                ? point.itemCount
                : null,
          }))
      : [],
  }
}
