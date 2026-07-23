# Windows AppContainer launcher prototype

This helper launches one process with Windows'
`Experimental_CreateProcessInSandbox` API. It is intentionally a prototype and
is not selected by the eval runner until the mandatory isolation probes pass.

The sandbox uses:

- an AppContainer identity supplied by the controller;
- read/write access only to `--run-dir`;
- optional exact read-only runtime directories;
- a caller-built environment block;
- Win32k system-call disable and all documented UI job restrictions; and
- no network capability. An optional OS sandbox proxy may be supplied for
  experiments, but non-LAN egress is not yet claimed.

Build on Windows:

```powershell
dotnet publish native/windows-appcontainer -c Release -r win-x64 --self-contained false
```

Probe host support:

```powershell
pioneer-windows-sandbox.exe doctor
```

The FlatBuffer field layout follows Microsoft's MIT-licensed
`BaseContainerSpecification.fbs` from `microsoft/mxc`. The helper dynamically
loads `processmodel.dll` from System32 and fails closed if the API or capability
is unavailable.
