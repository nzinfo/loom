import type { FileSystem } from '../../src/loader/fs.js';
import { MemoryFileSystem } from './memory_fs.js';

/**
 * A small but complete loom schema used across loader/projector tests.
 * v2 syntax: single type: key, no base/ref split, no kind prefix on type
 * refs. Covers: scalar/struct/enum types (unified `type` kind), mixin include,
 * sidecar_eav table, entity referencing the table, extension_fields targeting
 * the entity.
 *
 * Directory layout uses the v2 owner prefixes (platform/ext/tenants). The
 * layout is flat — kind encoded in the file extension (`.type.yaml` etc).
 * This fixture only contains platform-owned nodes; ext/tenant examples
 * are added by dedicated fixtures in their own tests.
 */
export function buildBaseSchemaFs(): FileSystem {
  return new MemoryFileSystem({
    // ── scalars (form: scalar) — the system base vocabulary ──
    'platform/base/core/bigint.type.yaml': `version: loom-schema/v2
name: bigint
form: scalar
description: 64-bit integer
properties: []
`,
    'platform/base/core/decimal.type.yaml': `version: loom-schema/v2
name: decimal
form: scalar
description: fixed-point
properties:
  - { name: precision, type: integer, required: true }
  - { name: scale, type: integer, required: true }
`,
    'platform/base/core/string.type.yaml': `version: loom-schema/v2
name: string
form: scalar
description: var-length string
properties:
  - { name: max_length, type: integer, required: true }
  - { name: pattern, type: string }
`,
    'platform/base/core/datetime.type.yaml': `version: loom-schema/v2
name: datetime
form: scalar
description: timestamp
properties: []
`,
    'platform/base/core/boolean.type.yaml': `version: loom-schema/v2
name: boolean
form: scalar
description: boolean
properties: []
`,

    // ── struct / enum types (form: struct / enum) ──
    'platform/base/core/audit.type.yaml': `version: loom-schema/v2
name: Audit
form: struct
fields:
  - name: created_at
    type: datetime
    required: true
  - name: updated_at
    type: datetime
    required: true
`,
    'platform/base/core/email.type.yaml': `version: loom-schema/v2
name: Email
form: struct
fields:
  - name: value
    type:
      ref: string
      args: { max_length: 254 }
`,
    'platform/base/core/money.type.yaml': `version: loom-schema/v2
name: Money
form: struct
fields:
  - name: amount
    type:
      ref: decimal
      args: { precision: 18, scale: 4 }
    required: true
  - name: currency_code
    type:
      ref: string
      args: { max_length: 3 }
    required: true
`,
    'platform/base/core/range.type.yaml': `version: loom-schema/v2
name: Range
form: struct
fields:
  - name: low
    type:
      ref: decimal
      args: { precision: 18, scale: 4 }
  - name: high
    type:
      ref: decimal
      args: { precision: 18, scale: 4 }
`,
    'platform/base/core/status.type.yaml': `version: loom-schema/v2
name: Status
form: enum
variants:
  - value: active
    display_name: Active
  - value: inactive
  - value: suspended
`,

    'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
fields:
  - name: id
    type: bigint
    required: true
  - name: audit
    type: base.core.Audit
    column: ''
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
  - name: idx_users_email
    fields: [email]
    unique: true
`,
    'platform/base/core/user.entity.yaml': `version: loom-schema/v2
name: User
primary_table: table:base.core.Users
business_keys: [email]
audit: true
view: users
`,
    'platform/base/core/user_fields.ext.yaml': `version: loom-schema/v2
entity: entity:base.core.User
fields:
  - name: nickname
    type:
      ref: string
      args: { max_length: 50 }
    default_scope: tenant
`,

    // ── ext:acme-corp — independent module with its own physical schema ──
    'ext/acme-corp/retail/pos/orders.table.yaml': `version: loom-schema/v2
name: Orders
table:
  name: orders
  extension: { strategy: none }
fields:
  - name: id
    type: bigint
    required: true
  - name: user_id
    type: bigint
    required: true
  - name: total
    type: base.core.Money
foreign_keys:
  - name: fk_orders_user
    fields: [user_id]
    ref_table: users_base
    ref_fields: [id]
primary_key: [id]
`,

    // ── tenant:acme — per-tenant extension field on platform's User entity ──
    'tenants/acme/base/core/user_fields.ext.yaml': `version: loom-schema/v2
entity: entity:base.core.User
fields:
  - name: customer_no
    type:
      ref: string
      args: { max_length: 32 }
    default_scope: tenant
`,
  });
}
