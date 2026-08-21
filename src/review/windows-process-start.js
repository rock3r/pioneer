var pid = new ActiveXObject("WScript.Shell").Environment("Process")("PIONEER_RETENTION_OWNER_PID");
if (!/^[1-9][0-9]{0,15}$/.test(pid)) {
  WScript.Quit(1);
}
var processes = GetObject("winmgmts:").ExecQuery(
  "SELECT CreationDate FROM Win32_Process WHERE ProcessId=" + pid
);
var enumerator = new Enumerator(processes);
if (enumerator.atEnd()) {
  WScript.Quit(1);
}
var created = enumerator.item().CreationDate;
if (created == null || String(created) === "") {
  WScript.Quit(1);
}
WScript.StdOut.Write(created);
