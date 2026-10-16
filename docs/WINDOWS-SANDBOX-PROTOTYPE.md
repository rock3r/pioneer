# Windows AppContainer prototype

The research prototype lives in `native/windows-appcontainer`. Eval actors do not use it. CI and releases do not require it.

## Result

The prototype calls Windows' `Experimental_CreateProcessInSandbox` API directly. It compiles without administrator privileges on the tested host. Its `doctor` command fails closed.

The tested Windows 11 build `10.0.26200` exports
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

The failed probes created no AppContainer profile. The TypeScript eval runner still rejects Windows before launch.

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

Keep the helper disabled until it passes every required probe on a host with the API enabled. These probes cover filesystems, environments, interprocess communication (IPC), process trees, and non-LAN networking.

## What Codex does on Windows

The source review used Codex CLI commit `4462b9deef211723b781b426f5e5d36a5777115f`.

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

The prototype copies Codex's fail-closed capability selection, System32-pinned DLL loading, clean environment, job/UI restrictions, and required adversarial tests. It leaves dedicated accounts, host ACL changes, and persistent firewall rules out of scope.

## Why Brokered File System was not tried

The tested host has `C:\Windows\System32\bfscfg.exe`. Microsoft MXC commit `a101c5ef671fc8e4cb4ceaf1ebb59f5d3b286849` disables the Brokered File System tier in shipping builds. Calling `bfscfg.exe` can deadlock Windows 25H2. Pioneer did not run it.

The remaining classic AppContainer approach changes host NTFS discretionary access control lists (DACLs) for the AppContainer security identifier (SID). This experiment excludes host permission changes. Pioneer did not implement or run that approach.

## Remaining limitations

- The API is experimental and its feature enablement is independent of whether
  the DLL export exists.
- Filesystem enforcement could not be exercised on the tested host because process
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
