/** @odoo-module **/
import { Interaction } from "@web/public/interaction";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
class YazbekVariantMatrix extends Interaction {
    static selector = ".o_wsale_product_page #product_details";
    async start() {
        this._matrixCreated = false;
        this._infoCache = new Map();
        // Almacén de precios y stock por lista, obtenido en bloques de 25.
        this._batchPrices = new Map();
        this._batchPromise = null;
        this._batchTemplateId = 0;
        this._batchRequests = 0;
        this._infoTimers = new Map();
        // Máximo de llamadas RPC simultáneas por visitante.
        this._infoMaxParallel = 3;
        this._infoQueue = [];
        this._infoRunning = 0;
        this._infoIdleResolvers = [];
        this._destroyed = false;
        this._dirtyInputs = new Set();
        this._matrixLoadInProgress = false;
        this._matrixInfoLoadedPricelistId = 0;
        // Estas dos opciones provienen del website activo (no de la compañía global).
        const websiteFlags = document.documentElement.dataset;
        this._matrixModeSetting = ["units", "boxes", "both"].includes(
            websiteFlags.yazbekMatrixSaleMode
        ) ? websiteFlags.yazbekMatrixSaleMode : "units";
        this._saleMode = this._matrixModeSetting === "boxes" ? "boxes" : "units";
        this._batchPriceMode = null;
        this._modeSwitchInProgress = false;
        this._showWebsiteAvailability = websiteFlags.yazbekShowAvailability !== "0";
        this._showWebsitePriceDecimals = websiteFlags.yazbekPriceDecimals !== "0";
        this._websiteCurrency = websiteFlags.yazbekCurrency || "MXN";
        this._websiteLocale = websiteFlags.yazbekLocale || "es-MX";
        this._pricingConfig = this._readPricingConfig();
        this._activePricelistId = 0;
        this._pricingTimer = null;
        this._pricingSwitchPromise = null;

        // Precio de referencia ("Desde") por lista de precios.
        // Permite mostrar Menudeo y Mayoreo simultáneamente.
        this._referencePriceCache = new Map();
        this._referencePriceLoadPromise = null;

        this._cartBaseUnits = this._readInitialCartBaseUnits();
        this._hideStandardPurchaseControls();
        this._hideStandardStockMessage();
        await this._buildMatrix();
        this._hideStandardPurchaseControls();
        this._hideStandardStockMessage();
        this._observer = new MutationObserver(() => {
            this._hideStandardPurchaseControls();
            this._hideStandardStockMessage();
        });
        this._observer.observe(this.el, {
            childList: true,
            subtree: true,
        });
    }
    destroy() {
        this._destroyed = true;
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }
        for (const timer of this._infoTimers.values()) {
            clearTimeout(timer);
        }
        this._infoTimers.clear();
        for (const task of this._infoQueue.splice(0)) {
            task.reject(new Error("La página fue cerrada"));
        }
        this._dirtyInputs.clear();
        this._notifyInfoIdle();
        if (this._pricingTimer) {
            clearTimeout(this._pricingTimer);
            this._pricingTimer = null;
        }
        super.destroy();
    }
    _hideStandardPurchaseControls() {
        const wrappers =
            document.querySelectorAll(
                ".o_wsale_product_page #o_wsale_cta_wrapper"
            );
        for (const wrapper of wrappers) {
            wrapper.style.setProperty(
                "display",
                "none",
                "important"
            );
            wrapper.setAttribute(
                "aria-hidden",
                "true"
            );
        }
    }
    _hideStandardStockMessage() {
        const selectors = [
            ".o_wsale_product_page .o_product_unavailable",
            ".o_wsale_product_page .o_wsale_product_unavailable",
            ".o_wsale_product_page .out_of_stock",
            ".o_wsale_product_page .o_stock_notification_form",
            ".o_wsale_product_page .o_wsale_stock_notification",
        ];
        for (const selector of selectors) {
            const elements =
                document.querySelectorAll(selector);
            for (const element of elements) {
                element.style.display = "none";
            }
        }
    }
    _formatPrice(value) {
        const decimals = this._showWebsitePriceDecimals ? 2 : 0;
        return new Intl.NumberFormat(
            this._websiteLocale,
            {
                style: "currency",
                currency: this._websiteCurrency,
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals,
            }
        ).format(Number(value || 0));
    }
    _formatStock(value) {
        const qty =
            Number(value || 0);
        if (
            Math.abs(
                qty - Math.round(qty)
            ) < 0.000001
        ) {
            return String(
                Math.round(qty)
            );
        }
        return qty.toLocaleString(
            "es-MX",
            {
                maximumFractionDigits: 2,
            }
        );
    }
    _readPricingConfig() {
        const dataContainer =
            this.el.querySelector(
                "#yazbek-variant-matrix-data"
            );
        const customerPricelistId =
            Number(
                dataContainer?.dataset?.customerPricelistId ||
                0
            );
        const customerPricelistName =
            String(
                dataContainer?.dataset?.customerPricelistName ||
                ""
            ).trim();
        const retailPricelistId =
            Number(
                dataContainer?.dataset?.retailPricelistId ||
                0
            );
        const wholesalePricelistId =
            Number(
                dataContainer?.dataset?.wholesalePricelistId ||
                0
            );
        const wholesaleMinQty =
            Math.max(
                Number(
                    dataContainer?.dataset?.wholesaleMinQty ||
                    12
                ),
                1
            );
        return {
            customerPricelistId,
            customerPricelistName,
            retailPricelistId,
            wholesalePricelistId,
            wholesaleMinQty,
        };
    }
    _isSpecialCustomerPricelist() {
        const name =
            String(
                this._pricingConfig?.customerPricelistName ||
                ""
            )
                .trim()
                .toLowerCase();
        return [
            "descuento 14%",
            "descuento 14% (clp)",
        ].includes(name);
    }
    _readCartQuantityFromDom() {
        const element =
            document.querySelector(
                ".my_cart_quantity"
            );
        const text =
            String(
                element?.textContent ||
                "0"
            )
                .replace(/[^0-9.,-]/g, "")
                .replace(",", ".");
        const qty =
            Number(text || 0);
        return Number.isFinite(qty)
            ? Math.max(qty, 0)
            : 0;
    }
    _readInitialCartBaseUnits() {
        const cartQty =
            this._readCartQuantityFromDom();
        if (cartQty <= 0) {
            try {
                sessionStorage.removeItem(
                    "yazbek_cart_base_units"
                );
            } catch {
            }
            return 0;
        }
        try {
            const stored =
                Number(
                    sessionStorage.getItem(
                        "yazbek_cart_base_units"
                    ) ||
                    0
                );
            if (
                Number.isFinite(stored) &&
                stored > 0
            ) {
                return stored;
            }
        } catch {
        }
        return cartQty;
    }
    _storeCartBaseUnits() {
        try {
            if (this._cartBaseUnits > 0) {
                sessionStorage.setItem(
                    "yazbek_cart_base_units",
                    String(this._cartBaseUnits)
                );
            } else {
                sessionStorage.removeItem(
                    "yazbek_cart_base_units"
                );
            }
        } catch {
        }
    }
    _getPackagingUnits(packagingName) {
        // El HTML es una pista para mostrar el empaque; el servidor valida
        // x_studio_embalaje_variante en la primera respuesta por lotes.
        const match = String(packagingName || "").match(/\d+(?:[.,]\d+)?/);
        if (!match) return 0;
        const units = Number(match[0].replace(",", "."));
        return Number.isSafeInteger(units) && units > 0 ? units : 0;
    }
    _getBaseUnitFactor(input) {
        return input.dataset.saleMode === "boxes"
            ? Number(input.dataset.packagingUnits || 0) : 1;
    }
    _getAvailableModeQty(input, availableBaseUnits = null) {
        const remaining = Math.max(0, Number(
            availableBaseUnits ?? input.dataset.availableQty ?? 0
        ));
        const factor = this._getBaseUnitFactor(input);
        return factor > 0 ? Math.max(0, Math.floor((remaining + 1e-8) / factor)) : 0;
    }
    _updateModeLabel(input) {
        const label = input.closest("td")?.querySelector(".yazbek-matrix-uom");
        if (!label) return;
        const pack = Number(input.dataset.packagingUnits || 0);
        label.textContent = input.dataset.saleMode === "boxes"
            ? (pack > 0 ? `Caja (${pack} pzas.)` : "Sin embalaje configurado")
            : "Unidades";
    }
    _showStockForInput(input, availableBaseUnits, showAvailability) {
        const label = input.closest("td")?.querySelector(".yazbek-matrix-stock");
        if (!label) return;
        const stockMode = this._getAvailableModeQty(input, availableBaseUnits);
        label.classList.remove("text-danger", "text-success", "text-muted");
        if (!this._showWebsiteAvailability || !showAvailability) {
            label.textContent = "";
            label.style.display = "none";
            return;
        }
        label.style.display = "";
        const suffix = input.dataset.saleMode === "boxes" ? "cajas" : "unidades";
        label.textContent = `Disponible: ${this._formatStock(stockMode)} ${suffix}`;
        label.classList.add(stockMode > 0 ? "text-success" : "text-muted");
    }
    async _switchSaleMode(mode, wrapper, templateId, updateSummary) {
        if (this._modeSwitchInProgress || mode === this._saleMode) return;
        const inputs = [...wrapper.querySelectorAll(".yazbek-matrix-qty")];
        const hasSelection = inputs.some(input => Number(input.value || 0) > 0);
        if (hasSelection && !window.confirm(
            "Al cambiar entre Unidades y Cajas se reiniciarán las cantidades seleccionadas. ¿Continuar?"
        )) return;
        this._modeSwitchInProgress = true;
        // No descartar una carga por lotes que aún esté ejecutándose.
        if (this._batchPromise) {
            try { await this._batchPromise; } catch (_error) { /* Se recargará el lote. */ }
        }
        for (const button of wrapper.querySelectorAll(".yazbek-matrix-mode-button")) {
            button.disabled = true;
        }
        if (this._pricingTimer) clearTimeout(this._pricingTimer);
        this._pricingTimer = null;
        for (const timer of this._infoTimers.values()) clearTimeout(timer);
        this._infoTimers.clear();
        this._dirtyInputs.clear();
        this._saleMode = mode;
        this._batchPriceMode = null;
        this._batchTemplateId = 0;
        this._batchPrices.clear();
        this._referencePriceCache.clear();
        for (const input of inputs) {
            input.value = "0";
            input.dataset.saleMode = mode;
            input.dataset.priceAvailable = "0";
            input.disabled = true;
            this._updateModeLabel(input);
        }
        this._updateModeButtons(wrapper);
        updateSummary();
        try {
            await this._applyPricingForSelection(wrapper, templateId, {reloadAll: true});
        } catch (error) {
            console.error("Yazbek Matrix: no se pudo cargar el modo", mode, error);
        } finally {
            this._modeSwitchInProgress = false;
            for (const button of wrapper.querySelectorAll(".yazbek-matrix-mode-button")) {
                button.disabled = false;
            }
        }
    }
    _updateModeButtons(wrapper) {
        for (const button of wrapper.querySelectorAll(".yazbek-matrix-mode-button")) {
            const active = button.dataset.mode === this._saleMode;
            button.classList.toggle("btn-primary", active);
            button.classList.toggle("btn-outline-primary", !active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        }
    }
    _getSelectionBaseUnits(wrapper) {
        let total = 0;
        const inputs =
            wrapper.querySelectorAll(
                ".yazbek-matrix-qty"
            );
        for (const input of inputs) {
            if (
                input.disabled ||
                input.dataset.stockCanSell === "0"
            ) {
                continue;
            }
            const qty =
                Math.max(
                    Number(input.value || 0),
                    0
                );
            if (qty <= 0) {
                continue;
            }
            const unitsPerQty = this._getBaseUnitFactor(input);
            if (!Number.isSafeInteger(unitsPerQty) || unitsPerQty < 1) continue;
            total += qty * unitsPerQty;
        }
        return total;
    }
    _getProjectedBaseUnits(wrapper) {
        return Math.max(
            Number(this._cartBaseUnits || 0),
            0
        ) + this._getSelectionBaseUnits(wrapper);
    }
    _getPricingTarget(wrapper) {
        const config =
            this._pricingConfig ||
            {};
        if (this._isSpecialCustomerPricelist()) {
            return {
                pricelistId:
                    Number(
                        config.customerPricelistId ||
                        0
                    ),
                pricelistName:
                    config.customerPricelistName ||
                    "Descuento 14%",
                projectedUnits:
                    this._getProjectedBaseUnits(
                        wrapper
                    ),
                special: true,
            };
        }
        const projectedUnits =
            this._getProjectedBaseUnits(
                wrapper
            );
        const isWholesale =
            projectedUnits >=
            Number(
                config.wholesaleMinQty ||
                12
            );
        return {
            pricelistId:
                isWholesale
                    ? Number(
                        config.wholesalePricelistId ||
                        0
                    )
                    : Number(
                        config.retailPricelistId ||
                        0
                    ),
            pricelistName:
                isWholesale
                    ? "Mayoreo"
                    : "Menudeo",
            projectedUnits,
            special: false,
        };
    }
    // Cola por página: las variantes no saturan todos los workers del servidor.
    _notifyInfoIdle() {
        if (this._infoRunning || this._infoQueue.length) {
            return;
        }
        for (const resolve of this._infoIdleResolvers.splice(0)) {
            resolve();
        }
    }
    _waitForInfoIdle() {
        if (!this._infoRunning && !this._infoQueue.length) {
            return Promise.resolve();
        }
        return new Promise(resolve => this._infoIdleResolvers.push(resolve));
    }
    _runInfoQueue() {
        while (this._infoQueue.length &&
               this._infoRunning < this._infoMaxParallel &&
               !this._destroyed) {
            const task = this._infoQueue.shift();
            this._infoRunning++;
            Promise.resolve()
                .then(task.callback)
                .then(task.resolve, task.reject)
                .finally(() => {
                    this._infoRunning--;
                    this._runInfoQueue();
                    this._notifyInfoIdle();
                });
        }
        this._notifyInfoIdle();
    }
    _enqueueInfoRequest(callback) {
        if (this._destroyed) {
            return Promise.reject(new Error("Página cerrada"));
        }
        return new Promise((resolve, reject) => {
            this._infoQueue.push({ callback, resolve, reject });
            this._runInfoQueue();
        });
    }
    // El cambio de tarifa del pedido lo ejecuta sale.order en el servidor
    // al agregar, cambiar o borrar cantidades. Aquí solo elegimos qué
    // precios mostrar usando el caché de ambas tarifas. Sin GET/redirect.
    _activateDisplayPricelist(pricelistId) {
        const id = Number(pricelistId || 0);
        if (!id) {
            throw new Error("Yazbek Matrix: tarifa no configurada");
        }
        const changed = this._activePricelistId !== id;
        this._activePricelistId = id;
        return changed;
    }
    _updatePriceCardActiveState(
        target,
        loading = false
    ) {
        const card =
            document.querySelector(
                "#yazbek-price-card"
            );

        if (!card) {
            return;
        }

        const retailCard =
            card.querySelector(
                "[data-role='retail-card']"
            );

        const wholesaleCard =
            card.querySelector(
                "[data-role='wholesale-card']"
            );

        const retailActive =
            card.querySelector(
                "[data-role='retail-active']"
            );

        const wholesaleActive =
            card.querySelector(
                "[data-role='wholesale-active']"
            );

        if (
            !retailCard ||
            !wholesaleCard ||
            !retailActive ||
            !wholesaleActive
        ) {
            return;
        }

        if (loading) {
            retailCard.style.opacity = "0.65";
            wholesaleCard.style.opacity = "0.65";
            return;
        }

        retailCard.style.opacity = "1";
        wholesaleCard.style.opacity = "1";

        if (target.special) {
            retailActive.style.display = "none";
            wholesaleActive.style.display = "none";

            retailCard.style.borderTopColor = "transparent";
            wholesaleCard.style.borderTopColor = "transparent";

            retailCard.style.background = "#ffffff";
            wholesaleCard.style.background = "#f3f6fa";
            return;
        }

        const isWholesale =
            target.pricelistName === "Mayoreo";

        retailActive.style.display =
            isWholesale
                ? "none"
                : "inline-block";

        retailCard.style.borderTopColor =
            isWholesale
                ? "transparent"
                : "#003478";

        retailCard.style.background =
            isWholesale
                ? "#f8fafc"
                : "#ffffff";

        wholesaleActive.style.display =
            isWholesale
                ? "inline-block"
                : "none";

        wholesaleCard.style.borderTopColor =
            isWholesale
                ? "#003478"
                : "transparent";

        wholesaleCard.style.background =
            isWholesale
                ? "#ffffff"
                : "#f3f6fa";
    }

    _getReferencePriceFromCells(
        wrapper
    ) {
        if (!wrapper) {
            return 0;
        }

        const cells =
            wrapper.querySelectorAll(
                "td[data-yazbek-variant-cell='1'][data-has-price='1']"
            );

        const prices = [];

        for (const cell of cells) {
            const price =
                Number(
                    cell.dataset.referenceUnitPrice ||
                    0
                );

            if (
                Number.isFinite(price) &&
                price > 0
            ) {
                prices.push(price);
            }
        }

        return prices.length
            ? Math.min(...prices)
            : 0;
    }

    _cacheCurrentReferencePrice(wrapper) {
        // Precios «Desde» del lote son para 1 y 12 piezas, no usar
        // los precios variables de las celdas para sobrescribirlos.
        if (this._batchPrices.size && this._referencePriceCache.size) return;
        const id = Number(this._activePricelistId || 0);
        // «Desde» solo será definitivo una vez consultadas TODAS las variantes.
        if (!id || this._matrixLoadInProgress ||
            this._matrixInfoLoadedPricelistId !== id ||
            this._referencePriceCache.has(id)) {
            return;
        }
        const cells = wrapper?.querySelectorAll(
            "td[data-yazbek-variant-cell='1']"
        ) || [];
        if ([...cells].some(cell => cell.dataset.priceLoaded !== "1")) {
            return;
        }
        const price = this._getReferencePriceFromCells(wrapper);
        if (price > 0) {
            this._referencePriceCache.set(id, price);
        }
    }
    async _fetchReferencePriceForActivePricelist(wrapper, templateId) {
        const inputs = [...wrapper.querySelectorAll(".yazbek-matrix-qty")];
        let nextIndex = 0;
        const prices = [];
        const worker = async () => {
            while (nextIndex < inputs.length) {
                const input = inputs[nextIndex++];
                const productId = Number(input.dataset.productId || 0);
                const uomId = Number(
                    input.dataset.currentUomId || input.dataset.baseUomId || 0
                );
                if (!productId || !uomId) {
                    continue;
                }
                let ptavIds = [];
                try {
                    ptavIds = JSON.parse(input.dataset.ptavIds || "[]");
                } catch { /* combinación vacía */ }
                try {
                    const info = await this._getWebsiteInfo(
                        templateId, productId, ptavIds, uomId, 1
                    );
                    const price = Number(info.price || 0);
                    if (price > 0) {
                        // La cuadrícula opera exclusivamente con unidades.
                        prices.push(price);
                    }
                } catch (error) {
                    console.error("Yazbek Matrix: error precio de referencia", error);
                }
            }
        };
        const count = Math.min(this._infoMaxParallel, inputs.length);
        await Promise.all(Array.from({ length: count }, () => worker()));
        return prices.length ? Math.min(...prices) : 0;
    }
    async _ensureBothReferencePrices(wrapper, templateId) {
        // Ambos «Desde» ya se calcularon con los mismos lotes iniciales.
        this._updateReferencePriceCard(wrapper);
    }
    _updateReferencePriceCard(
        wrapper
    ) {
        const card =
            document.querySelector(
                "#yazbek-price-card"
            );

        if (!card || !wrapper) {
            return;
        }

        const retailPrice =
            card.querySelector(
                "[data-role='retail-price']"
            );

        const wholesalePrice =
            card.querySelector(
                "[data-role='wholesale-price']"
            );

        if (
            !retailPrice ||
            !wholesalePrice
        ) {
            return;
        }

        if (
            this._isSpecialCustomerPricelist()
        ) {
            retailPrice.textContent = "—";
            wholesalePrice.textContent = "—";
            return;
        }

        const config =
            this._pricingConfig ||
            {};

        const retailId =
            Number(
                config.retailPricelistId ||
                0
            );

        const wholesaleId =
            Number(
                config.wholesalePricelistId ||
                0
            );

        this._cacheCurrentReferencePrice(
            wrapper
        );

        const retailValue =
            Number(
                this._referencePriceCache.get(
                    retailId
                ) ||
                0
            );

        const wholesaleValue =
            Number(
                this._referencePriceCache.get(
                    wholesaleId
                ) ||
                0
            );

        if (retailValue > 0) {
            retailPrice.innerHTML =
                `<span style="display:block;">Desde</span>` +
                `<span style="display:block;">${this._formatPrice(retailValue)}</span>`;
        } else {
            retailPrice.textContent =
                "—";
        }

        if (wholesaleValue > 0) {
            wholesalePrice.innerHTML =
                `<span style="display:block;">Desde</span>` +
                `<span style="display:block;">${this._formatPrice(wholesaleValue)}</span>`;
        } else {
            wholesalePrice.textContent =
                "—";
        }
    }


    _updatePricingStatus(
        wrapper,
        target,
        loading = false
    ) {
        const element =
            wrapper.querySelector(
                ".yazbek-pricing-status"
            );

        this._updatePriceCardActiveState(
            target,
            loading
        );

        if (!element) {
            return;
        }

        if (loading) {
            element.textContent =
                "Actualizando precio...";
            return;
        }

        if (target.special) {
            element.textContent =
                `Tarifa: ${target.pricelistName}`;
            return;
        }

        const threshold =
            Number(
                this._pricingConfig?.wholesaleMinQty ||
                12
            );

        element.textContent =
            target.pricelistName === "Mayoreo"
                ? `Tarifa: Mayoreo · ${this._formatStock(target.projectedUnits)} piezas consideradas`
                : `Tarifa: Menudeo · Mayoreo desde ${this._formatStock(threshold)} piezas`;
    }
    async _applyPricingForSelection(wrapper, templateId, { reloadAll = true } = {}) {
        const target = this._getPricingTarget(wrapper);
        this._updatePricingStatus(wrapper, target, true);
        try {
            const changed = this._activateDisplayPricelist(target.pricelistId);
            // Los precios de la otra tarifa ya están cargados; no hacer GET
            // a /shop/change_pricelist. Solo renderizar la matriz local.
            if (reloadAll || changed) {
                await this._loadInfoForMode(wrapper, templateId);
            }
            this._updatePricingStatus(wrapper, target, false);
            return { ...target, changed };
        } catch (error) {
            console.error("Yazbek Matrix: no se pudo mostrar la tarifa", error);
            const el = wrapper.querySelector(".yazbek-pricing-status");
            if (el) el.textContent = "No fue posible actualizar la tarifa.";
            throw error;
        }
    }
    _schedulePricingRefresh(wrapper, templateId, input) {
        this._dirtyInputs.add(input);
        if (this._pricingTimer) {
            clearTimeout(this._pricingTimer);
        }
        this._pricingTimer = setTimeout(async () => {
            this._pricingTimer = null;
            try {
                // Nunca solicitar precios mientras se usa la tarifa alterna.
                if (this._referencePriceLoadPromise) {
                    await this._referencePriceLoadPromise;
                }
                const target = this._getPricingTarget(wrapper);
                const changed = target.pricelistId > 0 &&
                    target.pricelistId !== this._activePricelistId;
                if (changed) {
                    await this._applyPricingForSelection(
                        wrapper, templateId, { reloadAll: true }
                    );
                    this._dirtyInputs.clear();
                    return;
                }
                this._updatePricingStatus(wrapper, target, false);
                const inputs = [...this._dirtyInputs];
                this._dirtyInputs.clear();
                await Promise.allSettled(inputs.map(
                    item => this._refreshCellInfo(item, templateId)
                ));
                this._updateReferencePriceCard(wrapper);
            } catch (error) {
                console.error("Yazbek Matrix: no se pudo refrescar la selección", error);
            }
        }, 350);
    }
    async _getWebsiteInfo(templateId, productId, ptavIds, uomId, quantity) {
        const qty = Math.max(Number(quantity || 1), 1);
        const pricelistId = Number(this._activePricelistId || 0);
        if (!pricelistId) {
            throw new Error("Yazbek Matrix: tarifa activa inválida");
        }
        // La carga inicial de cada variante se resuelve sin nuevos HTTP.
        if (this._batchTemplateId === Number(templateId) &&
            this._batchPriceMode === this._saleMode) {
            const cached = this._batchPrices.get(pricelistId)?.get(Number(productId));
            if (cached && Number(cached.quotedQty || 0) === qty) return cached;
        }
        const combination = Array.isArray(ptavIds) ? [...ptavIds].sort((a, b) => a-b) : [];
        const key = [templateId, pricelistId, productId, uomId, qty, combination.join(",")].join("|");
        if (this._infoCache.has(key)) return this._infoCache.get(key);
        const pending = this._enqueueInfoRequest(async () => {
            // La tarifa se envía expresamente. No depende de cookies ni
            // del estado de otra pestaña del navegador.
            const response = await rpc("/yazbek/matrix/variants/batch", {
                product_template_id: Number(templateId),
                items: [{product_id: Number(productId), quantity: qty}],
                pricelist_ids: [pricelistId],
            });
            const info = response?.prices?.[String(pricelistId)]?.[String(productId)];
            if (!info || response?.error) {
                throw new Error(`Yazbek Matrix: no fue posible calcular ${productId}`);
            }
            return info;
        });
        const shared = pending.then(info => {
            if (this._infoCache.get(key) === shared) this._infoCache.set(key, info);
            return info;
        }, error => {
            if (this._infoCache.get(key) === shared) this._infoCache.delete(key);
            console.error("Yazbek Matrix: error al calcular precio/stock", {productId, qty, error});
            // A diferencia del código anterior, no inventar permiso de compra.
            return {
                price: 0, freeQty: 0, cartQty: 0, showAvailability: false,
                allowOutOfStock: false, isStorable: true,
            };
        });
        this._infoCache.set(key, shared);
        return shared;
    }
    _getRemainingStock(info) {
        return Math.max(
            Number(info.freeQty || 0)
            -
            Number(info.cartQty || 0),
            0
        );
    }
    _invalidateInfoCacheFor(productId, uomId) {
        // El stock / qty en carrito es común a todas las listas de precios.
        for (const key of this._infoCache.keys()) {
            const parts = key.split("|");
            if (Number(parts[2]) === Number(productId) &&
                Number(parts[3]) === Number(uomId)) {
                this._infoCache.delete(key);
            }
        }
    }
    _applyLocalCartDelta(
        input,
        addedQty
    ) {
        if (!input) {
            return;
        }
        // El stock «disponible menos carrito» cambia en TODAS las listas.
        // Así un cambio Menudeo/Mayoreo no restaura stock obsoleto.
        const productId = Number(input.dataset.productId || 0);
        for (const productPrices of this._batchPrices.values()) {
            const info = productPrices.get(productId);
            if (info && info.isStorable) {
                info.cartQty = Number(info.cartQty || 0) + Number(addedQty || 0);
            }
        }
        const cell =
            input.closest("td");
        if (!cell) {
            return;
        }
        const isStorable =
            input.dataset.isStorable === "1";
        const allowOutOfStock =
            input.dataset.allowOutOfStock === "1";
        const showAvailability =
            input.dataset.showAvailability === "1";
        if (!isStorable) {
            return;
        }
        const currentAvailable =
            Math.max(
                Number(
                    input.dataset.availableQty || 0
                ),
                0
            );
        const remaining =
            Math.max(
                currentAvailable -
                Number(addedQty || 0),
                0
            );
        input.dataset.availableQty =
            String(remaining);
        this._showStockForInput(input, remaining, showAvailability);
        if (input.dataset.stockLimited === "1") {
            input.max = String(this._getAvailableModeQty(input, remaining));
        }
        const canBuy = allowOutOfStock ||
            this._getAvailableModeQty(input, remaining) > 0;
        if (!canBuy) {
            input.value = "0";
            input.disabled = true;
            input.dataset.stockCanSell = "0";
            this._setCellUnavailable(cell, true);
        } else if (input.dataset.priceAvailable === "1") {
            input.disabled = false;
            input.dataset.stockCanSell = "1";
            this._setCellUnavailable(cell, false);
        }
    }
    _setCellUnavailable(
        cell,
        unavailable
    ) {
        if (!cell) {
            return;
        }
        cell.classList.toggle(
            "table-secondary",
            unavailable
        );
        cell.classList.toggle(
            "opacity-75",
            unavailable
        );
    }
    _renderStock(input, info) {
        const label = input.closest("td")?.querySelector(".yazbek-matrix-stock");
        if (!label) return;
        if (!info.isStorable) {
            label.textContent = "";
            label.style.display = "none";
            return;
        }
        this._showStockForInput(input, this._getRemainingStock(info), info.showAvailability);
    }
    _applyStockRule(
        input,
        info
    ) {
        const cell =
            input.closest("td");
        input.dataset.isStorable =
            info.isStorable
                ? "1"
                : "0";
        input.dataset.allowOutOfStock =
            info.allowOutOfStock
                ? "1"
                : "0";
        input.dataset.showAvailability =
            info.showAvailability
                ? "1"
                : "0";
        const remaining =
            this._getRemainingStock(
                info
            );
        if (input.dataset.saleMode === "boxes" &&
            this._getBaseUnitFactor(input) <= 0) {
            input.dataset.stockCanSell = "0";
            input.dataset.stockLimited = "0";
            input.value = "0";
            input.disabled = true;
            this._setCellUnavailable(cell, true);
            return false;
        }
        input.dataset.availableQty =
            String(
                remaining
            );
        if (!info.isStorable) {
            input.dataset.stockLimited =
                "0";
            input.removeAttribute(
                "max"
            );
            return true;
        }
        if (info.allowOutOfStock) {
            input.dataset.stockLimited =
                "0";
            input.removeAttribute(
                "max"
            );
            return true;
        }
        input.dataset.stockLimited =
            "1";
        const availableMode = this._getAvailableModeQty(input, remaining);
        input.max = String(availableMode);
        if (availableMode <= 0) {
            input.value =
                "0";
            input.disabled =
                true;
            input.dataset.stockCanSell =
                "0";
            this._setCellUnavailable(
                cell,
                true
            );
            return false;
        }
        input.dataset.stockCanSell =
            "1";
        return true;
    }
    _enforceStockLimit(
        input
    ) {
        if (
            input.dataset.stockLimited !==
            "1"
        ) {
            return;
        }
        const available = this._getAvailableModeQty(input);
        let qty =
            Number(
                input.value || 0
            );
        if (qty < 0) {
            qty = 0;
        }
        if (qty > available) {
            qty =
                Math.floor(
                    available
                );
            input.value =
                String(qty);
        }
    }
    async _refreshCellInfo(
        input,
        templateId
    ) {
        const productId =
            Number(
                input.dataset.productId ||
                0
            );
        if (!productId) {
            return;
        }
        const cell =
            input.closest("td");
        const priceElement =
            cell?.querySelector(
                ".yazbek-matrix-price"
            );
        if (
            !cell ||
            !priceElement
        ) {
            return;
        }
        const mode =
            input.dataset.saleMode ||
            "units";
        const uomId =
            Number(
                input.dataset.currentUomId ||
                0
            );
        if (!uomId) {
            priceElement.textContent =
                "—";
            input.disabled =
                true;
            input.dataset.priceAvailable =
                "0";
            input.dataset.stockCanSell =
                "0";
            cell.dataset.priceLoaded =
                "1";
            cell.dataset.hasPrice =
                "0";
            this._setCellUnavailable(
                cell,
                true
            );
            this._updateRowVisibility(
                cell.closest("tr")
            );
            return;
        }
        let ptavIds = [];
        try {
            ptavIds =
                JSON.parse(
                    input.dataset.ptavIds ||
                    "[]"
                );
        } catch {
            ptavIds = [];
        }
        const originalQuantity =
            Number(
                input.value || 0
            );
        const factor = this._getBaseUnitFactor(input);
        if (factor <= 0) {
            priceElement.textContent = "—";
            input.value = "0";
            input.disabled = true;
            input.dataset.priceAvailable = "0";
            input.dataset.stockCanSell = "0";
            cell.dataset.priceLoaded = "1";
            cell.dataset.hasPrice = "0";
            cell.dataset.referenceUnitPrice = "";
            this._updateModeLabel(input);
            return;
        }
        const queryQuantity = Math.max(originalQuantity, 1) * factor;
        const originalPricelistId = this._activePricelistId;
        const originalMode =
            mode;
        const originalUomId =
            uomId;
        priceElement.textContent =
            "…";
        const info =
            await this._getWebsiteInfo(
                templateId,
                productId,
                ptavIds,
                uomId,
                queryQuantity
            );
        if (this._activePricelistId !== originalPricelistId) {
            return; // El usuario ya cambió de tarifa mientras respondía Odoo.
        }
        if (
            input.dataset.saleMode !==
            originalMode
        ) {
            return;
        }
        if (
            Number(
                input.dataset.currentUomId ||
                0
            ) !== originalUomId
        ) {
            return;
        }
        if (
            Number(
                input.value || 0
            ) !== originalQuantity
        ) {
            return;
        }
        const hasPrice =
            info.price > 0;
        input.dataset.priceAvailable =
            hasPrice
                ? "1"
                : "0";
        cell.dataset.priceLoaded =
            "1";
        cell.dataset.hasPrice =
            hasPrice
                ? "1"
                : "0";
        if (hasPrice) {
            priceElement.textContent = this._formatPrice(info.price * factor);

            const referenceUnitPrice = info.price;

            cell.dataset.referenceUnitPrice =
                String(
                    referenceUnitPrice
                );
        } else {
            priceElement.textContent =
                "—";

            cell.dataset.referenceUnitPrice =
                "";

            input.value =
                "0";
        }
        this._renderStock(
            input,
            info
        );
        const canSellStock =
            this._applyStockRule(
                input,
                info
            );
        if (!hasPrice) {
            input.disabled =
                true;
            this._setCellUnavailable(
                cell,
                true
            );
        } else if (canSellStock) {
            input.disabled =
                false;
            this._setCellUnavailable(
                cell,
                false
            );
        }
        this._enforceStockLimit(
            input
        );
        this._updateRowVisibility(
            cell.closest("tr")
        );

        // La tarjeta se actualiza una vez por carga completa, no por celda.
    }
    _scheduleCellInfoRefresh(
        input,
        templateId
    ) {
        const key =
            input.dataset.productId;
        if (!key) {
            return;
        }
        if (
            this._infoTimers.has(
                key
            )
        ) {
            clearTimeout(
                this._infoTimers.get(
                    key
                )
            );
        }
        const timer =
            setTimeout(
                async () => {
                    this._infoTimers.delete(
                        key
                    );
                    await this._refreshCellInfo(
                        input,
                        templateId
                    );
                },
                300
            );
        this._infoTimers.set(
            key,
            timer
        );
    }
    _updateRowVisibility(row) {
        if (!row) {
            return;
        }
        const cells =
            [
                ...row.querySelectorAll(
                    "td[data-yazbek-variant-cell='1']"
                )
            ];
        if (!cells.length) {
            row.style.display =
                "none";
            return;
        }
        const pending =
            cells.some(
                cell =>
                    cell.dataset.priceLoaded !==
                    "1"
            );
        if (pending) {
            return;
        }
        const hasPrice =
            cells.some(
                cell =>
                    cell.dataset.hasPrice ===
                    "1"
            );
        row.style.display =
            hasPrice
                ? ""
                : "none";
    }
    _refreshRowsVisibility(
        wrapper
    ) {
        const rows =
            wrapper.querySelectorAll(
                "tbody tr[data-color-id]"
            );
        for (const row of rows) {
            this._updateRowVisibility(
                row
            );
        }
    }
    // Se realiza UNA carga HTTP por cada 25 variantes (para ambas tarifas).
    // Los cambios posteriores de lista leen la memoria local de la página.
    async _ensureBatchPrices(wrapper, templateId) {
        if (this._batchTemplateId === templateId && this._batchPrices.size &&
            this._batchPriceMode === this._saleMode) {
            return;
        }
        if (this._batchPromise) {
            return this._batchPromise;
        }
        const config = this._pricingConfig || {};
        const listIds = this._isSpecialCustomerPricelist()
            ? [Number(config.customerPricelistId || 0)]
            : [Number(config.retailPricelistId || 0),
               Number(config.wholesalePricelistId || 0)];
        const pricelistIds = [...new Set(listIds.filter(id => id > 0))];
        if (!pricelistIds.length) {
            throw new Error("Yazbek: ninguna tarifa configurada");
        }
        const inputs = [...wrapper.querySelectorAll(".yazbek-matrix-qty")];
        const items = [];
        const unique = new Set();
        for (const input of inputs) {
            const id = Number(input.dataset.productId || 0);
            if (id > 0 && !unique.has(id)) {
                unique.add(id);
                items.push({ product_id: id });
            }
        }
        if (!items.length) {
            return;
        }
        const chunks = [];
        for (let index = 0; index < items.length; index += 25) {
            chunks.push(items.slice(index, index + 25));
        }
        this._batchPromise = (async () => {
            const full = new Map(pricelistIds.map(id => [id, new Map()]));
            let nextChunk = 0;
            // Máximo 2 requests de 25 variantes, sin crear 198 XHR.
            const worker = async () => {
                while (nextChunk < chunks.length && !this._destroyed) {
                    const chunk = chunks[nextChunk++];
                    const result = await rpc("/yazbek/matrix/variants/batch", {
                        product_template_id: templateId,
                        items: chunk,
                        pricelist_ids: pricelistIds,
                        quantity_mode: this._saleMode,
                        // La tarjeta «Desde» de Mayoreo replica la vista QWeb:
                        // se calcula con 12 piezas, sin alterar el precio de
                        // cada celda (calculado con cantidad 1 inicialmente).
                        reference_quantities: this._isSpecialCustomerPricelist()
                            ? {}
                            : {
                                [String(config.wholesalePricelistId)]: Number(
                                    config.wholesaleMinQty || 12
                                ),
                            },
                    });
                    this._batchRequests++;
                    if (!result || result.error || !result.prices) {
                        throw new Error(`Yazbek batch: ${result?.error || "sin datos"}`);
                    }
                    for (const plId of pricelistIds) {
                        const prices = result.prices[String(plId)];
                        if (!prices) {
                            throw new Error(`Yazbek batch: falta tarifa ${plId}`);
                        }
                        for (const item of chunk) {
                            const info = prices[String(item.product_id)];
                            if (!info) {
                                throw new Error(`Yazbek batch: falta variante ${item.product_id}`);
                            }
                            full.get(plId).set(item.product_id, info);
                        }
                    }
                }
            };
            await Promise.all(Array.from(
                { length: Math.min(2, chunks.length) }, () => worker()
            ));
            if (this._destroyed) return;
            this._batchTemplateId = templateId;
            this._batchPriceMode = this._saleMode;
            this._batchPrices = full;
            this._referencePriceCache.clear();
            for (const plId of pricelistIds) {
                let minPrice = Infinity;
                for (const info of full.get(plId).values()) {
                    const price = Number(info.referencePrice ?? info.price ?? 0);
                    if (price > 0 && price < minPrice) minPrice = price;
                }
                if (Number.isFinite(minPrice)) {
                    this._referencePriceCache.set(plId, minPrice);
                }
            }
            console.info("Yazbek Matrix Batch 19: ", {
                variantes: items.length,
                tarifas: pricelistIds,
                requests: this._batchRequests,
            });
        })();
        try {
            await this._batchPromise;
        } finally {
            this._batchPromise = null;
        }
    }

    async _loadInfoForMode(wrapper, templateId) {
        this._matrixLoadInProgress = true;
        this._matrixInfoLoadedPricelistId = 0;
        try {
            await this._ensureBatchPrices(wrapper, templateId);
            const inputs = [...wrapper.querySelectorAll(".yazbek-matrix-qty")];
            const cached = this._batchPrices.get(Number(this._activePricelistId));
            if (!cached) {
                throw new Error("Yazbek batch: tarifa actual sin datos");
            }
            for (const row of wrapper.querySelectorAll("tbody tr[data-color-id]")) {
                row.style.display = "";
            }
            // Actualiza UI usando datos del bloque; solo cantidades distintas
            // de 1 que el visitante haya modificado podrían pedir su propio RPC.
            await Promise.allSettled(inputs.map(async input => {
                const cell = input.closest("td");
                if (!cell) return;
                cell.dataset.priceLoaded = "0";
                cell.dataset.hasPrice = "0";
                input.dataset.priceAvailable = "0";
                input.dataset.stockCanSell = "1";
                const productId = Number(input.dataset.productId || 0);
                if (!cached.has(productId)) {
                    cell.dataset.priceLoaded = "1";
                    input.disabled = true;
                    return;
                }
                const productInfo = cached.get(productId);
                // Solo confiar en las piezas/caja validadas en el servidor.
                input.dataset.packagingUnits = String(productInfo.packagingUnits || 0);
                input.dataset.saleMode = this._saleMode;
                this._updateModeLabel(input);
                await this._refreshCellInfo(input, templateId);
            }));
            this._matrixInfoLoadedPricelistId = this._activePricelistId;
            this._refreshRowsVisibility(wrapper);
            this._updateReferencePriceCard(wrapper);
        } catch (error) {
            console.error("Yazbek Matrix: error cargando lotes", error);
            // No habilitar venta sin validar precio y stock.
            for (const input of wrapper.querySelectorAll(".yazbek-matrix-qty")) {
                input.disabled = true;
                input.dataset.priceAvailable = "0";
                const cell = input.closest("td");
                if (cell) {
                    cell.dataset.priceLoaded = "1";
                    cell.dataset.hasPrice = "0";
                    cell.querySelector(".yazbek-matrix-price")?.replaceChildren("—");
                }
            }
            throw error;
        } finally {
            this._matrixLoadInProgress = false;
        }
    }
    _readVariantsFromHtml() {
        const dataContainer =
            this.el.querySelector(
                "#yazbek-variant-matrix-data"
            );
        if (!dataContainer) {
            console.warn(
                "Yazbek Matrix: no se encontró #yazbek-variant-matrix-data"
            );
            return [];
        }
        const variantNodes =
            [
                ...dataContainer.querySelectorAll(
                    ".yazbek-variant-data"
                )
            ];
        const variants =
            [];
        for (const node of variantNodes) {
            const productId =
                Number(
                    node.dataset.productId ||
                    0
                );
            if (!productId) {
                continue;
            }
            const attributes =
                [];
            const attributeNodes =
                node.querySelectorAll(
                    ".yazbek-variant-attribute"
                );
            for (
                const attributeNode
                of attributeNodes
            ) {
                const id =
                    Number(
                        attributeNode
                            .dataset
                            .ptavId ||
                        0
                    );
                if (!id) {
                    continue;
                }
                attributes.push({
                    id,
                    attributeName:
                        attributeNode
                            .dataset
                            .attributeName ||
                        "",
                    valueName:
                        attributeNode
                            .dataset
                            .valueName ||
                        "",
                });
            }
            variants.push({
                productId,
                defaultCode:
                    node.dataset.defaultCode ||
                    "",
                baseUomId:
                    Number(
                        node.dataset.baseUomId ||
                        0
                    ),
                baseUomName:
                    node.dataset.baseUomName ||
                    "Unidades",
                packagingId:
                    Number(
                        node.dataset.packagingId ||
                        0
                    ),
                packagingName:
                    node.dataset.packagingName ||
                    "",
                imageUrl:
                    node.dataset.imageUrl ||
                    "",
                attributes,
                ptavIds:
                    attributes.map(
                        attribute =>
                            attribute.id
                    ),
            });
        }
        return variants;
    }
    _getSelectedColorId() {
        const containers =
            this.el.querySelectorAll(
                ".variant_attribute"
            );
        for (const container of containers) {
            const attributeName =
                String(
                    container.dataset
                        .attributeName ||
                    ""
                )
                    .trim()
                    .toLowerCase();
            if (
                !attributeName.includes(
                    "color"
                )
            ) {
                continue;
            }
            const checked =
                container.querySelector(
                    "input.js_variant_change:checked"
                );
            if (checked) {
                return Number(
                    checked.dataset.valueId ||
                    checked.value ||
                    0
                );
            }
            const select =
                container.querySelector(
                    "select.js_variant_change"
                );
            if (select) {
                const option =
                    select.options[
                        select.selectedIndex
                    ];
                return Number(
                    option?.dataset?.valueId ||
                    option?.value ||
                    0
                );
            }
        }
        return 0;
    }
    _selectColorInOdoo(
        colorPtavId
    ) {
        const containers =
            this.el.querySelectorAll(
                ".variant_attribute"
            );
        for (const container of containers) {
            const attributeName =
                String(
                    container.dataset
                        .attributeName ||
                    ""
                )
                    .trim()
                    .toLowerCase();
            if (
                !attributeName.includes(
                    "color"
                )
            ) {
                continue;
            }
            const inputs =
                container.querySelectorAll(
                    "input.js_variant_change"
                );
            for (const input of inputs) {
                const valueId =
                    Number(
                        input.dataset.valueId ||
                        input.value ||
                        0
                    );
                if (
                    valueId ===
                    Number(colorPtavId)
                ) {
                    if (!input.checked) {
                        input.click();
                    }
                    return true;
                }
            }
            const select =
                container.querySelector(
                    "select.js_variant_change"
                );
            if (select) {
                const option =
                    [
                        ...select.options
                    ].find(
                        option =>
                            Number(
                                option.dataset.valueId ||
                                option.value ||
                                0
                            ) ===
                            Number(colorPtavId)
                    );
                if (option) {
                    select.value =
                        option.value;
                    select.dispatchEvent(
                        new Event(
                            "change",
                            {
                                bubbles: true,
                            }
                        )
                    );
                    return true;
                }
            }
        }
        return false;
    }
    _setActiveMatrixColor(
        wrapper,
        colorId
    ) {
        const buttons =
            wrapper.querySelectorAll(
                ".yazbek-color-selector"
            );
        for (const button of buttons) {
            const active =
                Number(
                    button.dataset.colorId ||
                    0
                ) ===
                Number(colorId);
            button.classList.toggle(
                "border-primary",
                active
            );
            button.classList.toggle(
                "bg-primary-subtle",
                active
            );
            button.classList.toggle(
                "shadow-sm",
                active
            );
        }
    }
    _getSizeOrder(name) {
        const normalized =
            String(name || "")
                .trim()
                .toUpperCase();
        const order = {
            "CH": 0,
            "S": 0,
            "M": 1,
            "G": 2,
            "L": 2,
            "EG": 3,
            "XL": 3,
            "EEG": 4,
            "2XL": 4,
            "XXL": 4,
            "EEEG": 5,
            "3XL": 5,
            "XXXL": 5,
        };
        return Object.prototype
            .hasOwnProperty.call(
                order,
                normalized
            )
            ? order[normalized]
            : 999;
    }
    async _buildMatrix() {
        const templateInput =
            this.el.querySelector(
                "input[name='product_template_id']"
            );
        if (!templateInput) {
            return;
        }
        const templateId =
            Number(
                templateInput.value ||
                0
            );
        if (!templateId) {
            return;
        }
        const variants =
            this._readVariantsFromHtml();
        if (!variants.length) {
            return;
        }
        const colors =
            new Map();
        const sizes =
            new Map();
        const matrix =
            {};
        for (const variant of variants) {
            let color = null;
            let size = null;
            for (
                const attribute
                of variant.attributes
            ) {
                const attributeName =
                    String(
                        attribute.attributeName ||
                        ""
                    )
                        .trim()
                        .toLowerCase();
                if (
                    attributeName.includes(
                        "color"
                    )
                ) {
                    color = {
                        id:
                            attribute.id,
                        name:
                            attribute.valueName,
                    };
                }
                if (
                    attributeName.includes(
                        "talla"
                    ) ||
                    attributeName.includes(
                        "size"
                    )
                ) {
                    size = {
                        id:
                            attribute.id,
                        name:
                            attribute.valueName,
                    };
                }
            }
            if (
                !color ||
                !size
            ) {
                continue;
            }
            if (!colors.has(color.id)) {
                colors.set(
                    color.id,
                    {
                        id:
                            color.id,
                        name:
                            color.name,
                        imageUrl:
                            variant.imageUrl ||
                            `/web/image/product.product/${variant.productId}/image_256`,
                    }
                );
            }
            sizes.set(
                size.id,
                size
            );
            const key =
                `${size.id}_${color.id}`;
            matrix[key] = {
                productId:
                    variant.productId,
                defaultCode:
                    variant.defaultCode,
                baseUomId:
                    variant.baseUomId,
                baseUomName:
                    variant.baseUomName,
                packagingId:
                    variant.packagingId,
                packagingName:
                    variant.packagingName,
                ptavIds:
                    variant.ptavIds,
            };
        }
        await this._renderMatrix(
            [...colors.values()],
            [...sizes.values()],
            matrix,
            templateId
        );
    }
    async _renderMatrix(
        colors,
        sizes,
        matrix,
        templateId
    ) {
        if (this._matrixCreated) {
            return;
        }
        this._matrixCreated =
            true;
        sizes.sort(
            (a, b) =>
                this._getSizeOrder(a.name)
                -
                this._getSizeOrder(b.name)
        );
        colors.sort(
            (a, b) =>
                String(a.name || "")
                    .localeCompare(
                        String(b.name || ""),
                        "es"
                    )
        );
        const wrapper =
            document.createElement(
                "div"
            );
        wrapper.className =
            "yazbek-variant-matrix mt-3 mb-4";
        const title =
            document.createElement(
                "h5"
            );
        title.textContent =
            "Selecciona cantidades";
        wrapper.appendChild(
            title
        );
        const help =
            document.createElement(
                "div"
            );
        help.className =
            "text-muted small mb-2";
        help.textContent =
            "Ingresa la cantidad deseada para cada combinación de talla y color. Haz clic en un color para cambiar la imagen.";
        wrapper.appendChild(
            help
        );
        const pricingStatus =
            document.createElement(
                "div"
            );
        pricingStatus.className =
            "small fw-semibold mb-2 yazbek-pricing-status";
        pricingStatus.textContent =
            "Calculando tarifa...";
        wrapper.appendChild(
            pricingStatus
        );
        const modeWrapper = document.createElement("div");
        modeWrapper.className = "btn-group mb-3";
        modeWrapper.setAttribute("role", "group");
        modeWrapper.setAttribute("aria-label", "Modo de compra");
        const modes = this._matrixModeSetting === "both"
            ? ["units", "boxes"]
            : [this._saleMode];
        for (const mode of modes) {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.mode = mode;
            button.className = "btn yazbek-matrix-mode-button";
            button.textContent = mode === "boxes" ? "Cajas" : "Unidades";
            button.addEventListener("click", () =>
                this._switchSaleMode(mode, wrapper, templateId, updateSummary)
            );
            modeWrapper.appendChild(button);
        }
        wrapper.appendChild(modeWrapper);
        this._updateModeButtons(wrapper);
        if (this._matrixModeSetting === "both") {
            const hint = document.createElement("div");
            hint.className = "small text-muted mb-2";
            hint.textContent = "En Cajas solo se permiten cajas completas; las piezas por caja dependen de cada talla y color.";
            wrapper.appendChild(hint);
        }
        const responsive =
            document.createElement(
                "div"
            );
        responsive.className =
            "table-responsive";

        // Cabecera fija al recorrer verticalmente la matriz.
        responsive.style.maxHeight =
            "70vh";
        responsive.style.overflowY =
            "auto";
        responsive.style.overflowX =
            "auto";
        responsive.style.position =
            "relative";

        const table =
            document.createElement(
                "table"
            );
        table.className =
            "table table-bordered table-sm align-middle text-center";
        const thead =
            document.createElement(
                "thead"
            );
        const headerRow =
            document.createElement(
                "tr"
            );
        const corner =
            document.createElement(
                "th"
            );
        corner.textContent =
            "Color / Talla";
        corner.style.minWidth =
            "125px";
        corner.style.position =
            "sticky";
        corner.style.top =
            "0";
        corner.style.zIndex =
            "30";
        corner.style.backgroundColor =
            "#ffffff";
        corner.style.boxShadow =
            "0 2px 0 rgba(0, 0, 0, 0.08)";
        headerRow.appendChild(
            corner
        );
        for (const size of sizes) {
            const th =
                document.createElement(
                    "th"
                );
            th.textContent =
                size.name;
            th.style.minWidth =
                "95px";
            th.style.position =
                "sticky";
            th.style.top =
                "0";
            th.style.zIndex =
                "20";
            th.style.backgroundColor =
                "#ffffff";
            th.style.boxShadow =
                "0 2px 0 rgba(0, 0, 0, 0.08)";
            headerRow.appendChild(
                th
            );
        }
        thead.appendChild(
            headerRow
        );
        table.appendChild(
            thead
        );
        const tbody =
            document.createElement(
                "tbody"
            );
        for (const color of colors) {
            const row =
                document.createElement(
                    "tr"
                );
            row.dataset.colorId =
                String(color.id);
            const colorCell =
                document.createElement(
                    "th"
                );
            colorCell.className =
                "align-middle p-2";
            colorCell.style.minWidth =
                "125px";
            colorCell.style.width =
                "125px";
            const colorButton =
                document.createElement(
                    "button"
                );
            colorButton.type =
                "button";
            colorButton.className =
                "yazbek-color-selector btn btn-light border w-100 d-flex flex-column align-items-center justify-content-center gap-1";
            colorButton.dataset.colorId =
                String(color.id);
            colorButton.setAttribute(
                "aria-pressed",
                "false"
            );
            colorButton.title =
                `Ver color ${color.name}`;
            colorButton.style.padding =
                "6px";
            colorButton.style.minHeight =
                "105px";
            colorButton.style.boxSizing =
                "border-box";
            colorButton.style.overflow =
                "hidden";
            colorButton.style.borderRadius =
                "6px";
            colorButton.style.position =
                "relative";
            colorButton.style.transition =
                "all .15s ease";
            const thumbnail =
                document.createElement(
                    "img"
                );
            thumbnail.src =
                color.imageUrl;
            thumbnail.alt =
                color.name;
            thumbnail.width =
                72;
            thumbnail.height =
                72;
            thumbnail.loading =
                "lazy";
            thumbnail.style.width =
                "72px";
            thumbnail.style.height =
                "72px";
            thumbnail.style.maxWidth =
                "100%";
            thumbnail.style.objectFit =
                "contain";
            thumbnail.style.objectPosition =
                "center";
            thumbnail.style.borderRadius =
                "5px";
            thumbnail.style.display =
                "block";
            thumbnail.style.margin =
                "0 auto";
            thumbnail.style.flexShrink =
                "0";
            thumbnail.onerror =
                () => {
                    thumbnail.style.display =
                        "none";
                };
            const colorName =
                document.createElement(
                    "span"
                );
            colorName.className =
                "fw-semibold small text-center";
            colorName.textContent =
                color.name;
            colorName.style.display =
                "block";
            colorName.style.width =
                "100%";
            colorName.style.lineHeight =
                "1.15";
            colorName.style.marginTop =
                "2px";
            colorButton.append(
                thumbnail,
                colorName
            );
            colorButton.addEventListener(
                "click",
                () => {
                    if (
                        this._selectColorInOdoo(
                            color.id
                        )
                    ) {
                        this._setActiveMatrixColor(
                            wrapper,
                            color.id
                        );
                    }
                }
            );
            colorCell.appendChild(
                colorButton
            );
            row.appendChild(
                colorCell
            );
            for (const size of sizes) {
                const cell =
                    document.createElement(
                        "td"
                    );
                cell.style.minWidth = "118px";
                const key =
                    `${size.id}_${color.id}`;
                const variant =
                    matrix[key];
                if (!variant) {
                    cell.innerHTML =
                        `<span class="text-muted">—</span>`;
                    row.appendChild(
                        cell
                    );
                    continue;
                }
                cell.dataset.yazbekVariantCell =
                    "1";
                cell.dataset.priceLoaded =
                    "0";
                cell.dataset.hasPrice =
                    "0";
                const input =
                    document.createElement(
                        "input"
                    );
                input.type =
                    "number";
                input.min =
                    "0";
                input.step =
                    "1";
                input.value =
                    "0";
                input.className =
                    "form-control form-control-sm text-center yazbek-matrix-qty";
                input.dataset.productId =
                    String(
                        variant.productId
                    );
                input.dataset.defaultCode =
                    variant.defaultCode ||
                    "";
                input.dataset.ptavIds =
                    JSON.stringify(
                        variant.ptavIds ||
                        []
                    );
                input.dataset.baseUomId =
                    String(
                        variant.baseUomId ||
                        0
                    );
                input.dataset.packagingId =
                    String(
                        variant.packagingId ||
                        0
                    );
                input.dataset.packagingName =
                    variant.packagingName ||
                    "";
                input.dataset.packagingUnits =
                    String(
                        this._getPackagingUnits(
                            variant.packagingName
                        )
                    );
                input.dataset.saleMode = this._saleMode;
                input.dataset.currentUomId =
                    String(
                        variant.baseUomId ||
                        0
                    );
                input.dataset.priceAvailable =
                    "0";
                input.dataset.stockCanSell =
                    "1";
                cell.appendChild(
                    input
                );
                const uomText =
                    document.createElement(
                        "small"
                    );
                uomText.className =
                    "d-block text-muted mt-1 yazbek-matrix-uom";
                uomText.dataset.packagingName =
                    variant.packagingName ||
                    "";
                uomText.dataset.packagingId =
                    String(
                        variant.packagingId ||
                        0
                    );
                uomText.textContent = "Unidades";
                this._updateModeLabel(input);
                cell.appendChild(
                    uomText
                );
                const priceText =
                    document.createElement(
                        "small"
                    );
                priceText.className =
                    "d-block fw-semibold mt-1 yazbek-matrix-price";
                priceText.textContent = "…";
                priceText.style.whiteSpace = "nowrap";
                cell.appendChild(
                    priceText
                );
                const stockText =
                    document.createElement(
                        "small"
                    );
                stockText.className =
                    "d-block mt-1 yazbek-matrix-stock";
                stockText.style.display =
                    "none";
                cell.appendChild(
                    stockText
                );
                input.addEventListener(
                    "input",
                    () => {
                        this._enforceStockLimit(
                            input
                        );
                        this._schedulePricingRefresh(
                            wrapper,
                            templateId,
                            input
                        );
                    }
                );
                row.appendChild(
                    cell
                );
            }
            tbody.appendChild(
                row
            );
        }
        table.appendChild(
            tbody
        );
        responsive.appendChild(
            table
        );
        wrapper.appendChild(
            responsive
        );
        const summary =
            document.createElement(
                "div"
            );
        summary.className =
            "mt-3 fw-semibold";
        summary.textContent =
            "Total: 0 unidades";
        wrapper.appendChild(
            summary
        );
        const updateSummary =
            () => {
                let total = 0;
                const inputs =
                    wrapper.querySelectorAll(
                        ".yazbek-matrix-qty"
                    );
                for (const input of inputs) {
                    if (
                        input.disabled ||
                        input.dataset.priceAvailable !==
                        "1" ||
                        input.dataset.stockCanSell ===
                        "0"
                    ) {
                        continue;
                    }
                    total +=
                        Number(
                            input.value ||
                            0
                        );
                }
                if (this._saleMode === "boxes") {
                    const baseUnits = this._getSelectionBaseUnits(wrapper);
                    summary.textContent = `Total: ${total} cajas · ${this._formatStock(baseUnits)} piezas`;
                } else {
                    summary.textContent = `Total: ${total} unidades`;
                }
            };
        wrapper.addEventListener(
            "input",
            updateSummary
        );
        const cartButton =
            document.createElement(
                "button"
            );
        cartButton.type =
            "button";
        cartButton.className =
            "btn btn-primary mt-3";
        cartButton.textContent =
            "Agregar selección al carrito";
        wrapper.appendChild(
            cartButton
        );
        cartButton.addEventListener(
            "click",
            async () => {
                if (this._modeSwitchInProgress || this._matrixLoadInProgress) return;
                const selection =
                    [];
                const inputs =
                    wrapper.querySelectorAll(
                        ".yazbek-matrix-qty"
                    );
                for (const input of inputs) {
                    this._enforceStockLimit(
                        input
                    );
                    const qty =
                        Number(
                            input.value || 0
                        );
                    if (
                        qty <= 0 ||
                        !Number.isSafeInteger(qty) ||
                        input.disabled ||
                        input.dataset.priceAvailable !== "1" ||
                        input.dataset.stockCanSell === "0"
                    ) {
                        continue;
                    }
                    const productId =
                        Number(
                            input.dataset.productId || 0
                        );
                    const uomId =
                        Number(
                            input.dataset.currentUomId || 0
                        );
                    if (
                        !productId ||
                        !uomId
                    ) {
                        continue;
                    }
                    if (qty * this._getBaseUnitFactor(input) > 100000) {
                        alert("La selección supera 100,000 piezas por variante. Divide el pedido.");
                        return;
                    }
                    if (
                        input.dataset.stockLimited === "1"
                    ) {
                        const available =
                            Number(
                                input.dataset.availableQty || 0
                            );
                        const availableMode = this._getAvailableModeQty(input, available);
                        if (qty > availableMode) {
                            alert(
                                `Solo hay ${this._formatStock(availableMode)} disponibles para esta variante.`
                            );
                            return;
                        }
                    }
                    const unitsPerQty = this._getBaseUnitFactor(input);
                    if (!Number.isSafeInteger(unitsPerQty) || unitsPerQty <= 0) {
                        alert("La variante no tiene piezas por caja configuradas.");
                        return;
                    }
                    selection.push({
                        productId,
                        uomId,
                        qty,
                        baseUnits:
                            qty * unitsPerQty,
                        input,
                    });
                }
                if (!selection.length) {
                    alert(
                        "Captura al menos una cantidad disponible."
                    );
                    return;
                }
                // Desactivar el botón antes del primer await: evita doble envío.
                const originalText = cartButton.textContent;
                cartButton.disabled = true;
                cartButton.textContent = "Validando tarifa...";
                try {
                    if (this._referencePriceLoadPromise) {
                        await this._referencePriceLoadPromise;
                    }
                    await this._applyPricingForSelection(
                        wrapper, templateId, { reloadAll: false }
                    );
                } catch {
                    cartButton.disabled = false;
                    cartButton.textContent = originalText;
                    alert("No fue posible activar la tarifa correcta. Intenta nuevamente.");
                    return;
                }
                cartButton.textContent = "Agregando...";
                try {
                    let lastResult =
                        null;
                    let addedCount =
                        0;
                    for (
                        let index = 0;
                        index < selection.length;
                        index++
                    ) {
                        const item =
                            selection[index];
                        cartButton.textContent =
                            `Agregando ${index + 1}/${selection.length}...`;
                        lastResult =
                            await rpc(
                                "/shop/cart/add",
                                {
                                    product_template_id:
                                        templateId,
                                    product_id:
                                        item.productId,
                                    quantity:
                                        item.baseUnits,
                                    uom_id:
                                        item.uomId,
                                    product_custom_attribute_values:
                                        [],
                                    no_variant_attribute_value_ids:
                                        [],
                                }
                            );
                        addedCount++;
                        this._cartBaseUnits +=
                            Number(
                                item.baseUnits ||
                                item.qty ||
                                0
                            );
                        this._storeCartBaseUnits();
                        this._invalidateInfoCacheFor(
                            item.productId,
                            item.uomId
                        );
                        this._applyLocalCartDelta(
                            item.input,
                            item.baseUnits
                        );
                        item.input.value =
                            "0";
                        updateSummary();
                    }
                    if (
                        lastResult &&
                        lastResult.cart_quantity !== undefined
                    ) {
                        const elements =
                            document.querySelectorAll(
                                ".my_cart_quantity"
                            );
                        for (const element of elements) {
                            element.textContent =
                                String(
                                    lastResult.cart_quantity
                                );
                            element.classList.remove(
                                "d-none"
                            );
                        }
                    }
                    this._updatePricingStatus(
                        wrapper,
                        this._getPricingTarget(
                            wrapper
                        ),
                        false
                    );
                    alert(
                        `${addedCount} variantes agregadas al carrito correctamente.`
                    );
                } catch (error) {
                    console.error(
                        "Yazbek Matrix: error agregando al carrito",
                        error
                    );
                    updateSummary();
                    alert(
                        "No fue posible completar toda la selección. Las variantes agregadas antes del error sí permanecen en el carrito."
                    );
                } finally {
                    cartButton.disabled =
                        false;
                    cartButton.textContent =
                        originalText;
                }
            }
        );
        const attributesSection =
            this.el.querySelector(
                ".o_wsale_product_details_content_section_attributes"
            );
        if (!attributesSection) {
            return;
        }
        attributesSection.insertAdjacentElement(
            "afterend",
            wrapper
        );
        attributesSection.style.display =
            "none";
        const initialColorId =
            this._getSelectedColorId();
        if (initialColorId) {
            this._setActiveMatrixColor(
                wrapper,
                initialColorId
            );
        }
        // Una sola carga de la tarifa correcta, sin consultas provisionales
        // ni cambios de lista innecesarios durante la inicialización.
        await this._applyPricingForSelection(
            wrapper,
            templateId,
            {
                reloadAll: true,
            }
        );

        // Ambos «Desde» se obtienen con los mismos lotes sin tocar la sesión.
        await this._ensureBothReferencePrices(
            wrapper,
            templateId
        );
    }
}
registry
    .category("public.interactions")
    .add(
        "yazbek_variant_matrix",
        YazbekVariantMatrix
    );
