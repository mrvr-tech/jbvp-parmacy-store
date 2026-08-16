/**
 * Lab Request Item Module
 * 
 * Manages item requisition submissions for authenticated laboratory accounts:
 * - Populates item dropdown from live store stock
 * - Enforces available quantity limits (prevents requesting > available)
 * - Inserts pending requisition records using authenticated profile identity
 * - NEVER deducts stock client-side (stock is deducted only upon Store Keeper approval)
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.LabRequestItemModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    let availableItems = [];
    let currentProfile = null;

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
     * Fetch in-stock items from Supabase
     */
    async function fetchInStockItems() {
        const client = getClient();

        // 1. Try v_current_stock
        try {
            const { data, error } = await client
                .from('v_current_stock')
                .select('*')
                .order('item_name', { ascending: true });

            if (!error && Array.isArray(data)) {
                return data;
            }
        } catch (e) {
            console.warn('v_current_stock fetch failed:', e);
        }

        // 2. Fallback to inventory_items
        try {
            const { data, error } = await client
                .from('inventory_items')
                .select('*')
                .order('item_name', { ascending: true });

            if (!error && Array.isArray(data)) {
                return data;
            }
            if (error) throw error;
        } catch (err) {
            console.error('Failed to fetch in-stock items:', err);
            throw err;
        }

        return [];
    }

    /**
     * Populate the select dropdown with live stock items
     */
    function populateDropdown(items) {
        const select = document.getElementById('item_id');
        if (!select) return;

        select.innerHTML = '<option value="">-- Choose an item from store --</option>';

        items.forEach(item => {
            const availQty = (typeof item.available_quantity === 'number') 
                ? item.available_quantity 
                : (typeof item.quantity === 'number' ? item.quantity : (item.current_quantity || 0));
            
            const itemName = item.item_name || 'Item';
            const packages = item.packages || item.package || item.package_size || '';
            const pkgStr = packages ? ` (${packages})` : '';
            const itemId = item.id || item.item_id || itemName;

            const opt = document.createElement('option');
            opt.value = itemId;
            opt.dataset.itemName = itemName;
            opt.dataset.availableQty = availQty;
            opt.dataset.packages = packages;

            if (availQty > 0) {
                opt.textContent = `${itemName}${pkgStr} — Available: ${availQty} units`;
            } else {
                opt.textContent = `${itemName}${pkgStr} — Out of Stock (0 units)`;
                opt.disabled = true;
            }

            select.appendChild(opt);
        });

        // Pre-select if URL param present
        const urlParams = new URLSearchParams(window.location.search);
        const itemParam = urlParams.get('item');
        if (itemParam) {
            const lowerParam = itemParam.trim().toLowerCase();
            for (let i = 0; i < select.options.length; i++) {
                const opt = select.options[i];
                if (opt.dataset.itemName && opt.dataset.itemName.toLowerCase() === lowerParam) {
                    select.selectedIndex = i;
                    handleItemChange();
                    break;
                }
            }
        }
    }

    /**
     * Handle item dropdown selection change
     */
    function handleItemChange() {
        const select = document.getElementById('item_id');
        const qtyInput = document.getElementById('quantity');
        const hintEl = document.getElementById('itemStockHint');

        if (!select || !qtyInput) return;

        const selectedOption = select.options[select.selectedIndex];
        if (!selectedOption || !selectedOption.value) {
            qtyInput.removeAttribute('max');
            if (hintEl) hintEl.style.display = 'none';
            return;
        }

        const availQty = parseInt(selectedOption.dataset.availableQty, 10) || 0;
        const packages = selectedOption.dataset.packages || '';

        qtyInput.max = availQty;
        if (parseInt(qtyInput.value, 10) > availQty) {
            qtyInput.value = availQty > 0 ? availQty : 1;
        }

        if (hintEl) {
            let msg = `📦 Current Store Stock: <strong>${availQty} units</strong>`;
            if (packages) msg += ` | Package: <strong>${escapeHtml(packages)}</strong>`;
            hintEl.innerHTML = msg;
            hintEl.style.display = 'block';
        }
    }

    /**
     * Handle requisition form submission
     */
    async function handleFormSubmit(event) {
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        const form = document.getElementById('requestItemForm');
        const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
        const errorAlert = document.getElementById('requestError');
        const successAlert = document.getElementById('requestSuccess');
        const select = document.getElementById('item_id');
        const qtyInput = document.getElementById('quantity');

        if (errorAlert) {
            errorAlert.style.display = 'none';
            errorAlert.innerHTML = '';
        }
        if (successAlert) {
            successAlert.style.display = 'none';
            successAlert.innerHTML = '';
        }

        const selectedOpt = select?.options[select.selectedIndex];
        if (!selectedOpt || !selectedOpt.value) {
            if (errorAlert) {
                errorAlert.innerHTML = '<strong>⚠️ Selection Required:</strong> Please select an item to request.';
                errorAlert.style.display = 'block';
            }
            return;
        }

        const qty = parseInt(qtyInput?.value, 10);
        const availQty = parseInt(selectedOpt.dataset.availableQty, 10) || 0;
        const itemName = selectedOpt.dataset.itemName || selectedOpt.textContent;
        const itemId = selectedOpt.value;

        if (isNaN(qty) || qty < 1) {
            if (errorAlert) {
                errorAlert.innerHTML = '<strong>⚠️ Invalid Quantity:</strong> Please enter a quantity of at least 1.';
                errorAlert.style.display = 'block';
            }
            return;
        }

        if (availQty > 0 && qty > availQty) {
            if (errorAlert) {
                errorAlert.innerHTML = `<strong>⚠️ Exceeds Stock:</strong> You requested ${qty} unit(s), but only ${availQty} unit(s) are available in store.`;
                errorAlert.style.display = 'block';
            }
            return;
        }

        // Disable submit button
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ Submitting Requisition...';
        }

        try {
            const client = getClient();
            const session = await auth.getSession();
            const user = session?.user;
            if (!user) throw new Error('User is not authenticated.');

            const profile = currentProfile || await auth.getCurrentProfile(user);
            const labName = profile.lab_name || profile.username || 'Lab User';
            const labId = profile.lab_id || profile.id || user.id;
            const today = new Date().toISOString().split('T')[0];

            // 1. Insert into lab_requests table
            const reqPayload = {
                lab_id: labId,
                lab_name: labName,
                user_id: user.id,
                item_id: isNaN(Number(itemId)) ? null : Number(itemId),
                item_name: itemName,
                quantity: qty,
                status: 'Pending',
                date: today
            };

            // Attempt insert into lab_requests
            const { data: reqInsertData, error: reqInsertErr } = await client
                .from('lab_requests')
                .insert([reqPayload])
                .select();

            if (reqInsertErr) {
                // If lab_requests has different column constraints, retry with core fields
                console.warn('First insert attempt error, trying minimal payload:', reqInsertErr.message);
                const minimalPayload = {
                    lab_name: labName,
                    item_name: itemName,
                    quantity: qty,
                    status: 'Pending'
                };
                const { error: minErr } = await client
                    .from('lab_requests')
                    .insert([minimalPayload]);
                if (minErr) throw minErr;
            }

            // If lab_request_items table exists in schema, create line item row
            if (reqInsertData && reqInsertData.length > 0) {
                const newReqId = reqInsertData[0].id;
                try {
                    await client.from('lab_request_items').insert([{
                        request_id: newReqId,
                        item_id: isNaN(Number(itemId)) ? null : Number(itemId),
                        item_name: itemName,
                        quantity: qty
                    }]);
                } catch (subErr) {
                    // Ignore if lab_request_items is not required/used
                    console.info('lab_request_items line item insert skipped or unneeded:', subErr);
                }
            }

            // Success feedback
            if (successAlert) {
                successAlert.innerHTML = `
                    <div style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <strong>✅ Requisition Submitted Successfully!</strong>
                            <p style="margin-top: 4px; font-size: 0.92rem;">
                                Requested <strong>${qty} unit(s)</strong> of <strong>${escapeHtml(itemName)}</strong>. Awaiting Store Keeper approval.
                            </p>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <a href="request-history.html" class="btn" style="padding: 6px 14px; font-size: 13px; min-height: auto;">View Request History →</a>
                        </div>
                    </div>
                `;
                successAlert.style.display = 'block';
                successAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            // Reset form
            form.reset();
            const hintEl = document.getElementById('itemStockHint');
            if (hintEl) hintEl.style.display = 'none';

        } catch (err) {
            console.error('Failed to submit requisition:', err);
            if (errorAlert) {
                errorAlert.innerHTML = `<strong>❌ Requisition Error:</strong> ${escapeHtml(err.message || 'Failed to submit requisition. Please try again.')}`;
                errorAlert.style.display = 'block';
                errorAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '✓ Submit Request';
            }
        }
    }

    /**
     * Initialize Module
     */
    async function init(userAuth) {
        if (userAuth && userAuth.profile) {
            currentProfile = userAuth.profile;
            if (userAuth.profile.lab_name) {
                const titleEl = document.getElementById('labHeaderTitle');
                if (titleEl) {
                    titleEl.textContent = `📝 ${userAuth.profile.lab_name} Requisition Portal`;
                }
            }
        }

        const select = document.getElementById('item_id');
        if (select) {
            select.innerHTML = '<option value="">⏳ Loading stock items from store...</option>';
            select.addEventListener('change', handleItemChange);
        }

        const form = document.getElementById('requestItemForm');
        if (form) {
            form.addEventListener('submit', handleFormSubmit);
        }

        try {
            availableItems = await fetchInStockItems();
            populateDropdown(availableItems);
        } catch (err) {
            console.error('Failed to load stock items into dropdown:', err);
            if (select) {
                select.innerHTML = '<option value="">⚠️ Error loading store items</option>';
            }
        }
    }

    return {
        init,
        fetchInStockItems,
        handleItemChange,
        handleFormSubmit
    };
}));
