# Windows AppContainer prototype

Status: implemented and compiled, but not enabled for eval actors.

## Result

The prototype in `native/windows-appcontainer` calls Windows'
`Experimental_CreateProcessInSandbox` API directly. It compiles without
administrator privileges on Mattone and its `doctor` command fails closed.

Mattone's Windows 11 build `10.0.26200` exports
`Experimental_CreateProcessInSandbox`, but the feature is disabled. A real
create call returns Win32 error 120 (`ERROR_CALL_NOT_IMPLEMENTED`):

```json
{
  "ExportPresent": true,
  "Usable": false,
  "Capabilities": 0,
  "Error": "create export is feature-gated (Win32 120)"
}
```

No AppContainer profile was created by the failed probes. The TypeScript eval
runner therefore retains its existing pre-launch Windows rejection.

## Intended boundary

When the OS capability is available, the helper requests:

- a unique AppContainer identity;
- one read/write eval-run directory;
- exact read-only runtime directories;
- no inherited parent environment;
- no network capability by default;
- Win32k system-call disable; and
- every currently documented `JOB_OBJECT_UILIMIT_*` restriction.

The helper loads `processmodel.dll` only from System32, passes
`inheritHandles = FALSE`, uses an explicit UTF-16 environment block, and waits
for the sandboxed process. The `SBOX` FlatBuffer follows Microsoft's published
`BaseContainerSpecification.fbs` layout.

The helper is not a supported fallback. It must still pass the complete
filesystem, environment, IPC, process-tree, and non-LAN network probe battery
on a host where the API is enabled.

## What Codex does on Windows

The open-source Codex CLI was inspected at commit
`4462b9deef211723b781b426f5e5d36a5777115f`.

Codex does not currently use AppContainer for its Windows command sandbox. Its
strong backend:

1. provisions dedicated local sandbox users;
2. resolves a permission profile before launch and rejects policies it cannot
   enforce;
3. grants filesystem access with SID-scoped ACLs;
4. creates a restricted token with maximum privileges disabled;
5. launches through `CreateProcessAsUserW`;
6. confines the process tree with a job object and optionally a private
   desktop;
7. uses named pipes restricted to the sandbox SID and verifies the connecting
   process ID; and
8. applies persistent, user-scoped firewall/WFP policy for offline and
   proxy-only modes.

Useful design choices copied into this prototype are fail-closed capability
selection, System32-pinned DLL loading, a clean environment, job/UI
restrictions, and mandatory adversarial validation. The dedicated accounts,
host ACL changes, and persistent firewall rules are deliberately not copied.

## Why Brokered File System was not tried

Mattone has `C:\Windows\System32\bfscfg.exe`, so classic AppContainer plus
Brokered File System appears superficially possible. Microsoft MXC commit
`a101c5ef671fc8e4cb4ceaf1ebb59f5d3b286849` explicitly compiles that tier out
of shipping builds because invoking `bfscfg.exe` can deadlock Windows 25H2.
Pioneer did not invoke it.

The remaining classic AppContainer fallback modifies host NTFS DACLs for the
AppContainer SID. That is the invasive mechanism this experiment is intended
to avoid, so it was not implemented or run.

## Remaining limitations

- The API is experimental and its feature enablement is independent of whether
  the DLL export exists.
- Filesystem enforcement could not be exercised on Mattone because process
  creation stops at the OS feature gate.
- The OS proxy field is not yet proven to provide public-internet access while
  denying loopback, LAN, link-local, and raw-socket bypasses.
- Descendant containment and AppContainer profile cleanup require live
  adversarial testing.
- A future successful run must prove that Node and Pi can execute from narrowly
  granted read-only runtime paths without exposing package-manager or user
  roots.

Do not remove the Windows fail-closed gate until every mandatory probe passes
on the exact supported Windows build.
