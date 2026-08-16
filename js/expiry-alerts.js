/**
 * Store Expiry Alerts Module
 * 
 * Analyzes store inventory and regulatory expiry dates from public.v_expiry_report / inventory_items.
 * Categorizes records into:
 * 1. Expired Items (immediate disposal required)
 * 2. Expiring Soon Items (within 30 days)
 * Populates live metric cards and table rows.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.ExpiryAlertsModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    let expiredItems = [];
    let expiringSoonItems = [];

    /**
     * Get initialized Supabase client
     */
    function getClient() {
        const client = supabaseService && supabaseService.getClient();
        if (!client) {
            throw new Error('Supabase client is not available.');
        }
        return client;
    }

    /**
     * Escape HTML string
     */
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    /**
     * Format a date string (YYYY-MM-DD or ISO) to DD/MM/YYYY
     */
    function formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}/${month}/${year}`;
        } catch (e) {
            return dateStr;
        }
    }

    /**
     * Calculate days remaining until expiry
     * @param {string} expiryDateStr 
     * @returns {{ isExpired: boolean, isExpiringSoon: boolean, daysDiff: number, formatted: string }}
     */
    function evaluateExpiryDetails(expiryDateStr) {
        if (!expiryDateStr) {
            return { isExpired: false, isExpiringSoon: false, daysDiff: 999, formatted: '-' };
        }

        const formatted = formatDate(expiryDateStr);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const expDate = new Date(expiryDateStr);
        expDate.setHours(0, 0, 0, 0);

        if (isNaN(expDate.getTime())) {
            return { isExpired: false, isExpiringSoon: false, daysDiff: 999, formatted };
        }

        const diffTime = expDate.getTime() - today.getTime();
        const daysDiff = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const isExpired = daysDiff < 0;
        const isExpiringSoon = daysDiff >= 0 && daysDiff <= 30;

        return { isExpired, isExpiringSoon, daysDiff, formatted };
    }

    /**
     * Fetch expiry report data from Supabase
     */
    async function fetchExpiryData() {
        const client = getClient();

        // 1. Try v_expiry_report view
        try {
            const { data, error } = await client
                .from('v_expiry_report')
                .select('*');

            if (!error && Array.isArray(data)) {
                return data;
            }
            if (error) {
                console.warn('v_expiry_report view query warning:', error.message);
            }
        } catch (e) {
            console.warn('Exception querying v_expiry_report:', e);
        }

        // 2. Fallback to v_current_stock or inventory_items table
        try {
            const { data: stockData, error: stockErr } = await client
                .from('v_current_stock')
                .select('*');

            if (!stockErr && Array.isArray(stockData)) {
                return stockData;
            }
        } catch (e) {
            console.warn('v_current_stock query fallback warning:', e);
        }

        try {
            const { data, error } = await client
                .from('inventory_items')
                .select('*');

            if (!error && Array.isArray(data)) {
                return data;
            }
            if (error) throw error;
        } catch (err) {
            console.error('Failed to query inventory items for expiry report:', err);
            throw err;
        }

        return [];
    }

    /**
     * Process and categorize records
     */
    function processRecords(records) {
        expiredItems = [];
        expiringSoonItems = [];

        records.forEach(item => {
            const expDateStr = item.expiry_date || item.date;
            const evalResult = evaluateExpiryDetails(expDateStr);

            if (evalResult.isExpired) {
                expiredItems.push({
                    ...item,
                    expiryDetails: evalResult
                });
            } else if (evalResult.isExpiringSoon) {
                expiringSoonItems.push({
                    ...item,
                    expiryDetails: evalResult
                });
            }
        });

        // Sort: expired items (most recently expired first), expiring soon (soonest first)
        expiredItems.sort((a, b) => new Date(b.expiry_date || 0) - new Date(a.expiry_date || 0));
        expiringSoonItems.sort((a, b) => new Date(a.expiry_date || 0) - new Date(b.expiry_date || 0));
    }

    /**
     * Render Expired Items Table
     */
    function renderExpiredTable(items) {
        const tbody = document.getElementById('expiredTableBody');
        const badgeCount = document.getElementById('expiredBadgeCount');
        const statCount = document.getElementById('statExpiredCount');

        if (badgeCount) badgeCount.textContent = items.length;
        if (statCount) statCount.textContent = items.length;

        if (!tbody) return;

        if (items.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 25px; color: #155724; background-color: #f4fbf5;">
                        <div style="font-size: 1.6rem; margin-bottom: 4px;">✓</div>
                        <strong>No expired medicines found in active inventory.</strong>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = items.map((item, idx) => {
            const srNo = idx + 1;
            const itemName = item.item_name || 'Item';
            const packages = item.packages || item.package || item.package_size || '-';
            const qty = (typeof item.quantity === 'number') 
                ? item.quantity 
                : (typeof item.available_quantity === 'number' ? item.available_quantity : (item.current_quantity || 0));
            const billNo = item.bill_no || '-';
            const vendor = item.vendor_name || item.vendor || '-';
            const expDateFormatted = item.expiryDetails?.formatted || formatDate(item.expiry_date);

            return `
                <tr style="background-color: #fff5f5;">
                    <td>${srNo}</td>
                    <td><strong>${escapeHtml(itemName)}</strong></td>
                    <td>${escapeHtml(packages)}</td>
                    <td><span class="badge badge-danger">${qty}</span></td>
                    <td>
                        <span style="color: #d9534f; font-weight: bold;">${expDateFormatted}</span><br>
                        <span class="badge badge-danger" style="font-size: 11px;">Expired</span>
                    </td>
                    <td>${escapeHtml(billNo)}</td>
                    <td>${escapeHtml(vendor)}</td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Render Expiring Soon Table (within 30 days)
     */
    function renderExpiringSoonTable(items) {
        const tbody = document.getElementById('expiringSoonTableBody');
        const badgeCount = document.getElementById('expiringSoonBadgeCount');
        const statCount = document.getElementById('statExpiringSoonCount');

        if (badgeCount) badgeCount.textContent = items.length;
        if (statCount) statCount.textContent = items.length;

        if (!tbody) return;

        if (items.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 25px; color: #155724; background-color: #f4fbf5;">
                        <div style="font-size: 1.6rem; margin-bottom: 4px;">✓</div>
                        <strong>No medicines expiring within the next 30 days.</strong>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = items.map((item, idx) => {
            const srNo = idx + 1;
            const itemName = item.item_name || 'Item';
            const packages = item.packages || item.package || item.package_size || '-';
            const qty = (typeof item.quantity === 'number') 
                ? item.quantity 
                : (typeof item.available_quantity === 'number' ? item.available_quantity : (item.current_quantity || 0));
            const billNo = item.bill_no || '-';
            const expDateFormatted = item.expiryDetails?.formatted || formatDate(item.expiry_date);
            const daysDiff = item.expiryDetails?.daysDiff;

            let daysBadge = `<span class="badge badge-warning">${daysDiff} days</span>`;
            if (daysDiff === 0) {
                daysBadge = `<span class="badge badge-danger">Expires Today</span>`;
            } else if (daysDiff <= 15) {
                daysBadge = `<span class="badge badge-danger">${daysDiff} days</span>`;
            }

            return `
                <tr style="background-color: #fffbf0;">
                    <td>${srNo}</td>
                    <td><strong>${escapeHtml(itemName)}</strong></td>
                    <td>${escapeHtml(packages)}</td>
                    <td>${qty}</td>
                    <td><strong>${expDateFormatted}</strong></td>
                    <td>${daysBadge}</td>
                    <td>${escapeHtml(billNo)}</td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Render Total Alerts Summary Stat
     */
    function renderTotalAlerts() {
        const totalStat = document.getElementById('statTotalAlertsCount');
        const total = expiredItems.length + expiringSoonItems.length;
        if (totalStat) {
            totalStat.textContent = total;
        }
    }

    /**
     * Initialize Module
     */
    async function init() {
        const expiredTbody = document.getElementById('expiredTableBody');
        const expiringTbody = document.getElementById('expiringSoonTableBody');
        const errorAlert = document.getElementById('expiryAlertError');

        if (expiredTbody) {
            expiredTbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 25px; color: var(--text-soft);">
                        ⏳ Checking expired medicines...
                    </td>
                </tr>
            `;
        }
        if (expiringTbody) {
            expiringTbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 25px; color: var(--text-soft);">
                        ⏳ Checking near-expiry medicines (within 30 days)...
                    </td>
                </tr>
            `;
        }

        try {
            const rawRecords = await fetchExpiryData();
            processRecords(rawRecords);

            renderExpiredTable(expiredItems);
            renderExpiringSoonTable(expiringSoonItems);
            renderTotalAlerts();
        } catch (err) {
            console.error('Failed to load expiry alerts:', err);
            if (errorAlert) {
                errorAlert.textContent = `❌ Error retrieving expiry records: ${err.message || 'Database connection error.'}`;
                errorAlert.style.display = 'block';
            }
        }
    }

    return {
        init,
        fetchExpiryData,
        evaluateExpiryDetails,
        processRecords,
        renderExpiredTable,
        renderExpiringSoonTable
    };
}));
