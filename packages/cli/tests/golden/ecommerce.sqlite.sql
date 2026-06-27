CREATE TABLE shop_core.categories_base (
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  PRIMARY KEY (id),
  FOREIGN KEY (parent_id) REFERENCES shop.core.Categories (id) ON DELETE SET NULL
);
CREATE INDEX idx_categories_parent ON shop_core.categories_base (parent_id);

CREATE TABLE shop_core.products_ext (
  base_id_0 INTEGER NOT NULL,
  source TEXT NOT NULL,
  values TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shop_core.customers_base (
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- loom:enum 0=低|1=中|2=高|3=紧急,
  priority INTEGER,
  CHECK (priority IN (0, 1, 2, 3)),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX idx_customers_email ON shop_core.customers_base (email);

CREATE TABLE shop_core.customers_ext (
  base_id_0 TEXT NOT NULL,
  source TEXT NOT NULL,
  values TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shop_core.order_items_base (
  order_id TEXT NOT NULL,
  line_num INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_amount NUMERIC NOT NULL,
  unit_price_currency_code TEXT NOT NULL,
  PRIMARY KEY (order_id, line_num),
  FOREIGN KEY (order_id) REFERENCES shop.core.Orders (id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES shop.core.Products (id) ON DELETE RESTRICT
);
CREATE INDEX idx_orderitems_product ON shop_core.order_items_base (product_id);

CREATE TABLE shop_core.order_items_ext (
  base_id_0 TEXT NOT NULL,
  base_id_1 INTEGER NOT NULL,
  source TEXT NOT NULL,
  values TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shop_core.orders_base (
  id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  -- loom:enum pending=待付款|paid=已付款|shipped=已发货|delivered=已送达|cancelled=已取消,
  status TEXT NOT NULL,
  CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  total_amount_amount NUMERIC,
  total_amount_currency_code TEXT,
  placed_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (customer_id) REFERENCES shop.core.Customers (id) ON DELETE RESTRICT
);
CREATE INDEX idx_orders_customer ON shop_core.orders_base (customer_id);
CREATE INDEX idx_orders_status ON shop_core.orders_base (status);
CREATE INDEX idx_orders_placed_at ON shop_core.orders_base (placed_at);

CREATE TABLE shop_core.orders_ext (
  base_id_0 TEXT NOT NULL,
  source TEXT NOT NULL,
  values TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shop_core.products_base (
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  base_price_amount NUMERIC,
  base_price_currency_code TEXT,
  category_id INTEGER,
  PRIMARY KEY (id),
  FOREIGN KEY (category_id) REFERENCES shop.core.Categories (id) ON DELETE RESTRICT
);
CREATE INDEX idx_products_name ON shop_core.products_base (name);
CREATE INDEX idx_products_category ON shop_core.products_base (category_id);

CREATE TABLE shop_core.products_ext (
  base_id_0 INTEGER NOT NULL,
  source TEXT NOT NULL,
  values TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shop_core.customer_loyalty (
  id TEXT NOT NULL,
  points INTEGER,
  tier TEXT,
  enrolled_at INTEGER,
  PRIMARY KEY (id),
  FOREIGN KEY (id) REFERENCES shop_core.customers_base (id)
);

CREATE TABLE shop_core.order_item_giftwrap (
  order_id TEXT NOT NULL,
  line_num INTEGER NOT NULL,
  wrap_type TEXT,
  gift_message TEXT,
  wrap_cost_amount NUMERIC,
  wrap_cost_currency_code TEXT,
  PRIMARY KEY (order_id, line_num),
  FOREIGN KEY (order_id, line_num) REFERENCES shop_core.order_items_base (order_id, line_num)
);

CREATE TABLE shop_core.product_warehouse (
  id INTEGER NOT NULL,
  warehouse_code TEXT,
  shelf_location TEXT,
  restock_threshold INTEGER,
  PRIMARY KEY (id),
  FOREIGN KEY (id) REFERENCES shop_core.products_base (id)
);

CREATE VIEW categories AS
SELECT
  id,
  name,
  parent_id,
  json_extract(m.values, '$.display_order') AS display_order,
  json_extract(m.values, '$.icon_url') AS icon_url
FROM shop_core.categories_base u
LEFT JOIN products_ext m ON m.base_id_0 = u.id AND m.source = '6a2e377c87ce755f';

CREATE VIEW customers AS
SELECT
  id,
  email,
  display_name,
  priority,
  json_extract(p.values, '$.phone') AS phone,
  json_extract(p.values, '$.shipping_address_street') AS shipping_address_street,
  json_extract(p.values, '$.shipping_address_city') AS shipping_address_city,
  json_extract(p.values, '$.shipping_address_postal_code') AS shipping_address_postal_code,
  json_extract(p.values, '$.shipping_address_country_code') AS shipping_address_country_code
FROM shop_core.customers_base u
LEFT JOIN customers_ext p ON p.base_id_0 = u.id AND p.source = 'ba23745110d8c96a';

CREATE VIEW orders AS
SELECT
  id,
  customer_id,
  status,
  total_amount_amount,
  total_amount_currency_code,
  placed_at,
  json_extract(f.values, '$.tracking_number') AS tracking_number,
  json_extract(f.values, '$.shipped_at') AS shipped_at,
  json_extract(f.values, '$.carrier') AS carrier
FROM shop_core.orders_base u
LEFT JOIN orders_ext f ON f.base_id_0 = u.id AND f.source = 'f644d663222b7ded';

CREATE VIEW order_items AS
SELECT
  order_id,
  line_num,
  product_id,
  quantity,
  unit_price_amount,
  unit_price_currency_code,
  json_extract(a.values, '$.audit_note') AS audit_note,
  json_extract(a.values, '$.audit_user') AS audit_user
FROM shop_core.order_items_base u
LEFT JOIN order_items_ext a ON a.base_id_0 = u.order_id AND a.base_id_1 = u.line_num AND a.source = '52f44a82eeb613cb';

CREATE VIEW products AS
SELECT
  id,
  name,
  base_price_amount,
  base_price_currency_code,
  category_id,
  json_extract(a.values, '$.acme_sku') AS acme_sku,
  json_extract(a.values, '$.acme_cost_center') AS acme_cost_center,
  json_extract(p.values, '$.discount_rate') AS discount_rate,
  json_extract(p.values, '$.tier_price_amount') AS tier_price_amount,
  json_extract(p.values, '$.tier_price_currency_code') AS tier_price_currency_code,
  json_extract(i.values, '$.sku') AS sku,
  json_extract(i.values, '$.stock_qty') AS stock_qty,
  json_extract(i.values, '$.warehouse') AS warehouse
FROM shop_core.products_base u
LEFT JOIN products_ext a ON a.base_id_0 = u.id AND a.source = '383214a9d8a6d1c2'
LEFT JOIN products_ext p ON p.base_id_0 = u.id AND p.source = '381bfdc39ed9771e'
LEFT JOIN products_ext i ON i.base_id_0 = u.id AND i.source = '960b3b0351056080';