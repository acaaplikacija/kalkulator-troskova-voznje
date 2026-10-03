chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check if the tab's status is 'complete'
    if (changeInfo.status === 'complete') {
        // Perform your URL check and other actions here
        if (tab.url && tab.url.includes('dir')) {
            chrome.tabs.sendMessage(tabId, {
                message: 'dir tab found',
            })
        }
    }
})

const fuelRefreshAlarm = 'serbia-fuel-price-refresh'
const fallbackFuelPrices = { petrol: 107, diesel: 236 }
const fallbackFuelPriceRetryMs = 15 * 60 * 1000
const belgradeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
})
const weekdayNumbers = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function getBelgradeParts(date) {
    return Object.fromEntries(
        belgradeFormatter.formatToParts(date).map(({ type, value }) => [type, value])
    )
}

function belgradeWallTimeToDate(year, month, day, hour, minute) {
    const targetWallTime = Date.UTC(year, month - 1, day, hour, minute)
    let timestamp = targetWallTime

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const parts = getBelgradeParts(new Date(timestamp))
        const representedWallTime = Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute),
            Number(parts.second)
        )
        timestamp += targetWallTime - representedWallTime
    }

    return new Date(timestamp)
}

function getNextFridayAtFiveBelgrade(now = new Date()) {
    const parts = getBelgradeParts(now)
    const daysUntilFriday = (5 - weekdayNumbers[parts.weekday] + 7) % 7
    const belgradeDate = new Date(
        Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + daysUntilFriday)
    )
    let nextRefresh = belgradeWallTimeToDate(
        belgradeDate.getUTCFullYear(),
        belgradeDate.getUTCMonth() + 1,
        belgradeDate.getUTCDate(),
        17,
        0
    )

    if (nextRefresh <= now) {
        belgradeDate.setUTCDate(belgradeDate.getUTCDate() + 7)
        nextRefresh = belgradeWallTimeToDate(
            belgradeDate.getUTCFullYear(),
            belgradeDate.getUTCMonth() + 1,
            belgradeDate.getUTCDate(),
            17,
            0
        )
    }

    return nextRefresh.getTime()
}

function scheduleNextFuelRefresh() {
    chrome.alarms.create(fuelRefreshAlarm, { when: getNextFridayAtFiveBelgrade() })
}

function notifyGoogleMapsTabs() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            if (tab.id && /^https:\/\/www\.google\.[^/]+\/maps\//i.test(tab.url || '')) {
                chrome.tabs.sendMessage(tab.id, { type: 'fuelPricesUpdated' }, () => {
                    void chrome.runtime.lastError
                })
            }
        })
    })
}

let fuelPriceRefreshInProgress = false
let fuelPriceRefreshCallbacks = []

function completeFuelPriceRefresh(prices) {
    const callbacks = fuelPriceRefreshCallbacks
    fuelPriceRefreshCallbacks = []
    fuelPriceRefreshInProgress = false
    callbacks.forEach((callback) => callback(prices))
}

async function fetchFuelSourceText(url) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
        const response = await fetch(url, { signal: controller.signal })
        return {
            ok: response.ok,
            status: response.status,
            text: await response.text(),
        }
    } finally {
        clearTimeout(timeoutId)
    }
}

function refreshSerbiaFuelPrices(sendResponse) {
    if (sendResponse) {
        fuelPriceRefreshCallbacks.push(sendResponse)
    }
    if (fuelPriceRefreshInProgress) {
        return
    }
    fuelPriceRefreshInProgress = true

    chrome.storage.local.get('serbiaFuelPrices', async ({ serbiaFuelPrices }) => {
        try {
            const listingResponse = await fetchFuelSourceText('https://must.gov.rs/vesti/sr/')
            if (!listingResponse.ok) {
                throw new Error(`Ministarstvo je vratilo status ${listingResponse.status}`)
            }

            const listingHtml = listingResponse.text
            const noticeMatch = listingHtml.match(
                /href=["']([^"']*\/vest\/sr\/\d+\/[^"']*obavestenje-o-najvisoj-maloprodajnoj-ceni[^"']*\.php)["']/i
            )
            if (!noticeMatch) {
                throw new Error('Nije pronađeno poslednje zvanično obaveštenje o cenama goriva')
            }

            const sourceUrl = new URL(noticeMatch[1], 'https://must.gov.rs').href
            const noticeResponse = await fetchFuelSourceText(sourceUrl)
            if (!noticeResponse.ok) {
                throw new Error(`Obaveštenje je vratilo status ${noticeResponse.status}`)
            }

            const noticeHtml = noticeResponse.text
            const noticeText = noticeHtml
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;|&#160;/gi, ' ')
                .replace(/&amp;/gi, '&')
                .replace(/\s+/g, ' ')

            const dieselMatch = noticeText.match(
                /EVRO\s+DIZEL[\s\S]{0,120}?iznosu\s+([\d.]+,\d{2})\s+dinara/i
            )
            const petrolMatch = noticeText.match(
                /EVRO\s+PREMIJUM\s+BMB\s+95[\s\S]{0,120}?iznosu\s+([\d.]+,\d{2})\s+dinara/i
            )
            if (!dieselMatch || !petrolMatch) {
                throw new Error('Cene goriva nisu prepoznate u zvaničnom obaveštenju')
            }

            const parsePrice = (value) => Number(value.replace(/\./g, '').replace(',', '.'))
            const validFromMatch = noticeText.match(
                /period\s+od\s+15\s+časova\s+(\d{1,2}\.\s*[\p{L}]+\s+\d{4})/iu
            )
            const validUntilMatch = noticeText.match(/do\s+15\s+časova\s+(\d{1,2}\.\s+[\p{L}]+\s+\d{4})/iu)
            const refreshedAt = Date.now()
            const prices = {
                petrol: parsePrice(petrolMatch[1]),
                diesel: parsePrice(dieselMatch[1]),
                validFrom: validFromMatch?.[1] || null,
                validUntil: validUntilMatch?.[1] || null,
                sourceUrl,
                fetchedAt: refreshedAt,
                nextRefreshAt: getNextFridayAtFiveBelgrade(new Date(refreshedAt)),
            }

            chrome.storage.local.set({ serbiaFuelPrices: prices }, () => {
                completeFuelPriceRefresh(prices)
                notifyGoogleMapsTabs()
            })
        } catch (error) {
            console.error('Greška pri učitavanju cena goriva:', error)
            if (serbiaFuelPrices) {
                const stalePrices = serbiaFuelPrices.fallback
                    ? {
                        ...serbiaFuelPrices,
                        nextRefreshAt: Date.now() + fallbackFuelPriceRetryMs,
                    }
                    : {
                        ...serbiaFuelPrices,
                        stale: true,
                        nextRefreshAt: getNextFridayAtFiveBelgrade(),
                    }
                chrome.storage.local.set({ serbiaFuelPrices: stalePrices })
                completeFuelPriceRefresh(stalePrices)
                notifyGoogleMapsTabs()
            } else {
                const fallbackPrices = {
                    ...fallbackFuelPrices,
                    fallback: true,
                    fetchedAt: Date.now(),
                    nextRefreshAt: Date.now() + fallbackFuelPriceRetryMs,
                }
                chrome.storage.local.set({ serbiaFuelPrices: fallbackPrices }, () => {
                    completeFuelPriceRefresh(fallbackPrices)
                    notifyGoogleMapsTabs()
                })
            }
        }
    })
}

function initializeFuelRefresh() {
    chrome.storage.local.get('serbiaFuelPrices', ({ serbiaFuelPrices }) => {
        if (!Number.isFinite(serbiaFuelPrices?.petrol) || !Number.isFinite(serbiaFuelPrices?.diesel) ||
            Date.now() >= serbiaFuelPrices.nextRefreshAt) {
            refreshSerbiaFuelPrices((prices) => {
                chrome.alarms.create(fuelRefreshAlarm, {
                    when: prices?.nextRefreshAt || getNextFridayAtFiveBelgrade(),
                })
            })
        } else {
            chrome.alarms.create(fuelRefreshAlarm, { when: serbiaFuelPrices.nextRefreshAt })
        }
    })
}

chrome.runtime.onInstalled.addListener((details) => {
    initializeFuelRefresh()
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') })
    }
})
chrome.runtime.onStartup.addListener(initializeFuelRefresh)

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === fuelRefreshAlarm) {
        refreshSerbiaFuelPrices((prices) => {
            chrome.alarms.create(fuelRefreshAlarm, {
                when: prices?.nextRefreshAt || getNextFridayAtFiveBelgrade(),
            })
        })
    }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'getSerbiaFuelPrices') {
        return
    }

    chrome.storage.local.get('serbiaFuelPrices', ({ serbiaFuelPrices }) => {
        if (Number.isFinite(serbiaFuelPrices?.petrol) && Number.isFinite(serbiaFuelPrices?.diesel) &&
            Date.now() < serbiaFuelPrices.nextRefreshAt) {
            sendResponse(serbiaFuelPrices)
            return
        }

        refreshSerbiaFuelPrices(sendResponse)
    })

    return true
})
