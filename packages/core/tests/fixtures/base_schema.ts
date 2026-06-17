import type { FileSystem } from '../../src/loader/fs.js';
import { MemoryFileSystem } from './memory_fs.js';

/**
 * A small but complete loom schema used across loader/projector tests.
 * Covers: base_types, module_manifest, single & multi value_types,
 * mixin include, sidecar_eav table, entity referencing the table,
 * extension_fields targeting the entity.
 */
export function buildBaseSchemaFs(): FileSystem {
  return new MemoryFileSystem({
    'base_types.yaml': `version: loom-schema/v1
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
    'systems/base/core/MANIFEST.yaml': `version: loom-schema/v1
kind: module_manifest
system: base
module: core
physical_schema: base_core
description: core module
`,
    'systems/base/_shared/mixin/audit.yaml': `version: loom-schema/v1
kind: mixin
name: Audit
fields:
  - name: created_at
    base: datetime
    required: true
  - name: updated_at
    base: datetime
    required: true
`,
    'systems/base/core/value_type/email.yaml': `version: loom-schema/v1
kind: value_type
name: Email
fields:
  - name: value
    base: string
    max_length: 254
`,
    'systems/base/core/value_type/money.yaml': `version: loom-schema/v1
kind: value_type
name: Money
fields:
  - name: amount
    base: decimal
    precision: 18
    scale: 4
    required: true
  - name: currency_code
    base: string
    max_length: 3
    required: true
`,
    'systems/base/core/table/users.yaml': `version: loom-schema/v1
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
    base: bigint
    required: true
  - include: mixin:base._shared.Audit
  - name: email
    ref: value_type:base.core.Email
    required: true
    unique: true
  - name: balance
    ref: value_type:base.core.Money
primary_key: [id]
indexes:
  - name: idx_users_email
    fields: [email]
    unique: true
`,
    'systems/base/core/entity/user.yaml': `version: loom-schema/v1
kind: entity
name: User
primary_table: table:base.core.Users
business_keys: [email]
audit: true
`,
    'systems/base/core/extension/user_fields.yaml': `version: loom-schema/v1
kind: extension_fields
entity: entity:base.core.User
fields:
  - name: nickname
    base: string
    max_length: 50
    default_scope: tenant
`,
  });
}
