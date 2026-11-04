# Record inheritance

Set or change a parent in the same table:

    devcel --project /path/to/project record parent TABLE CHILD_UUID PARENT_UUID

Detach while retaining the child's effective raw inputs (including formulas):

    devcel --project /path/to/project record detach TABLE CHILD_UUID

Write a local input, or clear it to follow the parent and then the column default:

    devcel --project /path/to/project cell set TABLE RECORD_UUID COLUMN VALUE
    devcel --project /path/to/project cell set TABLE RECORD_UUID COLUMN ""

An exactly empty input removes its storage key. Whitespace-only input and formula
expressions remain local input. Formula results do not change stored input.
There is no separate source-selection state or parent-bypassing default override.
Columns accept data names or UUIDs.

The operation protocol uses `SetRecordValue`. Parent changes use
`SetRecordParentUuid`; an empty `parent_uuid` detaches. Both support atomic
batches, undo/redo and server-authoritative peer snapshots. Invalid parents and
cycles are rejected rather than coerced.

Plugin raw TableData preserves `parent_uuid` and stored input maps. Do not write
resolved display values back into those maps. Standard exports contain flat
effective values; raw table APIs retain the authoring representation.
