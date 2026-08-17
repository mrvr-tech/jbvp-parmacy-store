-- ============================================================================
-- Vidya Niketan College of Pharmacy - Pharmacy Store Management System
-- Production Database Schema, Helper Routines, RPCs, Views, and Strict RLS Policies
-- ============================================================================

-- 1. BASE TABLES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.labs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    owner_profile_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'lab' CHECK (role IN ('store', 'lab')),
    lab_id UUID REFERENCES public.labs(id) ON DELETE SET NULL,
    display_name TEXT NOT NULL DEFAULT 'User',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_category_enum') THEN
        CREATE TYPE public.inventory_category_enum AS ENUM ('Chemicals', 'Glassware', 'Instruments', 'Other');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.inventory_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category public.inventory_category_enum NOT NULL DEFAULT 'Chemicals',
    item_name TEXT NOT NULL,
    packages TEXT,
    total_quantity INTEGER NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
    current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
    min_stock_level INTEGER NOT NULL DEFAULT 5 CHECK (min_stock_level >= 0),
    price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    tax NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
    expiry_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.inventory_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sr_no INTEGER NOT NULL,
    item_id UUID REFERENCES public.inventory_items(id) ON DELETE SET NULL,
    category public.inventory_category_enum NOT NULL DEFAULT 'Chemicals',
    item_name TEXT NOT NULL,
    packages TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    tax NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
    bill_no TEXT NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    expiry_date DATE NOT NULL,
    vendor_name TEXT NOT NULL,
    vendor_address TEXT NOT NULL,
    vendor_pan TEXT NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.lab_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id UUID NOT NULL REFERENCES public.labs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    review_notes TEXT
);

CREATE TABLE IF NOT EXISTS public.lab_request_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_request_id UUID NOT NULL REFERENCES public.lab_requests(id) ON DELETE CASCADE,
    inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
    count INTEGER NOT NULL CHECK (count > 0),
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. HELPER FUNCTIONS
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_store_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT (
        LOWER(COALESCE(auth.jwt() ->> 'email', '')) = 'rathodstudents@gmail.com'
        OR LOWER(COALESCE(auth.jwt() -> 'user_metadata' ->> 'role', '')) = 'store'
        OR EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() AND role = 'store'
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.get_user_lab_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT lab_id FROM public.profiles 
    WHERE id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION public.is_store_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_lab_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_store_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_lab_id() TO authenticated;

-- 3. ROW LEVEL SECURITY POLICIES
-- ----------------------------------------------------------------------------
ALTER TABLE public.labs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lab_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lab_request_items ENABLE ROW LEVEL SECURITY;

-- Labs
DROP POLICY IF EXISTS "labs_select_policy" ON public.labs;
CREATE POLICY "labs_select_policy" ON public.labs FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "labs_admin_all_policy" ON public.labs;
CREATE POLICY "labs_admin_all_policy" ON public.labs FOR ALL TO authenticated
USING (public.is_store_admin()) WITH CHECK (public.is_store_admin());

-- Profiles
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy" ON public.profiles FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "profiles_self_update_policy" ON public.profiles;
CREATE POLICY "profiles_self_update_policy" ON public.profiles FOR UPDATE TO authenticated
USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "profiles_admin_all_policy" ON public.profiles;
CREATE POLICY "profiles_admin_all_policy" ON public.profiles FOR ALL TO authenticated
USING (public.is_store_admin()) WITH CHECK (public.is_store_admin());

-- Inventory Items
DROP POLICY IF EXISTS "inventory_items_select_policy" ON public.inventory_items;
CREATE POLICY "inventory_items_select_policy" ON public.inventory_items FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "inventory_items_admin_policy" ON public.inventory_items;
CREATE POLICY "inventory_items_admin_policy" ON public.inventory_items FOR ALL TO authenticated
USING (public.is_store_admin()) WITH CHECK (public.is_store_admin());

-- Inventory Entries
DROP POLICY IF EXISTS "inventory_entries_select_policy" ON public.inventory_entries;
CREATE POLICY "inventory_entries_select_policy" ON public.inventory_entries FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "inventory_entries_admin_policy" ON public.inventory_entries;
CREATE POLICY "inventory_entries_admin_policy" ON public.inventory_entries FOR ALL TO authenticated
USING (public.is_store_admin()) WITH CHECK (public.is_store_admin());

-- Lab Requests (Strict Lab Isolation & Admin Access)
DROP POLICY IF EXISTS "lab_requests_store_admin_all" ON public.lab_requests;
CREATE POLICY "lab_requests_store_admin_all" ON public.lab_requests FOR ALL TO authenticated
USING (public.is_store_admin()) WITH CHECK (public.is_store_admin());

DROP POLICY IF EXISTS "lab_requests_select_policy" ON public.lab_requests;
DROP POLICY IF EXISTS "lab_requests_lab_select_own_lab" ON public.lab_requests;
CREATE POLICY "lab_requests_select_policy" ON public.lab_requests FOR SELECT TO authenticated
USING (
    public.is_store_admin()
    OR lab_id = (SELECT p.lab_id FROM public.profiles p WHERE p.id = auth.uid())
    OR requested_by = auth.uid()
);

DROP POLICY IF EXISTS "lab_requests_lab_insert_own_lab" ON public.lab_requests;
CREATE POLICY "lab_requests_lab_insert_own_lab" ON public.lab_requests FOR INSERT TO authenticated
WITH CHECK (
    (lab_id = (SELECT p.lab_id FROM public.profiles p WHERE p.id = auth.uid()) OR public.is_store_admin())
    AND (requested_by IS NULL OR requested_by = auth.uid())
    AND (status IS NULL OR status = 'Pending')
);

-- Lab Request Line Items
DROP POLICY IF EXISTS "lab_request_items_store_admin_all" ON public.lab_request_items;
CREATE POLICY "lab_request_items_store_admin_all" ON public.lab_request_items FOR ALL TO authenticated
USING (public.is_store_admin()) WITH CHECK (public.is_store_admin());

DROP POLICY IF EXISTS "lab_request_items_select_policy" ON public.lab_request_items;
DROP POLICY IF EXISTS "lab_request_items_lab_select_own_lab" ON public.lab_request_items;
CREATE POLICY "lab_request_items_select_policy" ON public.lab_request_items FOR SELECT TO authenticated
USING (
    public.is_store_admin()
    OR EXISTS (
        SELECT 1 FROM public.lab_requests r
        WHERE r.id = lab_request_items.lab_request_id
          AND (r.lab_id = (SELECT p.lab_id FROM public.profiles p WHERE p.id = auth.uid()) OR r.requested_by = auth.uid())
    )
);

DROP POLICY IF EXISTS "lab_request_items_lab_insert_own_lab" ON public.lab_request_items;
CREATE POLICY "lab_request_items_lab_insert_own_lab" ON public.lab_request_items FOR INSERT TO authenticated
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.lab_requests r
        WHERE r.id = lab_request_items.lab_request_id
          AND (r.lab_id = (SELECT p.lab_id FROM public.profiles p WHERE p.id = auth.uid()) OR r.requested_by = auth.uid() OR public.is_store_admin())
          AND r.status = 'Pending'
    )
    AND count > 0
);

-- 4. STORED PROCEDURES (RPCs)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_inventory_entry(
    _bill_no TEXT,
    _category public.inventory_category_enum,
    _date DATE,
    _expiry_date DATE,
    _item_name TEXT,
    _packages TEXT DEFAULT NULL,
    _price NUMERIC DEFAULT 0,
    _quantity INTEGER DEFAULT 1,
    _sr_no INTEGER DEFAULT NULL,
    _tax NUMERIC DEFAULT 0,
    _vendor_address TEXT DEFAULT '',
    _vendor_name TEXT DEFAULT '',
    _vendor_pan TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_name TEXT;
    v_item_id UUID;
    v_entry_id UUID;
    v_sr_no INTEGER;
BEGIN
    IF NOT public.is_store_admin() THEN
        RAISE EXCEPTION 'Access denied: Only Store Admins can add inventory entries.';
    END IF;

    IF _quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be greater than zero.';
    END IF;

    v_clean_name := TRIM(_item_name);
    IF v_clean_name = '' THEN
        RAISE EXCEPTION 'Item name cannot be empty.';
    END IF;

    v_sr_no := COALESCE(_sr_no, (SELECT COALESCE(MAX(sr_no), 0) + 1 FROM public.inventory_entries));

    -- Upsert master item
    SELECT id INTO v_item_id
    FROM public.inventory_items
    WHERE LOWER(item_name) = LOWER(v_clean_name)
    LIMIT 1;

    IF v_item_id IS NOT NULL THEN
        UPDATE public.inventory_items
        SET 
            category = _category,
            packages = COALESCE(_packages, packages),
            current_stock = current_stock + _quantity,
            total_quantity = total_quantity + _quantity,
            price = _price,
            tax = _tax,
            expiry_date = _expiry_date,
            updated_at = NOW()
        WHERE id = v_item_id;
    ELSE
        INSERT INTO public.inventory_items (
            category, item_name, packages, current_stock, total_quantity, min_stock_level, price, tax, expiry_date, created_at, updated_at
        ) VALUES (
            _category, v_clean_name, _packages, _quantity, _quantity, 5, _price, _tax, _expiry_date, NOW(), NOW()
        )
        RETURNING id INTO v_item_id;
    END IF;

    -- Insert invoice record
    INSERT INTO public.inventory_entries (
        sr_no, item_id, category, item_name, packages, quantity, price, tax, bill_no, date, expiry_date, vendor_name, vendor_address, vendor_pan, created_by, created_at
    ) VALUES (
        v_sr_no, v_item_id, _category, v_clean_name, _packages, _quantity, _price, _tax, _bill_no, _date, _expiry_date, _vendor_name, _vendor_address, _vendor_pan, auth.uid(), NOW()
    )
    RETURNING id INTO v_entry_id;

    RETURN jsonb_build_object(
        'success', true,
        'item_id', v_item_id,
        'entry_id', v_entry_id,
        'sr_no', v_sr_no,
        'quantity_added', _quantity
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_lab_request(p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_req RECORD;
    v_item RECORD;
BEGIN
    IF NOT public.is_store_admin() THEN
        RAISE EXCEPTION 'Access denied: Only Store Admins can approve requisitions.';
    END IF;

    SELECT id, status INTO v_req
    FROM public.lab_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Requisition request not found.';
    END IF;

    IF v_req.status != 'Pending' THEN
        RAISE EXCEPTION 'Request is already marked as %; cannot approve again.', v_req.status;
    END IF;

    -- Check stock availability across line items
    FOR v_item IN 
        SELECT lri.id, lri.inventory_item_id, lri.count, ii.item_name, ii.current_stock
        FROM public.lab_request_items lri
        JOIN public.inventory_items ii ON ii.id = lri.inventory_item_id
        WHERE lri.lab_request_id = p_request_id
        FOR UPDATE OF ii
    LOOP
        IF v_item.current_stock < v_item.count THEN
            RAISE EXCEPTION 'Insufficient stock for "%". Available: %, Requested: %.', v_item.item_name, v_item.current_stock, v_item.count;
        END IF;

        UPDATE public.inventory_items
        SET current_stock = current_stock - v_item.count,
            updated_at = NOW()
        WHERE id = v_item.inventory_item_id;

        UPDATE public.lab_request_items
        SET status = 'Approved',
            updated_at = NOW()
        WHERE id = v_item.id;
    END LOOP;

    UPDATE public.lab_requests
    SET status = 'Approved',
        approved_at = NOW(),
        reviewed_at = NOW(),
        reviewed_by = auth.uid()
    WHERE id = p_request_id;

    RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'Approved');
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_lab_request(p_request_id UUID, p_notes TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status TEXT;
BEGIN
    IF NOT public.is_store_admin() THEN
        RAISE EXCEPTION 'Access denied: Only Store Admins can reject requisitions.';
    END IF;

    SELECT status INTO v_status
    FROM public.lab_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Requisition request not found.';
    END IF;

    IF v_status != 'Pending' THEN
        RAISE EXCEPTION 'Request is already marked as %; cannot reject again.', v_status;
    END IF;

    UPDATE public.lab_requests
    SET status = 'Rejected',
        reviewed_at = NOW(),
        reviewed_by = auth.uid(),
        review_notes = COALESCE(p_notes, review_notes)
    WHERE id = p_request_id;

    UPDATE public.lab_request_items
    SET status = 'Rejected',
        updated_at = NOW()
    WHERE lab_request_id = p_request_id;

    RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'Rejected');
END;
$$;

-- 5. REPORTING VIEWS
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_current_stock AS
SELECT 
    id, category, item_name, packages, current_stock, total_quantity, min_stock_level, price, tax, expiry_date, created_at, updated_at
FROM public.inventory_items;

CREATE OR REPLACE VIEW public.v_purchase_entry_history AS
SELECT 
    e.id, e.sr_no, e.bill_no, e.date, e.category, e.item_name, e.packages, e.quantity, e.price, e.tax,
    (e.price * e.quantity + e.tax) AS total_amount,
    e.expiry_date, e.vendor_name, e.vendor_address, e.vendor_pan, e.created_at
FROM public.inventory_entries e;

CREATE OR REPLACE VIEW public.v_expiry_report AS
SELECT 
    id, item_name, category, packages, current_stock, expiry_date,
    (expiry_date - CURRENT_DATE) AS days_until_expiry,
    CASE 
        WHEN expiry_date < CURRENT_DATE THEN 'Expired'
        WHEN expiry_date <= (CURRENT_DATE + INTERVAL '90 days') THEN 'Expiring Soon'
        ELSE 'Good'
    END AS expiry_status
FROM public.inventory_items
WHERE current_stock > 0;

CREATE OR REPLACE VIEW public.v_pending_requests AS
SELECT 
    r.id, r.created_at AS date, r.lab_id,
    COALESCE(l.name, 'Unknown Lab') AS lab_name,
    COALESCE(p.display_name, 'Lab In-Charge') AS requested_by,
    lri.inventory_item_id AS item_id,
    i.item_name, i.category, i.packages,
    i.current_stock AS available_stock,
    lri.count AS quantity,
    r.status
FROM public.lab_requests r
LEFT JOIN public.labs l ON l.id = r.lab_id
LEFT JOIN public.profiles p ON p.id = r.requested_by
LEFT JOIN public.lab_request_items lri ON lri.lab_request_id = r.id
LEFT JOIN public.inventory_items i ON i.id = lri.inventory_item_id
WHERE LOWER(r.status) = 'pending';

CREATE OR REPLACE VIEW public.v_approved_requests AS
SELECT 
    r.id, r.created_at AS request_date, r.approved_at AS approval_date, r.lab_id,
    COALESCE(l.name, 'Unknown Lab') AS lab_name,
    COALESCE(p.display_name, 'Lab In-Charge') AS requested_by,
    lri.inventory_item_id AS item_id,
    i.item_name, i.category,
    lri.count AS quantity,
    r.status
FROM public.lab_requests r
LEFT JOIN public.labs l ON l.id = r.lab_id
LEFT JOIN public.profiles p ON p.id = r.requested_by
LEFT JOIN public.lab_request_items lri ON lri.lab_request_id = r.id
LEFT JOIN public.inventory_items i ON i.id = lri.inventory_item_id
WHERE LOWER(r.status) = 'approved';

CREATE OR REPLACE VIEW public.v_rejected_requests AS
SELECT 
    r.id, r.created_at AS request_date, r.reviewed_at AS rejection_date, r.lab_id,
    COALESCE(l.name, 'Unknown Lab') AS lab_name,
    COALESCE(p.display_name, 'Lab In-Charge') AS requested_by,
    lri.inventory_item_id AS item_id,
    i.item_name, i.category,
    lri.count AS quantity,
    r.status
FROM public.lab_requests r
LEFT JOIN public.labs l ON l.id = r.lab_id
LEFT JOIN public.profiles p ON p.id = r.requested_by
LEFT JOIN public.lab_request_items lri ON lri.lab_request_id = r.id
LEFT JOIN public.inventory_items i ON i.id = lri.inventory_item_id
WHERE LOWER(r.status) = 'rejected';

CREATE OR REPLACE VIEW public.v_lab_usage AS
SELECT 
    r.id, r.approved_at AS issue_date, r.lab_id,
    COALESCE(l.name, 'Unknown Lab') AS lab_name,
    i.item_name, i.category,
    lri.count AS quantity_issued,
    i.price AS unit_price,
    (lri.count * COALESCE(i.price, 0)) AS total_cost
FROM public.lab_requests r
LEFT JOIN public.labs l ON l.id = r.lab_id
LEFT JOIN public.lab_request_items lri ON lri.lab_request_id = r.id
LEFT JOIN public.inventory_items i ON i.id = lri.inventory_item_id
WHERE LOWER(r.status) = 'approved';

CREATE OR REPLACE VIEW public.v_lab_request_report AS
SELECT 
    r.id, r.created_at AS date, r.lab_id,
    COALESCE(l.name, 'Unknown Lab') AS lab_name,
    COALESCE(p.display_name, 'Lab User') AS requested_by,
    i.item_name, i.category,
    lri.count AS quantity,
    r.status, r.approved_at
FROM public.lab_requests r
LEFT JOIN public.labs l ON l.id = r.lab_id
LEFT JOIN public.profiles p ON p.id = r.requested_by
LEFT JOIN public.lab_request_items lri ON lri.lab_request_id = r.id
LEFT JOIN public.inventory_items i ON i.id = lri.inventory_item_id;
