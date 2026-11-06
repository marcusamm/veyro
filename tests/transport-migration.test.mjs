import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Transport tool migration', () => {
  it('preserves existing data byte for byte, expands IDs and retains tenant constraints', () => {
    const result = execFileSync('python3', ['-c', String.raw`
import json, sqlite3, sys
from pathlib import Path
root = Path(sys.argv[1])
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys = ON')
db.execute('CREATE TABLE customers (id INTEGER PRIMARY KEY)')
db.execute('INSERT INTO customers VALUES (1)')
db.executescript((root/'migrations/0016_logistics_calculations.sql').read_text())
columns = 'id,customer_id,tool_id,name,input_json,schema_version,version,created_at,updated_at,archived_at'
for i, tool in enumerate(['tco','eoq','genbestilling','abc']):
  db.execute('INSERT INTO logistics_calculations (' + columns + ') VALUES (?,?,?,?,?,?,?,?,?,?)',
    ('old-' + tool, 1, tool, 'TEST Ældre ' + tool, '{ "preserve": "æøå", "value": 1.00 }', 1, i+2, 100, 200, 300 if i % 2 else None))
before = db.execute('SELECT * FROM logistics_calculations ORDER BY id').fetchall()
db.executescript('BEGIN;\n' + (root/'migrations/0018_transport_calculators.sql').read_text() + '\nCOMMIT;')
assert db.execute('SELECT * FROM logistics_calculations ORDER BY id').fetchall() == before
for tool in ['ladmeter','luftfragt','palletransport','containertransport','biltransport']:
  db.execute('INSERT INTO logistics_calculations (' + columns + ') VALUES (?,?,?,?,?,?,?,?,?,?)',
    (tool, 1, tool, 'TEST New', '{}', 1, 1, 1, 1, None))
for field, value in [('tool_id','unknown'),('customer_id',99),('input_json','invalid'),('schema_version',2),('version',0)]:
  try:
    db.execute('UPDATE logistics_calculations SET ' + field + '=? WHERE id=?', (value,'ladmeter'))
  except sqlite3.IntegrityError:
    pass
  else:
    raise AssertionError('Constraint lost: ' + field)
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
assert 'idx_logistics_calculations_owner' in [r[1] for r in db.execute('PRAGMA index_list(logistics_calculations)')]
db.execute('DELETE FROM customers WHERE id=1')
assert db.execute('SELECT COUNT(*) FROM logistics_calculations').fetchone()[0] == 0
print(json.dumps({'preserved': len(before), 'newTools': 5, 'cascade': True}))
`, fileURLToPath(new URL('../', import.meta.url))], { encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual({ preserved: 4, newTools: 5, cascade: true });
  });
});
