/**
 * Store Inventory Management Module
 * 
 * Fetches real inventory records from Supabase, handles search,
 * category filtering, stock/expiry status badges, and loading/empty/error states.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.InventoryModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    // Category display lookup
    const CATEGORY_MAP = {
        'chemicals': 'Chemicals',
        'glassware': 'Glassware',
        'instruments': 'Instruments',
        'computer': 'Computer Store',
        'other': 'Other'
    };

    let allItems = [];
    let currentFiltered = [];
    let activeSource = 'v_current_stock'; // Tracks which view/table was successfully queried

    /**
     * Get Supabase client instance
     */
    function getClient() {
        const client = supabaseService && supabaseService.getClient();
        if (!client) {
            throw new Error('Supabase client is not available.');
        }
        return client;
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
     * Check if a date is expired or expiring soon (within 30 days)
     * @param {string} expiryDateStr 
     * @returns {{ isExpired: boolean, isExpiringSoon: boolean, formatted: string }}
     */
    function evaluateExpiry(expiryDateStr) {
        if (!expiryDateStr) {
            return { isExpired: false, isExpiringSoon: false, formatted: '-' };
        }

        const formatted = formatDate(expiryDateStr);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const expDate = new Date(expiryDateStr);
        expDate.setHours(0, 0, 0, 0);

        if (isNaN(expDate.getTime())) {
            return { isExpired: false, isExpiringSoon: false, formatted };
        }

        const isExpired = expDate <= today;
        
        const thirtyDaysFromNow = new Date(today);
        thirtyDaysFromNow.setDate(today.getDate() + 30);
        const isExpiringSoon = !isExpired && (expDate <= thirtyDaysFromNow);

        return { isExpired, isExpiringSoon, formatted };
    }

    /**
     * Fetch inventory from Supabase (tries v_current_stock view first, falls back to inventory_items)
     */
    async function fetchInventory() {
        const client = getClient();
        
        // 1. Try querying v_current_stock view
        try {
            const { data, error } = await client
                .from('v_current_stock')
                .select('*')
                .order('item_name', { ascending: true });

            if (!error && Array.isArray(data)) {
                activeSource = 'v_current_stock';
                return data;
            }
            if (error) {
                console.warn('v_current_stock query not available, falling back to inventory_items:', error.message);
            }
        } catch (e) {
            console.warn('Exception querying v_current_stock:', e);
        }

        // 2. Fallback to querying inventory_items directly
        try {
            const { data, error } = await client
                .from('inventory_items')
                .select('*')
                .order('item_name', { ascending: true });

            if (error) {
                throw error;
            }
            activeSource = 'inventory_items';
            return data || [];
        } catch (err) {
            console.error('Failed to query inventory_items:', err);
            throw err;
        }
    }

    /**
     * Render items table in the DOM
     */
    function renderTable(items) {
        const tbody = document.querySelector('tbody');
        if (!tbody) return;

        if (!items || items.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="11" style="text-align: center; padding: 35px; color: #6a7a6f;">
                        <div style="font-size: 2rem; margin-bottom: 8px;">📦</div>
                        <strong>No inventory items found.</strong>
                        <p style="margin-top: 4px; font-size: 0.9rem; color: #8c9b91;">
                            There are currently no matching records in the inventory database.
                        </p>
                    </td>
                </tr>
            `;
            return;
        }

        const rowsHtml = items.map((item, idx) => {
            const srNo = item.sr_no || item.id || (idx + 1);
            const rawCategory = (item.category || 'other').toLowerCase();
            const categoryLabel = CATEGORY_MAP[rawCategory] || (item.category || 'Other');
            const itemName = item.item_name || 'Unnamed Item';
            const packages = item.packages || item.package || item.package_size || 'N/A';
            const qty = (typeof item.quantity === 'number') 
                ? item.quantity 
                : (typeof item.available_quantity === 'number' ? item.available_quantity : (item.current_quantity || 0));
            const price = parseFloat(item.price || 0).toFixed(2);
            const billNo = item.bill_no || '-';
            const entryDate = formatDate(item.date || item.created_at);
            
            // Expiry Badge
            const expiryInfo = evaluateExpiry(item.expiry_date);
            let expiryBadge = `<span class="badge badge-success">${expiryInfo.formatted}</span>`;
            if (expiryInfo.isExpired) {
                expiryBadge = `<span class="badge badge-danger">${expiryInfo.formatted} (Expired)</span>`;
            } else if (expiryInfo.isExpiringSoon) {
                expiryBadge = `<span class="badge badge-warning">${expiryInfo.formatted} (Expiring)</span>`;
            }

            // Quantity Badge
            let qtyBadge = `<span class="badge badge-success">${qty}</span>`;
            if (qty <= 0) {
                qtyBadge = `<span class="badge badge-danger">0</span>`;
            } else if (qty < 5) {
                qtyBadge = `<span class="badge badge-danger">${qty}</span>`;
            } else if (qty < 10) {
                qtyBadge = `<span class="badge badge-warning">${qty}</span>`;
            }

            // Stock Status Badge
            let statusBadge = `<span class="badge badge-success">In Stock</span>`;
            if (qty <= 0) {
                statusBadge = `<span class="badge badge-danger">Out of Stock</span>`;
            } else if (qty < 5) {
                statusBadge = `<span class="badge badge-danger">Low Stock</span>`;
            }

            return `
                <tr>
                    <td>${srNo}</td>
                    <td>${categoryLabel}</td>
                    <td><strong>${escapeHtml(itemName)}</strong></td>
                    <td>${escapeHtml(packages)}</td>
                    <td>${qtyBadge}</td>
                    <td>Rs. ${price}</td>
                    <td>${escapeHtml(billNo)}</td>
                    <td>${entryDate}</td>
                    <td>${expiryBadge}</td>
                    <td>${escapeHtml(item.vendor_name || '-')}</td>
                    <td>${statusBadge}</td>
                </tr>
            `;
        }).join('');

        tbody.innerHTML = rowsHtml;
    }

    /**
     * Escape HTML string to prevent XSS
     */
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Filter items locally by search query and category
     */
    function applyFilters() {
        const searchInput = document.getElementById('searchInput');
        const categorySelect = document.getElementById('categorySelect');
        const filterInfoContainer = document.getElementById('filterInfo');

        const query = (searchInput?.value || '').trim().toLowerCase();
        const selectedCategory = (categorySelect?.value || '').trim().toLowerCase();

        currentFiltered = allItems.filter(item => {
            const matchesQuery = !query || 
                (item.item_name && item.item_name.toLowerCase().includes(query)) ||
                (item.vendor_name && item.vendor_name.toLowerCase().includes(query)) ||
                (item.bill_no && item.bill_no.toLowerCase().includes(query));

            const itemCategory = (item.category || '').toLowerCase();
            const matchesCategory = !selectedCategory || (itemCategory === selectedCategory);

            return matchesQuery && matchesCategory;
        });

        // Update Filtered Results banner if present
        if (filterInfoContainer) {
            if (query || selectedCategory) {
                const categoryLabel = CATEGORY_MAP[selectedCategory] || selectedCategory;
                let text = `Showing ${currentFiltered.length} item(s)`;
                if (query) text += ` matching "${escapeHtml(query)}"`;
                if (selectedCategory) text += ` in ${categoryLabel}`;

                filterInfoContainer.innerHTML = `
                    <div class="alert alert-info" style="margin-bottom: 15px; padding: 12px 16px;">
                        <strong>Filtered Results:</strong> ${text}
                    </div>
                `;
                filterInfoContainer.style.display = 'block';
            } else {
                filterInfoContainer.innerHTML = '';
                filterInfoContainer.style.display = 'none';
            }
        }

        renderTable(currentFiltered);
    }

    /**
     * Initialize the Inventory page
     */
    async function init() {
        const tbody = document.querySelector('tbody');
        const errorContainer = document.getElementById('inventoryError');

        // Show loading state
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="11" style="text-align: center; padding: 30px; color: var(--text-soft);">
                        <div style="font-size: 1.5rem; margin-bottom: 8px;">⏳</div>
                        <strong>Loading real inventory data from Supabase...</strong>
                    </td>
                </tr>
            `;
        }

        try {
            allItems = await fetchInventory();
            currentFiltered = [...allItems];
            renderTable(currentFiltered);

            // Hook up Filter and Search Listeners
            const filterForm = document.getElementById('filterForm');
            const searchInput = document.getElementById('searchInput');
            const categorySelect = document.getElementById('categorySelect');

            if (filterForm) {
                filterForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    applyFilters();
                });
            }

            if (searchInput) {
                searchInput.addEventListener('input', applyFilters);
            }

            if (categorySelect) {
                categorySelect.addEventListener('change', applyFilters);
            }

        } catch (err) {
            console.error('Inventory load failed:', err);
            
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="11" style="text-align: center; padding: 30px; color: #a4332b;">
                            <div style="font-size: 1.5rem; margin-bottom: 8px;">⚠️</div>
                            <strong>Unable to load inventory data from Supabase.</strong>
                            <p style="margin-top: 6px; font-size: 0.88rem; color: #721c24;">
                                ${escapeHtml(err.message || 'Database connection error.')}
                            </p>
                        </td>
                    </tr>
                `;
            }

            if (errorContainer) {
                errorContainer.textContent = `❌ Database Error: ${err.message || 'Failed to fetch inventory records.'}`;
                errorContainer.style.display = 'block';
            }
        }
    }

    return {
        init,
        fetchInventory,
        applyFilters,
        renderTable,
        get activeSource() {
            return activeSource;
        }
    };
}));
