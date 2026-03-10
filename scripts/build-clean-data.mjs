import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const ROYAL_CLUSTER_IDS = ['0000', '1000', '2000', '3004', '4000']
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

function toArray(value) {
  if (value == null) {
    return []
  }

  return Array.isArray(value) ? value : [value]
}

function asRecord(value) {
  if (!value || typeof value !== 'object') {
    return null
  }

  return value
}

function parseNumber(value, fallback = 0) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  return fallback
}

function parseItemsTextData(itemsText) {
  const nameMap = new Map()
  const knownMarketItemIds = new Set()

  for (const line of itemsText.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\s*:\s*([^:]+?)\s*:\s*(.*?)\s*$/)
    if (!match) {
      continue
    }

    const [, itemIdRaw, displayNameRaw] = match
    const itemId = itemIdRaw.trim()
    const displayName = displayNameRaw.trim()

    if (itemId.length === 0) {
      continue
    }

    knownMarketItemIds.add(itemId)
    if (displayName.length > 0) {
      nameMap.set(itemId, displayName)
    }
  }

  return { nameMap, knownMarketItemIds }
}

function parseWorldMap(worldText) {
  const map = new Map()

  for (const line of worldText.split(/\r?\n/)) {
    const match = line.match(/^\s*([0-9]{4})\s*:\s*(.*?)\s*$/)
    if (!match) {
      continue
    }

    const [, clusterId, cityName] = match
    if (cityName.length > 0) {
      map.set(clusterId, cityName)
    }
  }

  return map
}

function normalizeCategory(rawItem) {
  const fields = [rawItem['@craftingcategory'], rawItem['@shopsubcategory2'], rawItem['@shopsubcategory1']]

  for (const field of fields) {
    if (typeof field === 'string' && field.trim().length > 0) {
      return field.trim()
    }
  }

  return 'uncategorized'
}

function isBlackMarketSellableCraft(itemId, category) {
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

function shouldExcludeCraftTarget(itemId, category) {
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

function resolveMarketIdForEnchantment(baseItemId, enchantment, knownMarketItemIds) {
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

function chooseCraftingRequirement(rawRequirements) {
  const requirements = toArray(rawRequirements)
    .map((entry) => asRecord(entry))
    .filter(Boolean)

  if (requirements.length === 0) {
    return null
  }

  const preferred = requirements.find((requirement) => {
    const resources = toArray(requirement.craftresource)
      .map((resource) => asRecord(resource))
      .filter(Boolean)

    return resources.every((resource) => {
      const itemId = typeof resource['@uniquename'] === 'string' ? resource['@uniquename'] : ''
      return !itemId.toUpperCase().includes('ARTEFACT_TOKEN_FAVOR')
    })
  })

  return preferred ?? requirements[0]
}

function parseItems(itemsFile, nameMap, knownMarketItemIds) {
  const itemsRoot = asRecord(itemsFile.items)
  if (!itemsRoot) {
    return []
  }

  const byId = new Map()

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
      if (!itemId || byId.has(itemId)) {
        continue
      }

      const craftingCategory = normalizeCategory(rawItem)
      if (shouldExcludeCraftTarget(itemId, craftingCategory)) {
        continue
      }

      const craftingRequirements = chooseCraftingRequirement(rawItem.craftingrequirements)
      const recipe = toArray(craftingRequirements?.craftresource)
        .map((resource) => asRecord(resource))
        .filter((resource) => resource !== null)
        .map((resource) => {
          const resourceId = typeof resource['@uniquename'] === 'string' ? resource['@uniquename'] : ''
          const count = parseNumber(resource['@count'], 0)

          return {
            itemId: resourceId,
            count,
            displayName: nameMap.get(resourceId) ?? resourceId,
          }
        })
        .filter((resource) => resource.itemId.length > 0 && resource.count > 0)

      if (recipe.length === 0) {
        continue
      }

      const availableEnchantments = [0]
      for (const enchantment of [1, 2, 3, 4]) {
        if (resolveMarketIdForEnchantment(itemId, enchantment, knownMarketItemIds)) {
          availableEnchantments.push(enchantment)
        }
      }

      const tier = parseNumber(rawItem['@tier'], Number.NaN)

      byId.set(itemId, {
        itemId,
        displayName: nameMap.get(itemId) ?? itemId,
        tier: Number.isFinite(tier) ? tier : null,
        craftingCategory,
        weight: parseNumber(rawItem['@weight'], 0),
        itemValue: parseNumber(rawItem['@itemvalue'], 0),
        recipe,
        availableEnchantments,
      })
    }
  }

  return [...byId.values()]
}

function parseCityProfiles(modifiersFile, worldMap) {
  const rawLocations = toArray(modifiersFile.craftingmodifiers?.craftinglocation)
  const byClusterId = new Map()

  for (const rawLocation of rawLocations) {
    const location = asRecord(rawLocation)
    if (!location) {
      continue
    }

    const clusterId = typeof location['@clusterid'] === 'string' ? location['@clusterid'] : ''
    if (!ROYAL_CLUSTER_IDS.includes(clusterId)) {
      continue
    }

    const craftingBonus = asRecord(location.craftingbonus)
    const categoryBonuses = {}

    for (const rawModifier of toArray(location.craftingmodifier)) {
      const modifier = asRecord(rawModifier)
      if (!modifier) {
        continue
      }

      const category = typeof modifier['@name'] === 'string' ? modifier['@name'] : ''
      if (!category) {
        continue
      }

      categoryBonuses[category] = parseNumber(modifier['@value'], 0)
    }

    byClusterId.set(clusterId, {
      clusterId,
      cityName: worldMap.get(clusterId) ?? clusterId,
      baseCraftBonus: parseNumber(craftingBonus?.['@value'], 0),
      categoryBonuses,
    })
  }

  return ROYAL_CLUSTER_IDS.map((clusterId) => byClusterId.get(clusterId)).filter(Boolean)
}

async function main() {
  const publicDir = path.join(projectRoot, 'public')
  const [itemsRaw, itemsText, modifiersRaw, worldText] = await Promise.all([
    readFile(path.join(publicDir, 'items.json'), 'utf8'),
    readFile(path.join(publicDir, 'items.txt'), 'utf8'),
    readFile(path.join(publicDir, 'craftingmodifiers.json'), 'utf8'),
    readFile(path.join(publicDir, 'world.txt'), 'utf8'),
  ])

  const itemsFile = JSON.parse(itemsRaw)
  const modifiersFile = JSON.parse(modifiersRaw)
  const { nameMap, knownMarketItemIds } = parseItemsTextData(itemsText)
  const worldMap = parseWorldMap(worldText)

  const items = parseItems(itemsFile, nameMap, knownMarketItemIds)
  const cityProfiles = parseCityProfiles(modifiersFile, worldMap)

  const cleanedData = {
    generatedAt: new Date().toISOString(),
    items,
    cityProfiles,
    knownMarketItemIds: [...knownMarketItemIds],
  }

  await writeFile(path.join(publicDir, 'crafting-data.json'), JSON.stringify(cleanedData))

  const rawBytes = Buffer.byteLength(itemsRaw) + Buffer.byteLength(modifiersRaw) + Buffer.byteLength(worldText)
  const cleanBytes = Buffer.byteLength(JSON.stringify(cleanedData))
  const reduction = ((1 - cleanBytes / rawBytes) * 100).toFixed(1)

  console.log(`Wrote public/crafting-data.json with ${items.length} items and ${cityProfiles.length} cities.`)
  console.log(`Source bytes: ${rawBytes.toLocaleString()} | Clean bytes: ${cleanBytes.toLocaleString()} | Reduced: ${reduction}%`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
