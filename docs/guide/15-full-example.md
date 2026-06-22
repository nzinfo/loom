# 完整工作示例

下面是仓库 `packages/core/tests/fixtures/base_schema.ts` 中的完整 schema，
对应黄金固件 `base_schema.pg.sql` 的输出。

## 标量类型文件（form: scalar）

每个标量一个文件。标量是系统基础词汇，只在 `base.core` 下定义。

```yaml
# platform/base/core/bigint.type.yaml
version: loom-schema/v2
name: bigint
form: scalar
description: 64-bit integer
properties: []
```

```yaml
# platform/base/core/decimal.type.yaml
version: loom-schema/v2
name: decimal
form: scalar
description: fixed-point
properties:
  - { name: precision, type: integer, required: true }
  - { name: scale, type: integer, required: true }
```

```yaml
# platform/base/core/string.type.yaml
version: loom-schema/v2
name: string
form: scalar
description: var-length string
properties:
  - { name: max_length, type: integer, required: true }
  - { name: pattern, type: string }
```

`datetime`、`boolean` 与 `bigint` 同形（`properties: []`）。

## struct / enum 类型（form: struct / enum）

```yaml
# platform/base/core/audit.type.yaml
version: loom-schema/v2
name: Audit
form: struct
fields:
  - { name: created_at, type: datetime, required: true }
  - { name: updated_at, type: datetime, required: true }
```

```yaml
# platform/base/core/money.type.yaml
version: loom-schema/v2
name: Money
form: struct
fields:
  - name: amount
    type: { ref: decimal, args: { precision: 18, scale: 4 } }
    required: true
  - name: currency_code
    type: { ref: string, args: { max_length: 3 } }
    required: true
```

`Email`、`Range`（form: struct）与 `Status`（form: enum，variants）同理，
详见 [03 type](./03-base-types.md)。

## platform/base/core/users.table.yaml

```yaml
version: loom-schema/v2
name: Users
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
fields:
  - { name: id, type: bigint, required: true }
  - name: audit
    type: base.core.Audit
    column: ''                 # flatten → created_at / updated_at
  - name: email
    type: base.core.Email
    required: true
    unique: true
  - name: balance
    type: base.core.Money
  - name: price_range
    type: base.core.Range
  - name: status
    type: base.core.Status
primary_key: [id]
indexes:
  - { name: idx_users_email, fields: [email], unique: true }
```

## platform/base/core/user.entity.yaml

```yaml
version: loom-schema/v2
name: User
primary_table: table:base.core.Users
business_keys: [email]
audit: true
view: users                     # 可选：声明逻辑视图名
```

## platform/base/core/user_profile.ext.yaml

```yaml
version: loom-schema/v2
entity: entity:base.core.User
group: profile                  # 扩展组名（省略则默认 = 文件 stem）
fields:
  - name: nickname
    type: { ref: string, args: { max_length: 50 } }
    default_scope: tenant
  - name: bio
    type: { ref: string, args: { max_length: 500 } }
```

```yaml
# platform/base/core/user_finance.ext.yaml
version: loom-schema/v2
entity: entity:base.core.User
group: finance
fields:
  - name: credit_limit
    type: base.core.Money
    default_scope: tenant
```

## 投影输出（PG）

```sql
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
  group_name VARCHAR(50) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE VIEW users AS
SELECT
  u.id,
  u.created_at,
  u.updated_at,
  u.email,
  u.balance_amount,
  u.balance_currency_code,
  u.price_range_low,
  u.price_range_high,
  u.status,
  p.values->>'nickname' AS nickname,
  p.values->>'bio' AS bio,
  f.values->>'credit_limit_amount' AS credit_limit_amount,
  f.values->>'credit_limit_currency_code' AS credit_limit_currency_code,
  p.values->>'customer_no' AS customer_no
FROM base_core.users_base u
LEFT JOIN users_ext p ON p.base_id = u.id AND p.group_name = 'profile'
LEFT JOIN users_ext f ON f.base_id = u.id AND f.group_name = 'finance';
```

`customer_no` 来自 `tenants/acme` owner，与 platform 的 `nickname`/`bio` 同属 `profile`
组，所以共享同一个 `p` JOIN；`credit_limit`（Money 多字段 struct）属 `finance` 组，
展开成两个 JSON key（`credit_limit_amount`、`credit_limit_currency_code`），共享 `f` JOIN。
