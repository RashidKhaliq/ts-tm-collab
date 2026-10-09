CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS stores (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 domain text NOT NULL UNIQUE, supplier_code text NOT NULL UNIQUE,
 owner_name text NOT NULL DEFAULT '', owner_email text NOT NULL DEFAULT '', owner_phone text NOT NULL DEFAULT '',
 owner_address jsonb NOT NULL DEFAULT '{}'::jsonb,
 encrypted_token text NOT NULL, encrypted_webhook_secret text NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_store_id uuid NOT NULL REFERENCES stores(id),
 owner_sku text NOT NULL, supplier_code text NOT NULL,
 status text NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','RESERVED','SOLD','REVIEW')),
 source_order_key text, reservation_at timestamptz, reserved_by uuid REFERENCES stores(id),
 sold_by uuid REFERENCES stores(id), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_store_id,owner_sku,supplier_code)
);
CREATE TABLE IF NOT EXISTS listings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
 store_id uuid NOT NULL REFERENCES stores(id), product_gid text NOT NULL, variant_gid text NOT NULL,
 inventory_gid text, sku text NOT NULL, original_status text NOT NULL DEFAULT 'ACTIVE',
 sync_state text NOT NULL DEFAULT 'PENDING', last_error text,
 UNIQUE(store_id,product_gid,variant_gid), UNIQUE(item_id,store_id)
);
CREATE INDEX IF NOT EXISTS idx_listings_item ON listings(item_id);
CREATE TABLE IF NOT EXISTS incoming_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), webhook_id text NOT NULL,
 store_id uuid NOT NULL REFERENCES stores(id), topic text NOT NULL,
 payload jsonb NOT NULL, state text NOT NULL DEFAULT 'PENDING'
 CHECK(state IN ('PENDING','PROCESSING','DONE','FAILED')),
 attempts integer NOT NULL DEFAULT 0, retry_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,webhook_id)
);
CREATE INDEX IF NOT EXISTS idx_events_work ON incoming_events(state,retry_at);
CREATE TABLE IF NOT EXISTS sales (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES items(id),
 selling_store_id uuid NOT NULL REFERENCES stores(id), source_order_id text NOT NULL,
 source_order_name text NOT NULL, source_line_id text NOT NULL,
 owner_order_gid text, workflow_state text NOT NULL DEFAULT 'RESERVED',
 workflow_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(selling_store_id,source_order_id,source_line_id), UNIQUE(item_id,source_order_id,selling_store_id)
);
CREATE TABLE IF NOT EXISTS audit (
 id bigserial PRIMARY KEY, level text NOT NULL, kind text NOT NULL,
 item_id uuid, store_id uuid, message text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(created_at DESC);
