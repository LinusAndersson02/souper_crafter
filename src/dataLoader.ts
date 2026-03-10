import {
  ROYAL_CLUSTER_IDS,
  type CityProfile,
  type CraftItem,
  type EnchantmentLevel,
  type GameData,
  type RecipeResource,
  type RoyalClusterId,
} from './types'

type UnknownRecord = Record<string, unknown>

interface ItemsFile {
  items: UnknownRecord
}

interface CraftingModifiersFile {
  craftingmodifiers: {
    craftinglocation: UnknownRecord | UnknownRecord[]
  }
}

interface CleanDataFile {
  items: CraftItem[]
  cityProfiles: CityProfile[]
  knownMarketItemIds?: string[]
}

const FALLBACK_CATEGORY = 'uncategorized'
const ENCHANTMENT_LEVELS: EnchantmentLevel[] = [1, 2, 3, 4]
const BLACK_MARKET_CATEGORY_ALLOWLIST = new Set([
  'axe',
  'arcanestaff',
  'bow',
  'crossbow',
  'cursestaff',
  'dagger',
  'firestaff',
  'froststaff',
  'hammer',
  'holystaff',
  'knuckles',
  'mace',
  'naturestaff',
  'quarterstaff',
  'shapeshifterstaff',
  'spear',
  'sword',
  'cloth_armor',
  'cloth_helmet',
  'cloth_shoes',
  'leather_armor',
  'leather_helmet',
  'leather_shoes',
  'plate_armor',
  'plate_helmet',
  'plate_shoes',
  'offhand',
  'offhands',
  'shieldtype_shield',
  'bag',
  'cape',
])

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) {
    return []
  }

  return Array.isArray(value) ? value : [value]
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  return value as UnknownRecord
}

function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  return fallback
}

function shouldExcludeCraftTarget(itemId: string, category: string): boolean {
  const upperId = itemId.toUpperCase()
  const upperCategory = category.toUpperCase()

  if (upperId.startsWith('QUESTITEM')) {
    return true
  }

  if (upperId.includes('ARTEFACT')) {
    return true
  }

  if (
    upperId.includes('WARDROBE') ||
    upperId.includes('UNLOCK_SKIN') ||
    upperId.includes('MOUNTSKIN') ||
    upperCategory === 'VANITY'
  ) {
    return true
  }

  if (/^CAPEITEM_.*_BP(?:@\d+)?$/.test(upperId)) {
    return true
  }

  if (upperId.includes('DUNGEON') && (upperId.includes('TOKEN') || upperId.includes('MAP'))) {
    return true
  }

  if (upperId.includes('HELLGATE') && upperId.includes('MAP')) {
    return true
  }

  if (upperId.includes('CORRUPTED') && upperId.includes('MAP')) {
    return true
  }

  return !isBlackMarketSellableCraft(itemId, category)
}

function isBlackMarketSellableCraft(itemId: string, category: string): boolean {
  const upperId = itemId.toUpperCase()
  const normalizedCategory = category.trim().toLowerCase()

  if (BLACK_MARKET_CATEGORY_ALLOWLIST.has(normalizedCategory)) {
    return true
  }

  if (normalizedCategory.startsWith('accessoires_capes_')) {
    return true
  }

  if (/^T\d+_BAG(?:_INSIGHT)?(?:@\d+)?$/.test(upperId)) {
    return true
  }

  if (/^T\d+_CAPE(?:@\d+)?$/.test(upperId)) {
    return true
  }

  if (/(?:^|_)CAPEITEM_/.test(upperId) && !/_BP(?:@\d+)?$/.test(upperId)) {
    return true
  }

  if (/^T\d+_(?:ARMOR|HEAD|SHOES)_(?:CLOTH|LEATHER|PLATE)_(?:ROYAL|SET\d+)(?:@\d+)?$/.test(upperId)) {
    return true
  }

  if (upperId.includes('_OFF_')) {
    return true
  }

  return false
}

function resolveMarketIdForEnchantment(
  baseItemId: string,
  enchantment: EnchantmentLevel,
  knownMarketItemIds: Set<string>,
): string | null {
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

function normalizeAvailableEnchantments(
  itemId: string,
  knownMarketItemIds: Set<string>,
): EnchantmentLevel[] {
  const enchantments: EnchantmentLevel[] = [0]

  for (const enchantment of ENCHANTMENT_LEVELS) {
    if (resolveMarketIdForEnchantment(itemId, enchantment, knownMarketItemIds)) {
      enchantments.push(enchantment)
    }
  }

  return enchantments
}

function parseItemsTextData(itemsText: string): {
  nameMap: Map<string, string>
  knownMarketItemIds: Set<string>
} {
  const nameMap = new Map<string, string>()
  const knownMarketItemIds = new Set<string>()
  const lines = itemsText.split(/\r?\n/)

  for (const line of lines) {
    const match = line.match(/^\s*\d+\s*:\s*([^:]+?)\s*:\s*(.*?)\s*$/)
    if (!match) {
      continue
    }

    const [, id, name] = match
    const normalizedId = id.trim()
    const normalizedName = name.trim()

    if (normalizedId.length > 0) {
      knownMarketItemIds.add(normalizedId)
    }

    if (normalizedId.length > 0 && normalizedName.length > 0) {
      nameMap.set(normalizedId, normalizedName)
    }
  }

  return { nameMap, knownMarketItemIds }
}

function parseWorldMap(worldText: string): Map<string, string> {
  const worldMap = new Map<string, string>()
  const lines = worldText.split(/\r?\n/)

  for (const line of lines) {
    const match = line.match(/^\s*([0-9]{4})\s*:\s*(.*?)\s*$/)
    if (!match) {
      continue
    }

    const [, clusterId, cityName] = match
    if (cityName.length > 0) {
      worldMap.set(clusterId, cityName)
    }
  }

  return worldMap
}

function normalizeCategory(rawItem: UnknownRecord): string {
  const categoryFields = [
    rawItem['@craftingcategory'],
    rawItem['@shopsubcategory2'],
    rawItem['@shopsubcategory1'],
  ]

  for (const field of categoryFields) {
    if (typeof field === 'string' && field.trim().length > 0) {
      return field.trim()
    }
  }

  return FALLBACK_CATEGORY
}

function normalizeRecipeResource(resource: unknown): RecipeResource | null {
  const raw = asRecord(resource)
  if (!raw) {
    return null
  }

  const itemId = typeof raw.itemId === 'string' ? raw.itemId.trim() : ''
  const count = parseNumber(raw.count, 0)
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : itemId

  if (itemId.length === 0 || count <= 0) {
    return null
  }

  return {
    itemId,
    count,
    displayName: displayName.length > 0 ? displayName : itemId,
  }
}

function chooseCraftingRequirement(rawRequirements: unknown): UnknownRecord | null {
  const requirements = toArray(rawRequirements)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is UnknownRecord => entry !== null)

  if (requirements.length === 0) {
    return null
  }

  const preferred = requirements.find((requirement) => {
    const resources = toArray(requirement.craftresource)
      .map((resource) => asRecord(resource))
      .filter((resource): resource is UnknownRecord => resource !== null)

    return resources.every((resource) => {
      const itemId = typeof resource['@uniquename'] === 'string' ? resource['@uniquename'] : ''
      return !itemId.toUpperCase().includes('ARTEFACT_TOKEN_FAVOR')
    })
  })

  return preferred ?? requirements[0]
}

function normalizeCraftItem(item: unknown): CraftItem | null {
  const raw = asRecord(item)
  if (!raw) {
    return null
  }

  const itemId = typeof raw.itemId === 'string' ? raw.itemId.trim() : ''
  if (itemId.length === 0) {
    return null
  }

  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : itemId
  const category =
    typeof raw.craftingCategory === 'string' && raw.craftingCategory.trim().length > 0
      ? raw.craftingCategory.trim()
      : FALLBACK_CATEGORY

  if (shouldExcludeCraftTarget(itemId, category)) {
    return null
  }

  const rawRecipe = Array.isArray(raw.recipe) ? raw.recipe : []
  const recipe = rawRecipe
    .map((resource) => normalizeRecipeResource(resource))
    .filter((resource): resource is RecipeResource => resource !== null)

  if (recipe.length === 0) {
    return null
  }

  const parsedTier = parseNumber(raw.tier, Number.NaN)

  return {
    itemId,
    displayName: displayName.length > 0 ? displayName : itemId,
    tier: Number.isFinite(parsedTier) ? parsedTier : null,
    craftingCategory: category,
    weight: parseNumber(raw.weight, 0),
    itemValue: parseNumber(raw.itemValue, 0),
    recipe,
    availableEnchantments: [0],
  }
}

function parseRecipeResources(rawItem: UnknownRecord, nameMap: Map<string, string>) {
  const craftingRequirements = chooseCraftingRequirement(rawItem.craftingrequirements)
  const rawResources = craftingRequirements?.craftresource
  const parsedResources = toArray(rawResources)
    .map((resource) => asRecord(resource))
    .filter((resource): resource is UnknownRecord => resource !== null)
    .map((resource) => {
      const itemId = typeof resource['@uniquename'] === 'string' ? resource['@uniquename'] : ''
      const count = parseNumber(resource['@count'], 0)

      return {
        itemId,
        count,
        displayName: nameMap.get(itemId) ?? itemId,
      }
    })
    .filter((resource) => resource.itemId.length > 0 && resource.count > 0)

  return parsedResources
}

function parseCraftItems(itemsFile: ItemsFile, nameMap: Map<string, string>): CraftItem[] {
  const itemsRoot = asRecord(itemsFile.items)
  if (!itemsRoot) {
    return []
  }

  const byItemId = new Map<string, CraftItem>()

  for (const [bucketName, bucketValue] of Object.entries(itemsRoot)) {
    if (bucketName.startsWith('@') || bucketName === 'shopcategories') {
      continue
    }

    for (const candidate of toArray(bucketValue)) {
      const rawItem = asRecord(candidate)
      if (!rawItem) {
        continue
      }

      const itemId = typeof rawItem['@uniquename'] === 'string' ? rawItem['@uniquename'] : ''
      if (itemId.length === 0 || byItemId.has(itemId)) {
        continue
      }

      const craftingCategory = normalizeCategory(rawItem)
      if (shouldExcludeCraftTarget(itemId, craftingCategory)) {
        continue
      }

      const recipe = parseRecipeResources(rawItem, nameMap)
      if (recipe.length === 0) {
        continue
      }

      const tierValue = parseNumber(rawItem['@tier'], Number.NaN)
      byItemId.set(itemId, {
        itemId,
        displayName: nameMap.get(itemId) ?? itemId,
        tier: Number.isFinite(tierValue) ? tierValue : null,
        craftingCategory,
        weight: parseNumber(rawItem['@weight'], 0),
        itemValue: parseNumber(rawItem['@itemvalue'], 0),
        recipe,
        availableEnchantments: [0],
      })
    }
  }

  return [...byItemId.values()]
}

function normalizeCityProfile(cityProfile: unknown): CityProfile | null {
  const raw = asRecord(cityProfile)
  if (!raw) {
    return null
  }

  const clusterId = typeof raw.clusterId === 'string' ? raw.clusterId : ''
  if (!ROYAL_CLUSTER_IDS.includes(clusterId as RoyalClusterId)) {
    return null
  }

  const cityName = typeof raw.cityName === 'string' ? raw.cityName.trim() : clusterId
  const baseCraftBonus = parseNumber(raw.baseCraftBonus, 0)
  const categoryBonusesRaw = asRecord(raw.categoryBonuses)

  const categoryBonuses: Record<string, number> = {}
  if (categoryBonusesRaw) {
    for (const [category, bonus] of Object.entries(categoryBonusesRaw)) {
      categoryBonuses[category] = parseNumber(bonus, 0)
    }
  }

  return {
    clusterId: clusterId as RoyalClusterId,
    cityName: cityName.length > 0 ? cityName : clusterId,
    baseCraftBonus,
    categoryBonuses,
  }
}

function parseCityProfiles(
  modifiersFile: CraftingModifiersFile,
  worldMap: Map<string, string>,
): CityProfile[] {
  const rawLocations = toArray(modifiersFile.craftingmodifiers.craftinglocation)
  const profileMap = new Map<RoyalClusterId, CityProfile>()

  for (const rawLocation of rawLocations) {
    const location = asRecord(rawLocation)
    if (!location) {
      continue
    }

    const clusterId = typeof location['@clusterid'] === 'string' ? location['@clusterid'] : ''
    if (!ROYAL_CLUSTER_IDS.includes(clusterId as RoyalClusterId)) {
      continue
    }

    const craftingBonus = asRecord(location.craftingbonus)
    const baseCraftBonus = parseNumber(craftingBonus?.['@value'], 0)
    const rawModifiers = toArray(location.craftingmodifier)

    const categoryBonuses: Record<string, number> = {}
    for (const rawModifier of rawModifiers) {
      const modifier = asRecord(rawModifier)
      if (!modifier) {
        continue
      }

      const category = typeof modifier['@name'] === 'string' ? modifier['@name'] : ''
      if (category.length === 0) {
        continue
      }

      categoryBonuses[category] = parseNumber(modifier['@value'], 0)
    }

    const royalClusterId = clusterId as RoyalClusterId
    profileMap.set(royalClusterId, {
      clusterId: royalClusterId,
      cityName: worldMap.get(clusterId) ?? clusterId,
      baseCraftBonus,
      categoryBonuses,
    })
  }

  return ROYAL_CLUSTER_IDS.map((clusterId) => profileMap.get(clusterId)).filter(
    (profile): profile is CityProfile => profile !== undefined,
  )
}

function createCategoryPresetMap(cityProfiles: CityProfile[]): Record<string, string> {
  const categoryToBestCity = new Map<string, { cityName: string; bonus: number }>()

  for (const cityProfile of cityProfiles) {
    for (const [category, bonus] of Object.entries(cityProfile.categoryBonuses)) {
      const existing = categoryToBestCity.get(category)
      if (!existing || bonus > existing.bonus) {
        categoryToBestCity.set(category, {
          cityName: cityProfile.cityName,
          bonus,
        })
      }
    }
  }

  return Object.fromEntries(
    [...categoryToBestCity.entries()].map(([category, value]) => [category, value.cityName]),
  )
}

function enrichEnchantments(items: CraftItem[], knownMarketItemIds: Set<string>): CraftItem[] {
  return items.map((item) => ({
    ...item,
    availableEnchantments: normalizeAvailableEnchantments(item.itemId, knownMarketItemIds),
  }))
}

function finalizeGameData(
  items: CraftItem[],
  cityProfiles: CityProfile[],
  knownMarketItemIds: Set<string>,
): GameData {
  const enrichedItems = enrichEnchantments(items, knownMarketItemIds)
  const categories = [...new Set(enrichedItems.map((item) => item.craftingCategory))].sort((a, b) =>
    a.localeCompare(b),
  )

  return {
    items: enrichedItems,
    cityProfiles,
    categoryPresetCity: createCategoryPresetMap(cityProfiles),
    categories,
    cityNames: cityProfiles.map((city) => city.cityName),
    knownMarketItemIds: [...knownMarketItemIds],
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as T
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status} ${response.statusText}`)
  }

  return response.text()
}

async function loadCleanedData(): Promise<GameData> {
  const file = await fetchJson<CleanDataFile>('/crafting-data.json')

  const knownMarketItemIds = new Set<string>(toArray(file.knownMarketItemIds))

  const items = toArray(file.items)
    .map((item) => normalizeCraftItem(item))
    .filter((item): item is CraftItem => item !== null)

  const cityProfiles = toArray(file.cityProfiles)
    .map((cityProfile) => normalizeCityProfile(cityProfile))
    .filter((cityProfile): cityProfile is CityProfile => cityProfile !== null)

  if (items.length === 0 || cityProfiles.length === 0) {
    throw new Error('Cleaned crafting-data.json is missing required data.')
  }

  return finalizeGameData(items, cityProfiles, knownMarketItemIds)
}

async function loadLegacyData(): Promise<GameData> {
  const [itemsFile, itemsText, modifiersFile, worldText] = await Promise.all([
    fetchJson<ItemsFile>('/items.json'),
    fetchText('/items.txt'),
    fetchJson<CraftingModifiersFile>('/craftingmodifiers.json'),
    fetchText('/world.txt'),
  ])

  const { nameMap: itemNameMap, knownMarketItemIds } = parseItemsTextData(itemsText)
  const worldMap = parseWorldMap(worldText)

  const cityProfiles = parseCityProfiles(modifiersFile, worldMap)
  const items = parseCraftItems(itemsFile, itemNameMap)

  return finalizeGameData(items, cityProfiles, knownMarketItemIds)
}

export async function loadGameData(): Promise<GameData> {
  try {
    return await loadCleanedData()
  } catch {
    return loadLegacyData()
  }
}
