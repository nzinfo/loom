import type { FileSystem } from '../../src/loader/fs.js';
import { MemoryFileSystem } from './memory_fs.js';

/**
 * A small but complete loom schema used across loader/projector tests.
 * v2 syntax: single type: key, no base/ref split, no kind prefix on type
 * refs. Covers: base_types, module_manifest, single & multi value_types,
 * mixin include, sidecar_eav table, entity referencing the table,
 * extension_fields targeting the entity.
 *
 * Directory layout uses the v2 owner prefixes (platform/ext/tenants).
 * This fixture only contains platform-owned nodes; ext/tenant examples
 * are added by dedicated fixtures in their own tests.
 */
export function buildBaseSchemaFs(): FileSystem {
  return new MemoryFileSystem({
    'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - name: bigint
    description: 64-bit integer
    properties: []
  - name: decimal
    description: fixed-point
    properties:
      - name: precision
        type: integer
        required: true
      - name: scale
        type: integer
        required: true
  - name: string
    description: var-length string
    properties:
      - name: max_length
        type: integer
        required: true
      - name: pattern
        type: string
  - name: datetime
    description: timestamp
    properties: []
  - name: boolean
    description: boolean
    properties: []
`,
    'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
description: core module
`,
    'platform/base/core/mixin/audit.yaml': `version: loom-schema/v2
kind: mixin
name: Audit
fields:
  - name: created_at
    type: datetime
    required: true
  - name: updated_at
    type: datetime
    required: true
`,
    'platform/base/core/value_type/email.yaml': `version: loom-schema/v2
kind: value_type
name: Email
fields:
  - name: value
    type:
      ref: string
      args: { max_length: 254 }
`,
    'platform/base/core/value_type/money.yaml': `version: loom-schema/v2
kind: value_type
name: Money
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
    'platform/base/core/value_type/range.yaml': `version: loom-schema/v2
kind: value_type
name: Range
type_parameters:
  - name: T
    constraint: value
    default: base.core.bigint
    description: element type
fields:
  - name: low
    type: T
  - name: high
    type: T
`,
    'platform/base/core/value_type/status.yaml': `version: loom-schema/v2
kind: value_type
name: Status
variants:
  - value: active
    display_name: Active
  - value: inactive
  - value: suspended
`,

    'platform/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
name: Users
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
fields:
  - name: id
    type: bigint
    required: true
  - include: mixin:base.core.Audit
  - name: email
    type: base.core.Email
    required: true
    unique: true
  - name: balance
    type: base.core.Money
  - name: price_range
    type:
      ref: base.core.Range
      args: { T: decimal }
  - name: status
    type: base.core.Status
primary_key: [id]
indexes:
  - name: idx_users_email
    fields: [email]
    unique: true
`,
    'platform/base/core/entity/user.yaml': `version: loom-schema/v2
kind: entity
name: User
primary_table: table:base.core.Users
business_keys: [email]
audit: true
`,
    'platform/base/core/extension/user_fields.yaml': `version: loom-schema/v2
kind: extension_fields
entity: entity:base.core.User
fields:
  - name: nickname
    type:
      ref: string
      args: { max_length: 50 }
    default_scope: tenant
`,

    // ── ext:acme-corp — independent module with its own physical schema ──
    'ext/acme-corp/retail/pos/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: retail
module: pos
physical_schema: acme_retail_pos
description: acme-corp retail POS extension
`,
    'ext/acme-corp/retail/pos/table/orders.yaml': `version: loom-schema/v2
kind: table
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
    'tenants/acme/base/core/user_fields.yaml': `version: loom-schema/v2
kind: extension_fields
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
