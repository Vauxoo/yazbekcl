/** @odoo-module **/

import { Interaction } from "@web/public/interaction";
import { registry } from "@web/core/registry";

/**
 * Formato visual de precios para cada sitio web.
 * El widget monetario de Odoo sigue calculando con la precisión real.
 * Este módulo cambia únicamente el texto numérico de .oe_currency_value.
 * No hace RPC y no cambia ni currency_id ni decimal_places en res.currency.
 */
class YazbekWebsiteDisplay extends Interaction {
    static selector = "body";

    start() {
        const config = document.documentElement.dataset;
        if (config.yazbekPriceDecimals === undefined) {
            return; // No actuar en páginas que no vienen de website.layout.
        }
        this.decimals = config.yazbekPriceDecimals === "1" ? 2 : 0;
        this.locale = config.yazbekLocale || "es-MX";
        this._lastFormatted = new WeakMap();
        try {
            this.numberFormatter = new Intl.NumberFormat(this.locale, {
                minimumFractionDigits: this.decimals,
                maximumFractionDigits: this.decimals,
            });
            this.localeDecimal = new Intl.NumberFormat(this.locale)
                .formatToParts(1.5).find((p) => p.type === "decimal")?.value || ".";
        } catch (_error) {
            this.locale = "es-MX";
            this.numberFormatter = new Intl.NumberFormat("es-MX", {
                minimumFractionDigits: this.decimals,
                maximumFractionDigits: this.decimals,
            });
            this.localeDecimal = ".";
        }
        this._refreshPrices();
        // Cart, product variants, payment and pricelist widgets replace prices dynamically.
        // Work is batched once per animation frame; no HTTP calls are added.
        this._refreshScheduled = false;
        this._priceObserver = new MutationObserver((mutations) => {
            if (mutations.some((mutation) => this._hasMonetaryChange(mutation))) {
                this._schedulePriceRefresh();
            }
        });
        this._priceObserver.observe(this.el, {
            childList: true,
            characterData: true,
            subtree: true,
        });
    }

    destroy() {
        this._priceObserver?.disconnect();
        this._priceObserver = null;
        if (this._frameId !== undefined) {
            cancelAnimationFrame(this._frameId);
            this._frameId = undefined;
        }
        super.destroy();
    }

    _hasMonetaryChange(mutation) {
        // Evitar trabajo en cambios de imágenes, buscador, menús y stock.
        const target = mutation.target.nodeType === 3
            ? mutation.target.parentElement : mutation.target;
        if (target?.closest?.(".oe_currency_value")) return true;
        for (const node of mutation.addedNodes || []) {
            if (node.nodeType !== 1) continue;
            if (node.matches?.(".oe_currency_value") ||
                node.querySelector?.(".oe_currency_value")) return true;
        }
        return false;
    }

    _schedulePriceRefresh() {
        if (this._refreshScheduled) return;
        this._refreshScheduled = true;
        this._frameId = requestAnimationFrame(() => {
            this._refreshScheduled = false;
            this._frameId = undefined;
            if (this._priceObserver) {
                this._refreshPrices();
            }
        });
    }

    _parseAmount(text) {
        // Accept 1,234.56 (es-MX) or 1.234,56 (es-CL), including NBSP groupings.
        const negative = /[-\u2212]/.test(text);
        const digits = text.replace(/[^\d.,]/g, "");
        if (!digits || !/\d/.test(digits)) return null;
        const dot = digits.lastIndexOf(".");
        const comma = digits.lastIndexOf(",");
        let decimalSeparator = null;
        if (dot >= 0 && comma >= 0) {
            decimalSeparator = dot > comma ? "." : ",";
        } else {
            const position = Math.max(dot, comma);
            if (position >= 0) {
                const separator = digits[position];
                const tailLength = digits.length - position - 1;
                if (tailLength > 0 && tailLength <= 2 &&
                    (separator === this.localeDecimal || tailLength === 2)) {
                    decimalSeparator = separator;
                }
            }
        }
        let normalized = digits;
        if (decimalSeparator) {
            const i = normalized.lastIndexOf(decimalSeparator);
            normalized = normalized.slice(0, i).replace(/[.,]/g, "")
                + "." + normalized.slice(i + 1).replace(/[.,]/g, "");
        } else {
            normalized = normalized.replace(/[.,]/g, "");
        }
        const amount = Number(normalized);
        return Number.isFinite(amount) ? (negative ? -amount : amount) : null;
    }

    _refreshPrices() {
        // .oe_currency_value is the standard numeric part of Odoo's monetary widget.
        // Do not overwrite matrix prices: they already use Intl with site settings.
        for (const element of this.el.querySelectorAll(".oe_currency_value")) {
            if (element.closest(".yazbek-variant-matrix")) continue;
            const current = element.textContent?.trim() || "";
            if (!current || this._lastFormatted.get(element) === current) continue;
            const amount = this._parseAmount(current);
            if (amount === null) continue;
            const updated = this.numberFormatter.format(amount);
            if (updated !== current) {
                element.textContent = updated;
            }
            this._lastFormatted.set(element, updated);
        }
    }
}

registry.category("public.interactions").add("yazbek_variant_matrix_batch.website_display", YazbekWebsiteDisplay);
