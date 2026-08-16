/**
 * Supabase Client Initialization
 * 
 * Uses the official Supabase JavaScript client (@supabase/supabase-js).
 * Provides a singleton client instance for the entire application.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config'));
    } else {
        root.SupabaseService = factory(root.APP_CONFIG);
    }
}(typeof self !== 'undefined' ? self : this, function (config) {
    if (!config) {
        console.error('APP_CONFIG not found. Ensure js/config.js is loaded prior to js/supabase.js');
    }

    let supabaseInstance = null;

    /**
     * Get or create the Supabase client instance
     * @returns {import('@supabase/supabase-js').SupabaseClient}
     */
    function getClient() {
        if (supabaseInstance) {
            return supabaseInstance;
        }

        if (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function') {
            supabaseInstance = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true,
                    storage: window.localStorage
                }
            });
            return supabaseInstance;
        }

        console.error(
            'Official Supabase JS Client library is not loaded on window. ' +
            'Include <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> in the HTML head.'
        );
        return null;
    }

    return {
        getClient,
        get client() {
            return getClient();
        }
    };
}));
