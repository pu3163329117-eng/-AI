import sqlite3

before = sqlite3.connect('file:F:/全息道/output/backups/wenyan-before-learning-path-20261007.db?mode=ro', uri=True)
after = sqlite3.connect('file:F:/全息道/data/wenyan.db?mode=ro', uri=True)
assert after.execute('pragma integrity_check').fetchone()[0] == 'ok'
tables = [r[0] for r in before.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
for table in tables:
    columns = [r[1] for r in before.execute(f'pragma table_info("{table}")')]
    selection = ','.join('"'+c+'"' for c in columns)
    original = set(before.execute(f'select {selection} from "{table}"').fetchall())
    current = set(after.execute(f'select {selection} from "{table}"').fetchall())
    assert original <= current, f'Old rows changed in {table}'
    if table != 'schema_migrations':
        assert original == current, f'Unexpected old table writes in {table}'
    print(f'{table}: preserved {len(original)} rows; current {len(current)}')
for table in ['recommendation_plans','recommendation_heads','recommendation_tasks','learning_path_receipts']:
    print(table, after.execute(f'select count(*) from "{table}"').fetchone()[0])
print('INTEGRITY_OK ALL_OLD_ROWS_UNCHANGED')
