CREATE TYPE base_core_status AS ENUM ('active', 'inactive', 'suspended');

COMMENT ON TYPE base_core_status IS 'loom:enum active=Active|inactive|suspended';

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
  priority SMALLINT,
  CONSTRAINT priority_check CHECK (priority IN (0, 1, 2)),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX idx_users_email ON base_core.users_base (email);

CREATE TABLE base_core.users_ext (
  base_id_0 BIGINT NOT NULL,
  source CHAR(16) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_ext_source ON base_core.users_ext (base_id_0, source);

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
  priority,
  p.values->>'nickname' AS nickname,
  p.values->>'bio' AS bio,
  f.values->>'credit_limit_amount' AS credit_limit_amount,
  f.values->>'credit_limit_currency_code' AS credit_limit_currency_code,
  p.values->>'customer_no' AS customer_no
FROM base_core.users_base u
LEFT JOIN users_ext p ON p.base_id_0 = u.id AND p.source = '2ef0f158ba6171c9'
LEFT JOIN users_ext f ON f.base_id_0 = u.id AND f.source = '1c3575051037d9de';