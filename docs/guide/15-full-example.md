# 完整工作示例

下面是仓库 `packages/core/tests/fixtures/base_schema.ts` 中的完整 schema，
对应黄金固件 `base_schema.pg.sql` 的输出。

## base_types.yaml

```yaml
version: loom-schema/v2
kind: base_types
scalars:
  - { name: bigint,   description: 64-bit integer, properties: [] }
  - name: decimal
    description: fixed-point
    properties:
      - { name: precision, type: integer, required: true }
      - { name: scale, type: integer, required: true }
  - name: string
    description: var-length string
    properties:
      - { name: max_length, type: integer, required: true }
      - { name: pattern, type: string }
  - { name: datetime, description: timestamp, properties: [] }
  - { name: boolean,  description: boolean,   properties: [] }
```

## platform/base/core/MANIFEST.yaml

```yaml
version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
description: core module
```

## platform/base/core/mixin/audit.yaml

```yaml
version: loom-schema/v2
kind: mixin
name: Audit
fields:
  - { name: created_at, type: datetime, required: true }
  - { name: updated_at, type: datetime, required: true }
```

## platform/base/core/value_type/email.yaml + money.yaml

```yaml
# email.yaml
version: loom-schema/v2
kind: value_type
name: Email
fields:
  - name: value
    type: { ref: string, args: { max_length: 254 } }
```

```yaml
# money.yaml
version: loom-schema/v2
kind: value_type
name: Money
fields:
  - name: amount
    type: { ref: decimal, args: { precision: 18, scale: 4 } }
    required: true
  - name: currency_code
    type: { ref: string, args: { max_length: 3 } }
    required: true
```

## platform/base/core/table/users.yaml

```yaml
version: loom-schema/v2
kind: table
name: Users
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
fields:
  - { name: id, type: bigint, required: true }
  - include: mixin:base.core.Audit
  - name: email
    type: base.core.Email
    required: true
    unique: true
  - name: balance
    type: base.core.Money
primary_key: [id]
indexes:
  - { name: idx_users_email, fields: [email], unique: true }
```

## platform/base/core/entity/user.yaml

```yaml
version: loom-schema/v2
kind: entity
name: User
primary_table: table:base.core.Users
business_keys: [email]
audit: true
```

## platform/base/core/extension/user_fields.yaml

```yaml
version: loom-schema/v2
kind: extension_fields
entity: entity:base.core.User
fields:
  - name: nickname
    type: { ref: string, args: { max_length: 50 } }
    default_scope: tenant
```

## 投影输出（PG）

```sql
CREATE TABLE base_core.users_base (
  id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  balance_amount NUMERIC(18,4),
  balance_currency_code VARCHAR(3),
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
  (SELECT string_value FROM users_ext e
   WHERE e.base_id = u.id AND e.field_name = 'nickname' LIMIT 1) AS nickname
FROM base_core.users_base u;
```
