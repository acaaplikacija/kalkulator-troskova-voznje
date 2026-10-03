let routeScanTimer

function parseDistanceKm(text) {
    const match = text.match(/([\d.,\s\u00a0]+)\s*(miles?|mi|km|χλμ\.?)/i)
    if (!match) {
        return null
    }

    let rawDistance = match[1].replace(/[\s\u00a0]/g, '')
    const lastComma = rawDistance.lastIndexOf(',')
    const lastPeriod = rawDistance.lastIndexOf('.')

    if (lastComma !== -1 && lastPeriod !== -1) {
        const decimalSeparator = lastComma > lastPeriod ? ',' : '.'
        const thousandsSeparator = decimalSeparator === ',' ? /\./g : /,/g
        rawDistance = rawDistance.replace(thousandsSeparator, '')
        rawDistance = rawDistance.replace(decimalSeparator, '.')
    } else if (lastComma !== -1) {
        rawDistance = /,\d{3}$/.test(rawDistance)
            ? rawDistance.replace(/,/g, '')
            : rawDistance.replace(',', '.')
    } else if (/\.\d{3}$/.test(rawDistance)) {
        rawDistance = rawDistance.replace('.', '')
    }

    const distance = Number(rawDistance)
    if (!Number.isFinite(distance)) {
        return null
    }

    return /miles?|mi/i.test(match[2]) ? distance * 1.609344 : distance
}

function createCostRow() {
    const row = document.createElement('div')
    row.className = 'FuelCost'

    const heading = document.createElement('div')
    heading.className = 'fuel-cost-heading'

    const icon = document.createElement('img')
    icon.className = 'fuel-cost-icon'
    icon.src = chrome.runtime.getURL('128icon.png')
    icon.alt = ''
    icon.setAttribute('aria-hidden', 'true')
    heading.appendChild(icon)

    const summary = document.createElement('span')
    summary.className = 'fuel-cost-summary'
    summary.textContent = 'Гориво: учитавање...'
    heading.appendChild(summary)
    row.appendChild(heading)

    const breakdown = document.createElement('span')
    breakdown.className = 'fuel-cost-breakdown'
    row.appendChild(breakdown)
    return row
}

function updateFuelCost(distanceKm, row) {
    chrome.storage.sync.get(['fuelConsumption', 'fuelType'], function (settings) {
        if (!row.isConnected) {
            return
        }

        const summary = row.querySelector('.fuel-cost-summary')
        const breakdown = row.querySelector('.fuel-cost-breakdown')
        const fuelType = settings.fuelType === 'diesel' ? 'diesel' : 'petrol'
        const settingsKey = `${distanceKm}|${settings.fuelConsumption}|${fuelType}`

        if (!settings.fuelConsumption || !settings.fuelType) {
            if (row.dataset.calculationKey === settingsKey) {
                return
            }
            row.dataset.calculationKey = settingsKey
            row.dataset.requestKey = settingsKey
            summary.textContent = 'Гориво: подесите возило'
            breakdown.textContent = ''
            return
        }

        if (row.dataset.requestKey === settingsKey) {
            return
        }
        row.dataset.requestKey = settingsKey
        summary.textContent = 'Гориво: учитавање...'
        breakdown.textContent = ''
        chrome.runtime.sendMessage({ type: 'getSerbiaFuelPrices' }, function (prices) {
            if (!row.isConnected) {
                return
            }

            if (chrome.runtime.lastError || !prices || prices.error) {
                summary.textContent = 'Гориво: цена није доступна'
                breakdown.textContent = ''
                return
            }

            const price = prices[fuelType]
            if (!Number.isFinite(price)) {
                summary.textContent = 'Гориво: цена није доступна'
                breakdown.textContent = ''
                return
            }

            const calculationKey = `${settingsKey}|${prices.fetchedAt}`
            if (row.dataset.calculationKey === calculationKey) {
                return
            }

            const cost = (distanceKm / 100) * Number(settings.fuelConsumption) * price
            const formattedCost = new Intl.NumberFormat('sr-RS', {
                style: 'currency',
                currency: 'RSD',
                maximumFractionDigits: 0,
            }).format(cost)
            const liters = (distanceKm / 100) * Number(settings.fuelConsumption)
            const formattedLiters = new Intl.NumberFormat('sr-RS', {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
            }).format(liters)
            const formattedPrice = new Intl.NumberFormat('sr-RS', {
                maximumFractionDigits: 2,
            }).format(price)
            row.dataset.calculationKey = calculationKey
            summary.textContent = `Гориво: ${formattedCost}`
            breakdown.textContent = `${formattedLiters}l (${formattedPrice} RSD/l)`
        })
    })
}

function scanRoutes() {
    document.querySelectorAll('.ivN21e.tUEI8e.fontBodyMedium').forEach(function (distanceDiv) {
        const distanceKm = parseDistanceKm(distanceDiv.textContent)
        if (distanceKm === null) {
            return
        }

        const host = distanceDiv.parentElement
        if (!host) {
            return
        }

        let rows = [...host.querySelectorAll(':scope > .FuelCost')]
        let result = rows.shift()
        rows.forEach((duplicate) => duplicate.remove())
        if (!result) {
            result = createCostRow()
            distanceDiv.insertAdjacentElement('afterend', result)
        }

        updateFuelCost(distanceKm, result)
    })
}

function scheduleRouteScan() {
    clearTimeout(routeScanTimer)
    routeScanTimer = setTimeout(scanRoutes, 250)
}

chrome.runtime.onMessage.addListener(function (message) {
    if (message.message === 'dir tab found' || message.type === 'fuelPricesUpdated') {
        if (message.type === 'fuelPricesUpdated') {
            document.querySelectorAll('.FuelCost').forEach((row) => {
                delete row.dataset.calculationKey
                delete row.dataset.requestKey
            })
        }
        scheduleRouteScan()
    }
})

chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'sync' && (changes.fuelConsumption || changes.fuelType)) {
        document.querySelectorAll('.FuelCost').forEach((row) => {
            delete row.dataset.calculationKey
            delete row.dataset.requestKey
        })
        scheduleRouteScan()
    }
})

new MutationObserver(scheduleRouteScan).observe(document.body, {
    childList: true,
    subtree: true,
})

scheduleRouteScan()