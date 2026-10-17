import sqlite3
import sys

baseline = 'F:/全息道/output/backups/wenyan-before-observations-20261008.db'
current = sqlite3.connect('file:F:/全息道/data/wenyan.db?mode=ro', uri=True)
if sys.argv[1:] == ['backup']:
    import os
    assert not os.path.exists(baseline), 'Do not overwrite existing baseline'
    saved = sqlite3.connect(baseline)
    current.backup(saved)
    assert saved.execute('pragma integrity_check').fetchone()[0] == 'ok'
    print('BACKUP_OK')
else:
    original = sqlite3.connect('file:' + baseline + '?mode=ro', uri=True)
    assert current.execute('pragma integrity_check').fetchone()[0] == 'ok'
    allowed_new = {'learner_profiles', 'training_sessions', 'training_events', 'command_receipts'}
    for table, in original.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'"):
        columns = [row[1] for row in original.execute(f'pragma table_info("{table}")')]
        projection = ','.join('"' + c + '"' for c in columns)
        old = set(original.execute(f'select {projection} from "{table}"'))
        new = set(current.execute(f'select {projection} from "{table}"'))
        assert old <= new, f'Changed pre-existing rows in {table}'
        if table not in allowed_new:
            assert old == new, f'Unexpected additional rows in {table}'
        print(f'{table}: old {len(old)}, current {len(new)}, original rows intact')
    observations = current.execute('select session_id, stage, source_event_id, payload from stage_observations').fetchall()
    assert len({(row[0], row[1]) for row in observations}) == len(observations)
    assert len({row[2] for row in observations}) == len(observations)
    import json
    for sid, stage, event_id, payload in observations:
        event = current.execute('select session_id,type,payload from training_events where id=?', (event_id,)).fetchone()
        assert event and event[0] == sid and event[1] == 'training.first_attempt_recorded'
        assert json.loads(event[2]) == json.loads(payload)
    print(f'stage_observations: {len(observations)} unique stages with real source events')
    print('INTEGRITY_OK ORIGINAL_ROWS_UNCHANGED')
