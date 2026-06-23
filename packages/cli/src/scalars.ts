/**
 * Templates for the 18 CDS-aligned built-in scalars.
 *
 * Used by `loom init` to generate the base scalar vocabulary.
 * Each entry is a plain object, serialized to YAML via the yaml library.
 */

export interface ScalarDef {
  name: string;
  description: string;
  properties: Array<{ name: string; type: string; required?: boolean }>;
}

export const BUILTIN_SCALARS: readonly ScalarDef[] = [
  { name: 'uuid', description: 'RFC 4122 UUID', properties: [] },
  { name: 'boolean', description: 'boolean', properties: [] },
  { name: 'uint8', description: 'unsigned 8-bit integer', properties: [] },
  { name: 'int16', description: '16-bit integer', properties: [] },
  { name: 'integer', description: '32-bit integer', properties: [] },
  { name: 'bigint', description: '64-bit integer', properties: [] },
  {
    name: 'decimal',
    description: 'fixed-point number',
    properties: [
      { name: 'precision', type: 'integer', required: true },
      { name: 'scale', type: 'integer', required: true },
    ],
  },
  { name: 'double', description: 'double-precision float', properties: [] },
  {
    name: 'string',
    description: 'var-length string',
    properties: [
      { name: 'max_length', type: 'integer', required: true },
      { name: 'pattern', type: 'string' },
    ],
  },
  { name: 'largestring', description: 'unlimited-length string', properties: [] },
  { name: 'date', description: 'calendar date', properties: [] },
  { name: 'time', description: 'time of day', properties: [] },
  { name: 'datetime', description: 'timestamp', properties: [] },
  { name: 'timestamp', description: 'high-precision timestamp', properties: [] },
  {
    name: 'binary',
    description: 'fixed-length binary',
    properties: [{ name: 'max_length', type: 'integer', required: true }],
  },
  { name: 'largebinary', description: 'unlimited-length binary', properties: [] },
  {
    name: 'vector',
    description: 'vector embedding',
    properties: [{ name: 'length', type: 'integer', required: true }],
  },
  { name: 'map', description: 'key-value map', properties: [] },
];

/** Build the plain object for a scalar type file. */
export function scalarObject(def: ScalarDef): Record<string, unknown> {
  return {
    version: 'loom-schema/v2',
    name: def.name,
    form: 'scalar',
    description: def.description,
    properties: def.properties,
  };
}
