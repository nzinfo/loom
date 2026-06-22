CREATE TYPE base_core_status AS ENUM ('active', 'inactive', 'suspended');

CREATE TABLE base_core.users_base (
  id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  balance_amount NUMERIC(18,4),
  balance_currency_code VARCHAR(3),
  price_range_low NUMERIC(18,4),
  price_range_high NUMERIC(18,4),
  status base_core_status,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX idx_users_email ON base_core.users_base (email);

CREATE TABLE base_core.users_ext (
  base_id BIGINT NOT NULL,
  scope BIGINT NOT NULL,
  group_name VARCHAR(50) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE retail_pos.orders (
  id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  total_amount NUMERIC(18,4),
  total_currency_code VARCHAR(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users_base (id)
);

CREATE VIEW users AS
SELECT
  id,
  created_at,
  updated_at,
  email,
  balance_amount,
  balance_currency_code,
  price_range_low,
  price_range_high,
  status,
  p.values->>'nickname' AS nickname,
  p.values->>'bio' AS bio,
  f.values->>'credit_limit_amount' AS credit_limit_amount,
  f.values->>'credit_limit_currency_code' AS credit_limit_currency_code,
  p.values->>'customer_no' AS customer_no
FROM base_core.users_base u
LEFT JOIN users_ext p ON p.base_id = u.id AND p.group_name = 'profile'
LEFT JOIN users_ext f ON f.base_id = u.id AND f.group_name = 'finance';