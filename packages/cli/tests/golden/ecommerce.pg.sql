CREATE TYPE shop_core_orderstatus AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled');

COMMENT ON TYPE shop_core_orderstatus IS 'loom:enum pending=待付款|paid=已付款|shipped=已发货|delivered=已送达|cancelled=已取消';

CREATE TABLE shop_core.categories_base (
  id BIGINT NOT NULL,
  name VARCHAR(128) NOT NULL,
  parent_id BIGINT,
  PRIMARY KEY (id),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES shop.core.Categories (id) ON DELETE SET NULL
);
CREATE INDEX idx_categories_parent ON shop_core.categories_base (parent_id);

CREATE TABLE shop_core.products_ext (
  base_id_0 BIGINT NOT NULL,
  source CHAR(16) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_products_ext_source ON shop_core.products_ext (base_id_0, source);

CREATE TABLE shop_core.customers_base (
  id VARCHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  priority SMALLINT,
  CONSTRAINT priority_check CHECK (priority IN (0, 1, 2, 3)),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX idx_customers_email ON shop_core.customers_base (email);

CREATE TABLE shop_core.customers_ext (
  base_id_0 VARCHAR(36) NOT NULL,
  source CHAR(16) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_customers_ext_source ON shop_core.customers_ext (base_id_0, source);

CREATE TABLE shop_core.order_items_base (
  order_id VARCHAR(36) NOT NULL,
  line_num INTEGER NOT NULL,
  product_id BIGINT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_amount NUMERIC(18,4) NOT NULL,
  unit_price_currency_code VARCHAR(3) NOT NULL,
  PRIMARY KEY (order_id, line_num),
  CONSTRAINT fk_orderitems_order FOREIGN KEY (order_id) REFERENCES shop.core.Orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_orderitems_product FOREIGN KEY (product_id) REFERENCES shop.core.Products (id) ON DELETE RESTRICT
);
CREATE INDEX idx_orderitems_product ON shop_core.order_items_base (product_id);

CREATE TABLE shop_core.order_items_ext (
  base_id_0 VARCHAR(36) NOT NULL,
  base_id_1 INTEGER NOT NULL,
  source CHAR(16) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_order_items_ext_source ON shop_core.order_items_ext (base_id_0, base_id_1, source);

CREATE TABLE shop_core.orders_base (
  id VARCHAR(36) NOT NULL,
  customer_id VARCHAR(36) NOT NULL,
  status shop_core_orderstatus NOT NULL,
  total_amount_amount NUMERIC(18,4),
  total_amount_currency_code VARCHAR(3),
  placed_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES shop.core.Customers (id) ON DELETE RESTRICT
);
CREATE INDEX idx_orders_customer ON shop_core.orders_base (customer_id);
CREATE INDEX idx_orders_status ON shop_core.orders_base (status);
CREATE INDEX idx_orders_placed_at ON shop_core.orders_base (placed_at);

CREATE TABLE shop_core.orders_ext (
  base_id_0 VARCHAR(36) NOT NULL,
  source CHAR(16) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_orders_ext_source ON shop_core.orders_ext (base_id_0, source);

CREATE TABLE shop_core.products_base (
  id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  base_price_amount NUMERIC(18,4),
  base_price_currency_code VARCHAR(3),
  category_id BIGINT,
  PRIMARY KEY (id),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES shop.core.Categories (id) ON DELETE RESTRICT
);
CREATE INDEX idx_products_name ON shop_core.products_base (name);
CREATE INDEX idx_products_category ON shop_core.products_base (category_id);

CREATE TABLE shop_core.products_ext (
  base_id_0 BIGINT NOT NULL,
  source CHAR(16) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_products_ext_source ON shop_core.products_ext (base_id_0, source);

CREATE TABLE shop_core.customer_loyalty (
  id VARCHAR(36) NOT NULL,
  points BIGINT,
  tier VARCHAR(16),
  enrolled_at BIGINT,
  PRIMARY KEY (id),
  CONSTRAINT fk_customer_loyalty_base FOREIGN KEY (id) REFERENCES shop_core.customers_base (id)
);

CREATE TABLE shop_core.order_item_giftwrap (
  order_id VARCHAR(36) NOT NULL,
  line_num INTEGER NOT NULL,
  wrap_type VARCHAR(32),
  gift_message VARCHAR(512),
  wrap_cost_amount NUMERIC(18,4),
  wrap_cost_currency_code VARCHAR(3),
  PRIMARY KEY (order_id, line_num),
  CONSTRAINT fk_order_item_giftwrap_base FOREIGN KEY (order_id, line_num) REFERENCES shop_core.order_items_base (order_id, line_num)
);

CREATE TABLE shop_core.product_warehouse (
  id BIGINT NOT NULL,
  warehouse_code VARCHAR(16),
  shelf_location VARCHAR(32),
  restock_threshold INTEGER,
  PRIMARY KEY (id),
  CONSTRAINT fk_product_warehouse_base FOREIGN KEY (id) REFERENCES shop_core.products_base (id)
);

CREATE VIEW categories AS
SELECT
  id,
  name,
  parent_id,
  m.values->>'display_order' AS display_order,
  m.values->>'icon_url' AS icon_url
FROM shop_core.categories_base u
LEFT JOIN products_ext m ON m.base_id_0 = u.id AND m.source = '6a2e377c87ce755f';

CREATE VIEW customers AS
SELECT
  id,
  email,
  display_name,
  priority,
  p.values->>'phone' AS phone,
  p.values->>'shipping_address_street' AS shipping_address_street,
  p.values->>'shipping_address_city' AS shipping_address_city,
  p.values->>'shipping_address_postal_code' AS shipping_address_postal_code,
  p.values->>'shipping_address_country_code' AS shipping_address_country_code
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
  f.values->>'tracking_number' AS tracking_number,
  f.values->>'shipped_at' AS shipped_at,
  f.values->>'carrier' AS carrier
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
  a.values->>'audit_note' AS audit_note,
  a.values->>'audit_user' AS audit_user
FROM shop_core.order_items_base u
LEFT JOIN order_items_ext a ON a.base_id_0 = u.order_id AND a.base_id_1 = u.line_num AND a.source = '52f44a82eeb613cb';

CREATE VIEW products AS
SELECT
  id,
  name,
  base_price_amount,
  base_price_currency_code,
  category_id,
  a.values->>'acme_sku' AS acme_sku,
  a.values->>'acme_cost_center' AS acme_cost_center,
  p.values->>'discount_rate' AS discount_rate,
  p.values->>'tier_price_amount' AS tier_price_amount,
  p.values->>'tier_price_currency_code' AS tier_price_currency_code,
  i.values->>'sku' AS sku,
  i.values->>'stock_qty' AS stock_qty,
  i.values->>'warehouse' AS warehouse
FROM shop_core.products_base u
LEFT JOIN products_ext a ON a.base_id_0 = u.id AND a.source = '383214a9d8a6d1c2'
LEFT JOIN products_ext p ON p.base_id_0 = u.id AND p.source = '381bfdc39ed9771e'
LEFT JOIN products_ext i ON i.base_id_0 = u.id AND i.source = '960b3b0351056080';