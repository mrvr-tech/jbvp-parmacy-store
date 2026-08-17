/**
 * Add Item Service Module
 * 
 * Handles client-side validation and executes public.add_inventory_entry(...) RPC
 * on Supabase to record new purchase entries and automatically update consolidated stock.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.AddItemModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
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
     * Escape HTML string
     */
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Validate form data
     * @param {Object} formData 
     * @returns {{ valid: boolean, errors: string[] }}
     */
    function validateForm(formData) {
        const errors = [];

        if (!formData.category) {
            errors.push('Category is required.');
        }

        if (!formData.item_name || !formData.item_name.trim()) {
            errors.push('Item Name is required.');
        }

        const qty = parseInt(formData.quantity, 10);
        if (isNaN(qty) || qty < 1) {
            errors.push('Quantity must be a positive number (minimum 1).');
        }

        const price = parseFloat(formData.price);
        if (isNaN(price) || price < 0) {
            errors.push('Price must be a valid non-negative number.');
        }

        const tax = parseFloat(formData.tax);
        if (isNaN(tax) || tax < 0) {
            errors.push('Tax must be a valid non-negative number.');
        }

        if (!formData.bill_no || !formData.bill_no.trim()) {
            errors.push('Bill / Invoice Number is required.');
        }

        if (!formData.date) {
            errors.push('Purchase Date is required.');
        }

        if (!formData.expiry_date) {
            errors.push('Expiry Date is required.');
        }

        if (!formData.vendor_name || !formData.vendor_name.trim()) {
            errors.push('Vendor Name is required.');
        }

        if (!formData.vendor_address || !formData.vendor_address.trim()) {
            errors.push('Vendor Address is required.');
        }

        if (!formData.vendor_pan || !formData.vendor_pan.trim()) {
            errors.push('Vendor PAN is required.');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Format category to exact PostgreSQL inventory_category_enum casing
     */
    function formatCategoryForEnum(cat) {
        if (!cat) return 'Other';
        const lower = cat.trim().toLowerCase();
        if (lower === 'chemicals' || lower === 'chemical') return 'Chemicals';
        if (lower === 'glassware' || lower === 'glass') return 'Glassware';
        if (lower === 'instruments' || lower === 'instrument' || lower === 'equipment' || lower === 'equipments' || lower === 'computer') return 'Instruments';
        return 'Other';
    }

    /**
     * Call public.add_inventory_entry RPC on Supabase
     * Supports both p_ prefixed parameter signatures and standard naming.
     */
    async function submitInventoryEntry(formData) {
        const client = getClient();

        const category = formatCategoryForEnum(formData.category);
        const itemName = (formData.item_name || '').trim();
        const packages = (formData.packages && formData.packages.trim()) ? formData.packages.trim() : null;
        const quantity = parseInt(formData.quantity, 10);
        const price = parseFloat(formData.price) || 0;
        const tax = parseFloat(formData.tax) || 0;
        const billNo = (formData.bill_no || '').trim();
        const date = formData.date;
        const expiryDate = formData.expiry_date;
        const vendorName = (formData.vendor_name || '').trim();
        const vendorAddress = (formData.vendor_address || '').trim();
        const vendorPan = (formData.vendor_pan || '').trim().toUpperCase();

        // 1. Try canonical database signature (_ prefix with _sr_no)
        const payloadUnderscore = {
            _category: category,
            _item_name: itemName,
            _packages: packages,
            _quantity: quantity,
            _price: price,
            _tax: tax,
            _bill_no: billNo,
            _date: date,
            _expiry_date: expiryDate,
            _vendor_name: vendorName,
            _vendor_address: vendorAddress,
            _vendor_pan: vendorPan,
            _sr_no: null
        };

        let result = await client.rpc('add_inventory_entry', payloadUnderscore);

        if (result.error) {
            const errMsg = (result.error.message || '').toLowerCase();
            if (errMsg.includes('parameter') || errMsg.includes('signature') || errMsg.includes('not found') || errMsg.includes('named')) {
                console.warn('Retrying add_inventory_entry RPC with p_ prefixed parameter payload...');
                
                const payloadPrefixed = {
                    p_category: category,
                    p_item_name: itemName,
                    p_packages: packages,
                    p_quantity: quantity,
                    p_price: price,
                    p_tax: tax,
                    p_bill_no: billNo,
                    p_date: date,
                    p_expiry_date: expiryDate,
                    p_vendor_name: vendorName,
                    p_vendor_address: vendorAddress,
                    p_vendor_pan: vendorPan
                };

                result = await client.rpc('add_inventory_entry', payloadPrefixed);

                if (result.error) {
                    const errMsg2 = (result.error.message || '').toLowerCase();
                    if (errMsg2.includes('parameter') || errMsg2.includes('signature') || errMsg2.includes('not found') || errMsg2.includes('named')) {
                        console.warn('Retrying add_inventory_entry RPC with non-prefixed parameter payload...');
                        
                        const payloadUnprefixed = {
                            category: category,
                            item_name: itemName,
                            packages: packages,
                            quantity: quantity,
                            price: price,
                            tax: tax,
                            bill_no: billNo,
                            date: date,
                            expiry_date: expiryDate,
                            vendor_name: vendorName,
                            vendor_address: vendorAddress,
                            vendor_pan: vendorPan
                        };

                        result = await client.rpc('add_inventory_entry', payloadUnprefixed);
                    }
                }
            }
        }

        if (result.error) {
            console.warn('RPC add_inventory_entry failed, attempting direct table insert fallback:', result.error.message);
            
            try {
                // 1. Find or create item in inventory_items
                let itemId = null;
                const { data: existingItems } = await client
                    .from('inventory_items')
                    .select('*')
                    .ilike('item_name', itemName)
                    .limit(1);

                if (existingItems && existingItems.length > 0) {
                    const existing = existingItems[0];
                    itemId = existing.id;
                    const newStock = (parseInt(existing.current_stock, 10) || 0) + quantity;
                    const newTotal = (parseInt(existing.total_quantity, 10) || 0) + quantity;

                    await client
                        .from('inventory_items')
                        .update({
                            current_stock: newStock,
                            total_quantity: newTotal,
                            price: price,
                            tax: tax,
                            expiry_date: expiryDate,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', itemId);
                } else {
                    const { data: newItem, error: newItemErr } = await client
                        .from('inventory_items')
                        .insert([{
                            category: category,
                            item_name: itemName,
                            packages: packages,
                            current_stock: quantity,
                            total_quantity: quantity,
                            price: price,
                            tax: tax,
                            expiry_date: expiryDate
                        }])
                        .select()
                        .single();

                    if (!newItemErr && newItem) {
                        itemId = newItem.id;
                    }
                }

                // 2. Insert into inventory_entries
                const { data: entryData, error: entryErr } = await client
                    .from('inventory_entries')
                    .insert([{
                        item_id: itemId,
                        category: category,
                        item_name: itemName,
                        packages: packages,
                        quantity: quantity,
                        price: price,
                        tax: tax,
                        bill_no: billNo,
                        date: date,
                        expiry_date: expiryDate,
                        vendor_name: vendorName,
                        vendor_address: vendorAddress,
                        vendor_pan: vendorPan
                    }])
                    .select()
                    .single();

                if (entryErr) {
                    throw entryErr;
                }

                return entryData || { success: true };
            } catch (fallbackErr) {
                console.error('Direct fallback insert error:', fallbackErr);
                throw new Error(result.error.message || fallbackErr.message);
            }
        }

        return result.data;
    }

    /**
     * Handle form submission event
     */
    async function handleFormSubmit(event) {
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        const form = document.getElementById('addItemForm');
        const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
        const errorAlert = document.getElementById('formError');
        const successAlert = document.getElementById('formSuccess');

        // Hide prior alerts
        if (errorAlert) {
            errorAlert.style.display = 'none';
            errorAlert.innerHTML = '';
        }
        if (successAlert) {
            successAlert.style.display = 'none';
            successAlert.innerHTML = '';
        }

        // Collect form data
        const formData = {
            category: document.getElementById('category')?.value || '',
            item_name: document.getElementById('item_name')?.value || '',
            packages: document.getElementById('packages')?.value || '',
            quantity: document.getElementById('quantity')?.value || '',
            price: document.getElementById('price')?.value || '',
            tax: document.getElementById('tax')?.value || '',
            bill_no: document.getElementById('bill_no')?.value || '',
            date: document.getElementById('date')?.value || '',
            expiry_date: document.getElementById('expiry_date')?.value || '',
            vendor_name: document.getElementById('vendor_name')?.value || '',
            vendor_address: document.getElementById('vendor_address')?.value || '',
            vendor_pan: document.getElementById('vendor_pan')?.value || ''
        };

        // Client-side Validation
        const validation = validateForm(formData);
        if (!validation.valid) {
            if (errorAlert) {
                errorAlert.innerHTML = `<strong>⚠️ Please correct the following:</strong><ul style="margin: 8px 0 0 18px;">${validation.errors.map(err => `<li>${escapeHtml(err)}</li>`).join('')}</ul>`;
                errorAlert.style.display = 'block';
                errorAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            return;
        }

        // Prevent double submission
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ Saving Item to Database...';
        }

        try {
            await submitInventoryEntry(formData);

            // Display Success Feedback
            if (successAlert) {
                successAlert.innerHTML = `
                    <div style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <strong>✅ Item Saved Successfully!</strong>
                            <p style="margin-top: 4px; font-size: 0.92rem;">
                                Added <strong>${escapeHtml(formData.quantity)} unit(s)</strong> of <strong>${escapeHtml(formData.item_name)}</strong> to store inventory.
                            </p>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <a href="inventory.html" class="btn" style="padding: 6px 14px; font-size: 13px; min-height: auto;">View Inventory Table →</a>
                        </div>
                    </div>
                `;
                successAlert.style.display = 'block';
                successAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            // Reset form for next entry
            resetForm();

        } catch (err) {
            console.error('RPC Error executing add_inventory_entry:', err);

            if (errorAlert) {
                const message = err.message || 'Failed to save inventory entry in database.';
                errorAlert.innerHTML = `<strong>❌ Error Adding Item:</strong><p style="margin-top: 4px;">${escapeHtml(message)}</p>`;
                errorAlert.style.display = 'block';
                errorAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        } finally {
            // Restore button state
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Add Item';
            }
        }
    }

    /**
     * Reset form fields to clean state
     */
    function resetForm() {
        const form = document.getElementById('addItemForm');
        if (!form) return;

        form.reset();

        // Set default date to today
        const dateInput = document.getElementById('date');
        if (dateInput) {
            const today = new Date().toISOString().split('T')[0];
            dateInput.value = today;
        }

        // Set default expiry date to 2 years from today
        const expiryInput = document.getElementById('expiry_date');
        if (expiryInput) {
            const future = new Date();
            future.setFullYear(future.getFullYear() + 2);
            expiryInput.value = future.toISOString().split('T')[0];
        }

        // Set default quantity and tax
        const qtyInput = document.getElementById('quantity');
        if (qtyInput) qtyInput.value = '1';

        const taxInput = document.getElementById('tax');
        if (taxInput) taxInput.value = '0';
    }

    /**
     * Initialize the Add Item form
     */
    function init() {
        const form = document.getElementById('addItemForm');
        if (form) {
            form.addEventListener('submit', handleFormSubmit);
        }

        // Set initial dates if empty
        const dateInput = document.getElementById('date');
        if (dateInput && !dateInput.value) {
            dateInput.value = new Date().toISOString().split('T')[0];
        }

        const expiryInput = document.getElementById('expiry_date');
        if (expiryInput && !expiryInput.value) {
            const future = new Date();
            future.setFullYear(future.getFullYear() + 2);
            expiryInput.value = future.toISOString().split('T')[0];
        }
    }

    return {
        init,
        submitInventoryEntry,
        handleFormSubmit,
        validateForm,
        resetForm
    };
}));
