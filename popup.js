let settingsLoaded = false
let pricesLoaded = false

//Things to do once popup has loaded
document.addEventListener('DOMContentLoaded', function () {
    var fuelConsumptionInput = document.getElementById('fuelConsumption')
    var fuelTypeSelect = document.getElementById('fuelType')
    var saveButton = document.getElementById('saveButton')
    var formStatus = document.getElementById('formStatus')
    var fuelPriceInfo = document.getElementById('fuelPriceInfo')
    var settingsPanel = document.getElementById('settingsPanel')
    var initialLoading = document.getElementById('initialLoading')
    var isInitialSetup = false

    chrome.storage.sync.get(['fuelConsumption', 'fuelType'], function (items) {
        if (chrome.runtime.lastError) {
            formStatus.textContent = 'Podešavanja nisu mogla da se učitaju.'
            formStatus.classList.add('error')
            saveButton.disabled = true
            settingsLoaded = true
            revealSettingsWhenReady()
            return
        }
        isInitialSetup = !items.fuelConsumption || !items.fuelType
        if (items.fuelConsumption) {
            fuelConsumptionInput.value = items.fuelConsumption
        }
        if (items.fuelType === 'diesel') {
            fuelTypeSelect.value = 'diesel'
        } else if (items.fuelType === 'lpg') {
            fuelTypeSelect.value = 'petrol'
            chrome.storage.sync.set({ fuelType: 'petrol' }, function () {
                if (chrome.runtime.lastError) {
                    console.error('Nije moguće ažurirati sačuvani izbor goriva:', chrome.runtime.lastError.message)
                }
            })
        }
        settingsLoaded = true
        revealSettingsWhenReady()
    })

    chrome.runtime.sendMessage({ type: 'getSerbiaFuelPrices' }, function (prices) {
        if (chrome.runtime.lastError) {
            console.error('Nije moguće učitati cene goriva:', chrome.runtime.lastError.message)
            showFuelPriceError()
        } else if (!prices || prices.error) {
            showFuelPriceError()
        } else {
            showFuelPrices(prices)
        }
        pricesLoaded = true
        revealSettingsWhenReady()
    })

    document.getElementById('fuelForm').addEventListener('submit', function (event) {
        event.preventDefault()
        if (!settingsLoaded) {
            formStatus.textContent = 'Sačekajte da se podešavanja učitaju.'
            formStatus.classList.add('error')
            return
        }

        saveButton.disabled = true
        formStatus.textContent = ''
        formStatus.classList.remove('error')

        chrome.storage.sync.set(
            {
                fuelConsumption: Number(fuelConsumptionInput.value),
                fuelType: fuelTypeSelect.value,
            },
            function () {
                if (chrome.runtime.lastError) {
                    formStatus.textContent = 'Čuvanje nije uspelo. Pokušajte ponovo.'
                    formStatus.classList.add('error')
                    saveButton.disabled = false
                    return
                }

                saveButton.textContent = 'Sačuvano'
                formStatus.textContent = 'Podešavanja su sačuvana.'
                chrome.runtime.sendMessage({ type: 'getSerbiaFuelPrices' }, function (prices) {
                    if (chrome.runtime.lastError) {
                        console.error('Nije moguće unapred učitati cene goriva:', chrome.runtime.lastError.message)
                    } else if (prices?.error) {
                        console.error('Nije moguće unapred učitati cene goriva:', prices.error)
                    }
                })

                if (isInitialSetup) {
                    chrome.tabs.create({ url: 'https://www.google.com/maps' }, function () {
                        if (chrome.runtime.lastError) {
                            console.error('Google mape nisu mogle da se otvore:', chrome.runtime.lastError.message)
                        }
                    })
                    isInitialSetup = false
                }

                setTimeout(closeSettings, 500)
            }
        )
    })
})

function revealSettingsWhenReady() {
    if (!document.getElementById('settingsPanel') || !pricesLoaded || !settingsLoaded) {
        return
    }
    document.getElementById('initialLoading').hidden = true
    document.getElementById('settingsPanel').hidden = false
}

function showFuelPriceError() {
    var fuelPriceInfo = document.getElementById('fuelPriceInfo')
    fuelPriceInfo.replaceChildren()
    var message = document.createElement('span')
    message.textContent = 'Aktuelne cene goriva nisu dostupne.'
    fuelPriceInfo.appendChild(message)
}

function showFuelPrices(prices) {
    var fuelPriceInfo = document.getElementById('fuelPriceInfo')
    fuelPriceInfo.replaceChildren()

    const priceFormatter = new Intl.NumberFormat('sr-Latn-RS', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })
    const createPriceLine = (label, price) => {
        const line = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = `${label}: `
        line.append(name, `${priceFormatter.format(price)} RSD/l`)
        return line
    }

    const petrol = createPriceLine('Benzin', prices.petrol)
    const diesel = createPriceLine('Dizel', prices.diesel)
    fuelPriceInfo.append(petrol, diesel)

    if (prices.fallback) {
        var fallback = document.createElement('span')
        fallback.className = 'price-validity'
        fallback.textContent = 'Privremene procenjene cene: zvanični cenovnik trenutno nije dostupan.'
        fuelPriceInfo.appendChild(fallback)
        var retry = document.createElement('span')
        retry.className = 'price-validity'
        retry.textContent = 'Ponovni pokušaj učitavanja za 15 minuta.'
        fuelPriceInfo.appendChild(retry)
    } else if (prices.validFrom) {
        var validity = document.createElement('span')
        validity.className = 'price-validity'
        validity.textContent = `Važe od: ${prices.validFrom}`
        fuelPriceInfo.appendChild(validity)
    } else {
        var noDate = document.createElement('span')
        noDate.className = 'price-validity'
        noDate.textContent = 'Datum stupanja na snagu nije pronađen u obaveštenju.'
        fuelPriceInfo.appendChild(noDate)
    }
    if (!prices.fallback) {
        var source = document.createElement('span')
        source.className = 'price-validity'
        source.textContent = 'Izvor: Ministarstvo unutrašnje i spoljne trgovine Republike Srbije'
        fuelPriceInfo.appendChild(source)
    }
    if (prices.stale) {
        var stale = document.createElement('span')
        stale.className = 'price-validity'
        stale.textContent = 'Prikazane su poslednje sačuvane cene.'
        fuelPriceInfo.appendChild(stale)
    }
}

function closeSettings() {
    chrome.tabs.getCurrent(function (tab) {
        if (tab?.id) {
            chrome.tabs.remove(tab.id)
        } else {
            window.close()
        }
    })
}
