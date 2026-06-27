# 设计记录：ext 策略解耦（strategy decoupling）

- **日期**：2026-06-24
- **状态**：设计草案（待实现）
- **动机**：当前 ext 的物理实现（sidecar 表名、存储策略）由 base table 决定，导致扩展方无法自主选择存储方式。解耦后 table 只回答"能否扩展"，ext 自己决定"用什么方式扩展"。这同时让扩展在 textrix 层呈现为可组合的独立 source。
- **前置**：[2026-06-22-jsonb-extension-groups.md](./2026-06-22-jsonb-extension-groups.md)（JSONB 扩展组）、[2026-06-19-owner-dimension-notes.md](./2026-06-19-owner-dimension-notes.md)（owner 维度）

---

## 1. 问题

当前（耦合设计）：

```yaml
table: Products
  extension:
    strategy: sidecar_eav     # ← table 决定存储方式
    ext_table: products_ext   # ← table 命名扩展表

ext.yaml:
  entity: entity:shop.core.Product
  fields: [sku, stock_qty]    # ← ext 只管字段，不懂存储
```

三个决策耦合在 table 上：

| 决策 | 当前归属 | 问题 |
|------|---------|------|
| 允许扩展吗？ | table | ✅ 合理 |
| 用什么方式存？ | table（`strategy`） | ❌ 应由扩展方决定 |
| 表叫什么？ | table（`ext_table`） | ❌ 应由扩展方决定 |

不同 provider 有不同的存储需求（少量字段用 JSONB、大量字段需要独立表+索引），但当前设计强制全局统一。

## 2. 解耦设计

### 2.1 职责划分

```
loom table 的职责：
  - 定义 base 字段
  - 声明是否允许扩展（extensible: true/false）
  - 建议默认 sidecar 表名（default_ext_table，可选，语义为建议非强制）
  - 仅此——不管扩展的物理实现

loom ext 的职责：
  - 声明扩展策略（sidecar_jsonb / new_table）
  - 声明表名（new_table 必填；sidecar 可选覆盖默认/建议）
  - 声明数据字段（FK 列由 loom 自动注入，ext 不感知）
  - owner / group 从文件路径和内容推导
```

### 2.2 table schema 变更

```yaml
# 现在（耦合）
table: shop.core.Products
extension:
  strategy: sidecar_eav
  ext_table: products_ext

# 解耦后
table: shop.core.Products
extensible: true                  # ← 是否允许扩展
default_ext_table: products_ext   # ← 可选：设计者建议的 sidecar 表名（建议，非强制）
# 没有 extension 对象了
```

`extension` 对象（含 `strategy`/`ext_table`）删除。新增：
- `extensible: boolean`，默认 `false`——回答"能否扩展"
- `default_ext_table: string`（可选）——table 设计者建议的 sidecar 表名，ext 可选择遵从或覆盖

**sidecar 表名优先级**（从高到低）：
1. ext 显式声明 `table` → 用该名字（扩展者覆盖）
2. table 的 `default_ext_table` → 用该值（设计者建议）
3. 默认推导 → `<base_table>_ext`（自动生成）

### 2.3 ext schema 变更

```yaml
ext: provider-a/shop/core/product_inventory.ext.yaml
version: loom-schema/v2
entity: entity:shop.core.Product
strategy: new_table              # ← 新增：扩展策略
table: shop_products_inventory   # ← new_table 必填 / sidecar 可选
group: inventory                 # 可选，默认文件名
fields:                          # ← 只声明数据字段，FK 列由 loom 自动注入
  - name: sku
    type: string
    args: { max_length: 64 }
  - name: stock_qty
    type: bigint
```

```yaml
ext: provider-a/shop/core/product_meta.ext.yaml
version: loom-schema/v2
entity: entity:shop.core.Product
strategy: sidecar_jsonb          # ← 统一 EAV+JSONB 表
table: shop_shared_ext           # ← 可选：覆盖默认 <base_table>_ext
group: meta
fields:
  - name: shelf_location
    type: string
```

## 3. 两种策略

### 3.1 sidecar_jsonb

统一的 EAV+JSONB 结构。多个扩展组共用一张表，按 `source` hash 区分行。

**表名来源**（优先级从高到低）：
1. ext 显式声明 `table` → 用该名字（扩展者覆盖）
2. table 的 `default_ext_table` → 用该值（设计者建议）
3. 默认推导 → `<base_table>_ext`

**表结构**（按 base 主键列数生成对应 base_id 列）：

```sql
-- 单主键（base PK = 1 列）
CREATE TABLE <ext_table> (
  base_id_0  <pk_type>  NOT NULL,
  source     CHAR(16)   NOT NULL,
  values     JSONB      NOT NULL,
  created_at TIMESTAMP  DEFAULT NOW()
);
CREATE INDEX idx_ext ON <ext_table>(base_id_0, source);

-- 复合主键（base PK = N 列）
CREATE TABLE <ext_table> (
  base_id_0  <pk_type_0>  NOT NULL,
  base_id_1  <pk_type_1>  NOT NULL,
  ...
  base_id_N  <pk_type_N>  NOT NULL,
  source     CHAR(16)     NOT NULL,
  values     JSONB        NOT NULL,
  created_at TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX idx_ext ON <ext_table>(base_id_0, ..., base_id_N, source);
```

**base_id 类型**：从 base table 的 primary_key 字段类型自动推导。

| base PK 类型 | base_id 类型 |
|---|---|
| Integer / BigInt | BIGINT |
| UUID | VARCHAR |
| String | VARCHAR |

### 3.2 new_table

ext provider 完全自定义的物理表。独立列（非 JSONB），可建索引/约束。

**表名**：ext 的 `table` 属性（必填）。

**FK 列**：loom 编译期自动注入——从 base table 的 `primary_key` 读取列名和类型，在 ext 字段列表头部插入同名同类型列，并生成 FOREIGN KEY 约束。**ext 用户不声明、不感知 FK 列。**

**表结构**：loom 自动注入的 FK 列 + ext 的 `fields` 直接映射为物理列。

```sql
-- base Products PK = [id: uuid]
-- ext 只声明了 sku, stock_qty
-- loom 自动注入 id 列 + FK 约束
CREATE TABLE shop_products_inventory (
  id          UUID          NOT NULL,    -- ← loom 自动注入（复用 base PK 列名）
  sku         VARCHAR(64),                -- ← ext 用户声明
  stock_qty   BIGINT,                     -- ← ext 用户声明
  FOREIGN KEY (id) REFERENCES shop_products(id)   -- ← 自动生成
);
CREATE INDEX idx_inv_sku ON shop_products_inventory(sku);
```

**重名检查**：loom 注入的 FK 列参与字段名唯一性校验。若 ext 用户声明的字段与注入列同名 → 编译期报错：

```
error: field "id" in ext "shop_products_inventory" conflicts with
auto-injected FK column (from base table primary_key)
```

### 3.3 策略对比

| | sidecar_jsonb | new_table |
|---|---|---|
| 表结构 | 统一 EAV+JSONB | 用户自定义 |
| 表名 | 默认 `<base>_ext` 或 ext 指定 | ext 指定（必填） |
| 字段存储 | JSONB `values` 文档 | 独立物理列 |
| 单主键 | ✅ | ✅ |
| 复合主键 | ✅（base_id_0..N） | ✅（复合 join） |
| 索引能力 | JSONB GIN（弱） | 普通列索引（强） |
| 约束能力 | 无 | NOT NULL / CHECK / UNIQUE |
| 共用 ext 表 | ✅（主键结构兼容时） | 不共用 |
| FK 关联 | loom 自动注入 base_id_0..N | loom 自动注入 base PK 列（同名） |
| source hash | 需要 | 不需要 |

## 4. 共用 sidecar 表

多个 base table 可复用同一张 sidecar ext 表（如共享扩展基础设施）。

### 4.1 共用条件

共用同一张 sidecar ext 表的所有 base table，**主键结构必须兼容**：
- 主键列数相同
- 对应列的类型相同（整数族 Integer/BigInt 互相兼容）

| base table A | base table B | 兼容？ |
|---|---|:---:|
| `[UUID]` | `[UUID]` | ✅ |
| `[Integer]` | `[BigInt]` | ✅（整数族） |
| `[UUID]` | `[Integer]` | ❌ |
| `[UUID, Integer]` | `[UUID, Integer]` | ✅ |
| `[UUID]` | `[UUID, Integer]` | ❌（列数不同） |

### 4.2 编译期校验

loom 编译期对共用同一张 sidecar ext 表的所有 base table：

1. 收集所有引用该 ext 表的 base table
2. 取每个 base table 的 `primary_key` 字段类型序列
3. 比较序列：长度相同 + 对应位置类型兼容 → 通过
4. 否则 → 报错

```
error: sidecar table "shop_shared_ext" is shared by tables with incompatible primary keys
  - shop.core.Products: [UUID] (VARCHAR)
  - shop.core.Orders:   [Integer] (BIGINT)
  → primary key types do not match
```

## 5. source hash

sidecar 表内部，一行数据用 source hash 区分来源（base table + owner + group）。

### 5.1 构成

```
source_hash = xxHash64('<base_table_identity>:<owner>:<group>')
            → 16 位十六进制字符串
```

**必须包含 base_table**——因为多个 table 可复用同一张 ext 表，不包含 table 标识会导致不同 table 的数据混淆。

| base table | owner | group | hash 输入 |
|---|---|---|---|
| table:shop.core.Products | ext:provider-a | inventory | `table:shop.core.Products:ext:provider-a:inventory` |
| table:shop.core.Products | platform | meta | `table:shop.core.Products:platform:meta` |
| table:shop.core.Categories | ext:provider-a | meta | `table:shop.core.Categories:ext:provider-a:meta` |

### 5.2 算法

- **xxHash64**：64-bit，16 位十六进制输出
- 确定性：同输入永远同输出
- 碰撞概率：10 亿条数据碰撞概率约 0.01%
- loom 编译期计算，写入 ext 元数据 + pivot view 查询条件

### 5.3 仅 sidecar 需要

new_table 是独立物理表，表名本身标识来源，不需要 source hash。

## 6. pivot view 生成

sidecar 扩展的 pivot view 将 JSONB 字段展开为虚拟列：

```sql
-- 单主键
CREATE VIEW products_full AS
SELECT
  p.*,
  e.values->>'shelf_location' AS shelf_location
FROM Products p
LEFT JOIN products_ext e
  ON e.base_id_0 = p.id
  AND e.source = '<hash of Products:ext:provider-a:meta>';

-- 复合主键
CREATE VIEW orderitems_full AS
SELECT
  o.*,
  e.values->>'audit_note' AS audit_note
FROM OrderItems o
LEFT JOIN orderitems_ext e
  ON e.base_id_0 = o.order_id
  AND e.base_id_1 = o.line_num
  AND e.source = '<hash of OrderItems:ext:provider-a:audit>';
```

## 7. 对 textrix 的影响

ext 解耦后，扩展在 loom 层有了独立的物理身份（自己的表/存储/策略），textrix 能将其当作**可组合的独立 source**。

### 7.1 textrix 视角

textrix 不关心 ext 是 sidecar 还是 new_table——它只看到 entity 有若干 ext source，每个 source 有字段：

```
领域对象 Product:
  sources:
    base:      table:shop.Products            ← loom table
    inventory: ext:shop.Product.Inventory     ← loom ext（new_table）
    meta:      ext:shop.Product.Meta          ← loom ext（sidecar_jsonb）
  fields:                         ← 领域对象选取的字段（跨 source）
    title:   ← base.title
    sku:     ← inventory.sku
    stock:   ← inventory.stock_qty
    shelf:   ← meta.shelf_location
```

### 7.2 选择 vs 启用

textrix 的领域对象从物理表的全部字段中**选取**需要暴露给 UI 的子集。这不是物理开关（没有 enable/disable）——没选中的字段物理上仍存在，只是这个领域对象不操作它。

## 8. 涉及的改动

### 8.1 loom 侧

| 文件 | 改动 |
|------|------|
| `ir/schemas.ts` | TableSchema: 删除 `extension` 对象，新增 `extensible: boolean` |
| `ir/schemas.ts` | ExtensionFieldsSchema: 新增 `strategy`/`table` |
| `ir/version.ts` | ExtensionFieldEntry: 新增 `strategy`/`tableName`/`sourceHash` |
| `loader/link.ts` | `collectExtensionFields`: 按 strategy 分组收集 |
| `loader/validate.ts` | 新增：共用 sidecar 表主键兼容校验 |
| `projector/expand.ts` | 按 strategy 生成不同的物理表定义；new_table 自动注入 FK 列 |
| `projector/views.ts` | `buildPivotViews`: 支持复合主键 JOIN |
| `projector/dialects/*.ts` | sidecar 表结构按主键列数生成；new_table 按自定义列 + 自动注入 FK 列生成 |

### 8.2 兼容性

- 旧 schema（`extension.strategy: sidecar_eav`）需迁移为新格式（`extensible: true` + ext 的 `strategy: sidecar_jsonb`）
- 迁移脚本：读旧 `extension` 对象，生成对应的 ext 文件
- golden 测试需更新

## 9. 示例

### 9.1 完整的多策略实体

```yaml
# table（base）
table: shop.core.Products
extensible: true
default_ext_table: products_ext
primary_key: [id]
fields:
  - { name: id, type: uuid, required: true }
  - { name: title, type: string }
  - { name: price, type: decimal, args: { precision: 9, scale: 2 } }

# ext（sidecar_jsonb，轻量扩展）
ext: provider-a/shop/core/product_meta.ext.yaml
entity: entity:shop.core.Product
strategy: sidecar_jsonb
group: meta
fields:
  - { name: shelf_location, type: string }

# ext（new_table，重量级扩展）
ext: provider-a/shop/core/product_inventory.ext.yaml
entity: entity:shop.core.Product
strategy: new_table
table: shop_products_inventory
group: inventory
fields:
  - { name: sku, type: string, args: { max_length: 64 } }
  - { name: stock_qty, type: bigint }
```

### 9.2 共用 sidecar 表

```yaml
# Products（UUID 主键）
ext: provider-a/shop/core/product_meta.ext.yaml
entity: entity:shop.core.Product
strategy: sidecar_jsonb
table: shop_shared_ext          # ← 共用表
fields: [{ name: shelf_location, type: string }]

# Categories（UUID 主键）—— 兼容，可共用
ext: provider-a/shop/core/category_meta.ext.yaml
entity: entity:shop.core.Category
strategy: sidecar_jsonb
table: shop_shared_ext          # ← 同一张表
fields: [{ name: display_order, type: integer }]

# Orders（Integer 主键）—— 不兼容，编译期报错
ext: provider-a/shop/core/order_meta.ext.yaml
entity: entity:shop.core.Order
strategy: sidecar_jsonb
table: shop_shared_ext          # ← ERROR: PK 类型不匹配
fields: [{ name: priority, type: integer }]
```

产出 SQL：

```sql
-- sidecar（复合主键）
CREATE TABLE orderitems_ext (
  base_id_0  UUID       NOT NULL,   -- order_id
  base_id_1  INTEGER    NOT NULL,   -- line_num
  source     CHAR(16)   NOT NULL,
  values     JSONB      NOT NULL,
  created_at TIMESTAMP  DEFAULT NOW()
);
CREATE INDEX idx_ext ON orderitems_ext(base_id_0, base_id_1, source);

-- new_table（复合 FK）
CREATE TABLE orderitems_detail (
  fk_order_id  UUID     NOT NULL,
  fk_line_num  INTEGER  NOT NULL,
  detail_text  VARCHAR(255),
  FOREIGN KEY (fk_order_id, fk_line_num) REFERENCES OrderItems(order_id, line_num)
);

-- pivot view
CREATE VIEW orderitems_full AS
SELECT
  o.*,
  e.values->>'audit_note' AS audit_note
FROM OrderItems o
LEFT JOIN orderitems_ext e
  ON e.base_id_0 = o.order_id
  AND e.base_id_1 = o.line_num
  AND e.source = '<hash>';
```

### 9.3 复合主键

```yaml
table: shop.core.OrderItems
extensible: true
primary_key: [order_id, line_num]
fields:
  - { name: order_id, type: uuid, required: true }
  - { name: line_num, type: integer, required: true }

# sidecar（复合主键 → base_id_0 + base_id_1）
ext: provider-a/shop/core/orderitems_audit.ext.yaml
entity: entity:shop.core.OrderItems
strategy: sidecar_jsonb
group: audit
fields:
  - { name: audit_note, type: string }

# new_table（FK 列由 loom 自动注入）
ext: provider-a/shop/core/orderitems_detail.ext.yaml
entity: entity:shop.core.OrderItems
strategy: new_table
table: orderitems_detail
fields:
  - { name: detail_text, type: string }
```

产出 SQL：

```sql
-- sidecar（复合主键）
CREATE TABLE orderitems_ext (
  base_id_0  UUID       NOT NULL,   -- order_id
  base_id_1  INTEGER    NOT NULL,   -- line_num
  source     CHAR(16)   NOT NULL,
  values     JSONB      NOT NULL,
  created_at TIMESTAMP  DEFAULT NOW()
);
CREATE INDEX idx_ext ON orderitems_ext(base_id_0, base_id_1, source);

-- new_table（FK 列自动注入，复用 base PK 列名）
CREATE TABLE orderitems_detail (
  order_id    UUID     NOT NULL,    -- ← loom 自动注入（base PK[0]）
  line_num    INTEGER  NOT NULL,    -- ← loom 自动注入（base PK[1]）
  detail_text VARCHAR(255),          -- ← ext 用户声明
  FOREIGN KEY (order_id, line_num) REFERENCES OrderItems(order_id, line_num)
);

-- pivot view
CREATE VIEW orderitems_full AS
SELECT
  o.*,
  e.values->>'audit_note' AS audit_note
FROM OrderItems o
LEFT JOIN orderitems_ext e
  ON e.base_id_0 = o.order_id
  AND e.base_id_1 = o.line_num
  AND e.source = '<hash>';
```
