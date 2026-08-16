/**
 * Lab Request History Module
 * 
 * Fetches and displays private requisition history and status audit for the authenticated laboratory.
 * Respects RLS and queries strictly by authenticated user / lab profile.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'), require('./supabase'), require('./auth'));
    } else {
        root.LabRequestHistoryModule = factory(root.APP_CONFIG, root.SupabaseService, root.Auth);
    }
}(typeof self !== 'undefined' ? self : this, function (config, supabaseService, auth) {

    let historyRecords = [];

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
     * Fetch private history for the authenticated user's lab
     */
    async function fetchLabHistory(profile, user) {
        const client = getClient();
        const labName = profile?.lab_name;
        const labId = profile?.lab_id || profile?.id || user?.id;

        // 1. Try v_lab_request_report view
        try {
            let query = client.from('v_lab_request_report').select('*');
            if (labName) {
                query = query.eq('lab_name', labName);
            }
            const { data, error } = await query.order('date', { ascending: false });

            if (!error && Array.isArray(data)) {
                return data;
            }
        } catch (e) {
            console.warn('v_lab_request_report query failed:', e);
        }

        // 2. Fallback to lab_requests table
        try {
            let query = client.from('lab_requests').select('*');
            if (labName) {
                query = query.eq('lab_name', labName);
            } else if (labId) {
                query = query.or(`lab_id.eq.${labId},user_id.eq.${user?.id}`);
            }
            const { data, error } = await query.order('created_at', { ascending: false });

            if (!error && Array.isArray(data)) {
                return data;
            }
            if (error) throw error;
        } catch (err) {
            console.error('Failed to fetch lab request history:', err);
            throw err;
        }

        return [];
    }

    /**
     * Render history stats and table
     */
    function renderHistory(records) {
        const totalCountEl = document.getElementById('historyTotalCount');
        const approvedCountEl = document.getElementById('historyApprovedCount');
        const pendingCountEl = document.getElementById('historyPendingCount');
        const rejectedCountEl = document.getElementById('historyRejectedCount');
        const tbody = document.querySelector('tbody');

        let approvedCount = 0;
        let pendingCount = 0;
        let rejectedCount = 0;

        records.forEach(r => {
            const status = (r.status || '').toLowerCase();
            if (status.includes('approv')) approvedCount++;
            else if (status.includes('reject')) rejectedCount++;
            else pendingCount++;
        });

        if (totalCountEl) totalCountEl.textContent = records.length;
        if (approvedCountEl) approvedCountEl.textContent = approvedCount;
        if (pendingCountEl) pendingCountEl.textContent = pendingCount;
        if (rejectedCountEl) rejectedCountEl.textContent = rejectedCount;

        if (!tbody) return;

        if (records.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 35px; color: #6a7a6f;">
                        <div style="font-size: 1.8rem; margin-bottom: 6px;">📝</div>
                        <strong>No requisition history found for your lab.</strong>
                        <p style="margin-top: 4px; font-size: 0.88rem; color: #8c9b91;">
                            Click "Make New Request" to submit a stock requisition.
                        </p>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = records.map((r, idx) => {
            const srNo = idx + 1;
            const itemName = r.item_name || r.item || 'Item';
            const reqQty = r.quantity || r.requested_quantity || 1;
            const appQty = r.approved_quantity !== undefined ? r.approved_quantity : (r.status === 'Approved' ? reqQty : 0);
            const reqDate = formatDate(r.date || r.created_at);
            const rawStatus = (r.status || 'Pending').toLowerCase();

            let statusBadge = `<span class="badge badge-warning">⏳ Pending</span>`;
            if (rawStatus.includes('approv')) {
                statusBadge = `<span class="badge badge-success">✓ Approved</span>`;
            } else if (rawStatus.includes('reject')) {
                statusBadge = `<span class="badge badge-danger">✗ Rejected</span>`;
            }

            return `
                <tr>
                    <td>${srNo}</td>
                    <td><strong>${escapeHtml(itemName)}</strong></td>
                    <td>${reqQty}</td>
                    <td>${rawStatus.includes('approv') ? `<strong>${appQty}</strong>` : (rawStatus.includes('reject') ? '0' : '-')}</td>
                    <td>${reqDate}</td>
                    <td>${statusBadge}</td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Initialize Module
     */
    async function init(userAuth) {
        if (userAuth && userAuth.profile && userAuth.profile.lab_name) {
            const titleEl = document.getElementById('labHeaderTitle');
            if (titleEl) {
                titleEl.textContent = `📋 ${userAuth.profile.lab_name} Request History`;
            }
        }

        const tbody = document.querySelector('tbody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 25px; color: var(--text-soft);">
                        ⏳ Loading requisition history...
                    </td>
                </tr>
            `;
        }

        try {
            const profile = userAuth?.profile;
            const user = userAuth?.session?.user;
            historyRecords = await fetchLabHistory(profile, user);
            renderHistory(historyRecords);
        } catch (err) {
            console.error('Failed to load lab requisition history:', err);
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" style="text-align: center; padding: 25px; color: #a4332b;">
                            ⚠️ Unable to retrieve request history from Supabase.
                        </td>
                    </tr>
                `;
            }
        }
    }

    return {
        init,
        fetchLabHistory,
        renderHistory
    };
}));
