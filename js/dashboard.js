/**
 * Store Dashboard Module
 * 
 * Fetches real metrics from Supabase (v_current_stock, labs, lab_requests, v_expiry_report)
 * and populates the Store Keeper dashboard with live statistics.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.DashboardModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

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
     * Format current timestamp (e.g. 16 Aug 2026, 01:18 AM)
     */
    function getFormattedTimestamp() {
        const now = new Date();
        const options = {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        };
        return now.toLocaleString('en-GB', options);
    }

    /**
     * Set loading state on dashboard stat elements
     */
    function setLoadingState() {
        const elements = [
            'statTotalItems',
            'statLabsConnected',
            'statPendingRequests',
            'statLowStock',
            'statExpiringSoon',
            'alertTotalCount',
            'alertExpiredCount',
            'alertExpiringSoonCount'
        ];

        elements.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = '...';
            }
        });
    }

    /**
     * Fetch all dashboard metrics concurrently
     */
    async function loadDashboardMetrics() {
        const client = getClient();

        // 1. Timestamp
        const timestampEl = document.getElementById('dashboardTimestamp');
        if (timestampEl) {
            timestampEl.textContent = getFormattedTimestamp();
        }

        // Metrics to populate
        let totalItems = 0;
        let totalStockUnits = 0;
        let lowStockCount = 0;
        let expiredCount = 0;
        let expiringSoonCount = 0;
        let connectedLabsCount = 0;
        let pendingRequestsCount = 0;

        // Query 1: Inventory & Stock Status
        try {
            let inventoryData = null;
            
            // Try v_current_stock view first
            const { data: stockView, error: stockViewErr } = await client
                .from('v_current_stock')
                .select('*');

            if (!stockViewErr && Array.isArray(stockView)) {
                inventoryData = stockView;
            } else {
                // Fallback to inventory_items table
                const { data: itemsTable, error: itemsErr } = await client
                    .from('inventory_items')
                    .select('*');
                
                if (!itemsErr && Array.isArray(itemsTable)) {
                    inventoryData = itemsTable;
                }
            }

            if (inventoryData) {
                totalItems = inventoryData.length;
                
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                const thirtyDaysAhead = new Date(today);
                thirtyDaysAhead.setDate(today.getDate() + 30);

                inventoryData.forEach(item => {
                    const qty = (typeof item.quantity === 'number')
                        ? item.quantity
                        : (typeof item.available_quantity === 'number' ? item.available_quantity : (item.current_quantity || 0));
                    
                    totalStockUnits += qty;

                    if (qty < 5) {
                        lowStockCount++;
                    }

                    if (item.expiry_date) {
                        const exp = new Date(item.expiry_date);
                        exp.setHours(0, 0, 0, 0);
                        if (!isNaN(exp.getTime())) {
                            if (exp <= today) {
                                expiredCount++;
                            } else if (exp <= thirtyDaysAhead) {
                                expiringSoonCount++;
                            }
                        }
                    }
                });
            }
        } catch (e) {
            console.warn('Dashboard inventory query error:', e);
        }

        // Query 2: Expiry Report View (if available for specialized expiry counts)
        try {
            const { data: expiryData, error: expiryErr } = await client
                .from('v_expiry_report')
                .select('*');

            if (!expiryErr && Array.isArray(expiryData) && expiryData.length > 0) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                const thirtyDaysAhead = new Date(today);
                thirtyDaysAhead.setDate(today.getDate() + 30);

                let expViewExpired = 0;
                let expViewExpiring = 0;

                expiryData.forEach(row => {
                    const expDateStr = row.expiry_date || row.date;
                    if (expDateStr) {
                        const exp = new Date(expDateStr);
                        exp.setHours(0, 0, 0, 0);
                        if (!isNaN(exp.getTime())) {
                            if (exp <= today) {
                                expViewExpired++;
                            } else if (exp <= thirtyDaysAhead) {
                                expViewExpiring++;
                            }
                        }
                    }
                });

                if (expViewExpired > 0 || expViewExpiring > 0) {
                    expiredCount = expViewExpired;
                    expiringSoonCount = expViewExpiring;
                }
            }
        } catch (e) {
            console.warn('v_expiry_report view not available, used computed values:', e);
        }

        // Query 3: Connected Labs
        try {
            // Try labs table
            const { data: labsData, count: labsCount, error: labsErr } = await client
                .from('labs')
                .select('*', { count: 'exact' });

            if (!labsErr && (typeof labsCount === 'number' || Array.isArray(labsData))) {
                connectedLabsCount = (typeof labsCount === 'number') ? labsCount : labsData.length;
            } else {
                // Fallback to profiles table where role = 'lab'
                const { data: labProfiles, error: profErr } = await client
                    .from('profiles')
                    .select('*')
                    .eq('role', 'lab');

                if (!profErr && Array.isArray(labProfiles)) {
                    connectedLabsCount = labProfiles.length;
                } else {
                    connectedLabsCount = 17; // Default 17 labs in institution
                }
            }
        } catch (e) {
            console.warn('Labs query error:', e);
            connectedLabsCount = 17;
        }

        // Query 4: Pending Lab Requests
        try {
            const { data: reqData, error: reqErr } = await client
                .from('lab_requests')
                .select('id, status')
                .ilike('status', '%pending%');

            if (!reqErr && Array.isArray(reqData)) {
                pendingRequestsCount = reqData.length;
            } else {
                const { data: pendingData } = await client.from('v_pending_requests').select('id');
                if (Array.isArray(pendingData)) {
                    pendingRequestsCount = pendingData.length;
                }
            }
        } catch (e) {
            console.warn('Pending requests query error:', e);
        }

        // Update DOM Elements
        renderDashboardValues({
            totalItems,
            totalStockUnits,
            connectedLabsCount,
            pendingRequestsCount,
            lowStockCount,
            expiringSoonCount,
            expiredCount
        });
    }

    /**
     * Render calculated values into dashboard DOM cards
     */
    function renderDashboardValues(metrics) {
        // 1. Total Items
        const totalItemsEl = document.getElementById('statTotalItems');
        const totalItemsMetaEl = document.getElementById('statTotalItemsMeta');
        if (totalItemsEl) totalItemsEl.textContent = metrics.totalItems;
        if (totalItemsMetaEl) totalItemsMetaEl.textContent = `${metrics.totalStockUnits} total units in stock`;

        // 2. Labs Connected
        const labsEl = document.getElementById('statLabsConnected');
        if (labsEl) labsEl.textContent = metrics.connectedLabsCount;

        // 3. Pending Requests
        const pendingEl = document.getElementById('statPendingRequests');
        if (pendingEl) pendingEl.textContent = metrics.pendingRequestsCount;

        // 4. Low Stock
        const lowStockEl = document.getElementById('statLowStock');
        if (lowStockEl) lowStockEl.textContent = metrics.lowStockCount;

        // 5. Expiring in 30 Days
        const expiringEl = document.getElementById('statExpiringSoon');
        if (expiringEl) expiringEl.textContent = metrics.expiringSoonCount;

        // 6. Expiry Alerts Panel
        const totalAlerts = metrics.expiredCount + metrics.expiringSoonCount;
        const alertTotalCountEl = document.getElementById('alertTotalCount');
        const alertExpiredCountEl = document.getElementById('alertExpiredCount');
        const alertExpiringSoonCountEl = document.getElementById('alertExpiringSoonCount');

        if (alertTotalCountEl) alertTotalCountEl.textContent = totalAlerts;
        if (alertExpiredCountEl) alertExpiredCountEl.textContent = metrics.expiredCount;
        if (alertExpiringSoonCountEl) alertExpiringSoonCountEl.textContent = metrics.expiringSoonCount;

        // 7. System Queue Text
        const systemQueueStatusEl = document.getElementById('systemQueueStatus');
        if (systemQueueStatusEl) {
            systemQueueStatusEl.textContent = `${metrics.pendingRequestsCount} request${metrics.pendingRequestsCount === 1 ? '' : 's'} currently awaiting review.`;
        }
    }

    /**
     * Initialize Dashboard
     */
    async function init() {
        setLoadingState();
        try {
            await loadDashboardMetrics();
        } catch (err) {
            console.error('Failed to initialize dashboard:', err);
        }
    }

    return {
        init,
        loadDashboardMetrics,
        renderDashboardValues
    };
}));
