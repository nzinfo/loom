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
  tenant_id BIGINT,
  field_name VARCHAR(100) NOT NULL,
  data_type VARCHAR(20) NOT NULL,
  int_value BIGINT,
  decimal_value NUMERIC(18,4),
  string_value TEXT,
  datetime_value TIMESTAMPTZ,
  boolean_value BOOLEAN,
  json_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  (SELECT string_value FROM users_ext e WHERE e.base_id = u.id AND e.field_name = 'nickname' LIMIT 1) AS nickname
FROM base_core.users_base u;