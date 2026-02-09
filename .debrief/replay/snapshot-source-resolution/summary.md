# Snapshot-Based Source Resolution

Walkthrough of how the new snapshot system resolves files during replay. Covers the source resolver's fallback chain (git → snapshot → workspace), the snapshot content provider that serves frozen file content, how the highlight handler integrates with it, and the capture logic that saves snapshots on trace creation.
