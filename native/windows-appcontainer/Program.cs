using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Google.FlatBuffers;

internal static partial class Program
{
  private const uint LoadLibrarySearchSystem32 = 0x00000800;
  private const uint CreateUnicodeEnvironment = 0x00000400;
  private const uint StartfUseStdHandles = 0x00000100;
  private const uint HandleFlagInherit = 0x00000001;
  private const uint Infinite = 0xffffffff;
  private const ulong AllUiRestrictions = 0x03ff;
  private const ulong SandboxCapCreateProcess = 0x01;

  private static int Main(string[] args)
  {
    try
    {
      if (args.Length == 1 && args[0] == "doctor")
      {
        var support = ProbeSupport();
        Console.WriteLine(JsonSerializer.Serialize(support));
        return support.Usable ? 0 : 1;
      }

      var request = LaunchRequest.Parse(args);
      return Launch(request);
    }
    catch (Exception error)
    {
      Console.Error.WriteLine(error is Win32Exception win32 ? error.Message + " (Win32 " + win32.NativeErrorCode + ")" : error.Message);
      return 125;
    }
  }

  private static SandboxSupport ProbeSupport()
  {
    if (!OperatingSystem.IsWindowsVersionAtLeast(10))
      return new(false, false, 0, "Windows is required");

    var module = Native.LoadLibraryExW("processmodel.dll", 0, LoadLibrarySearchSystem32);
    if (module == 0)
      return new(false, false, 0, new Win32Exception().Message);

    var createAddress = Native.GetProcAddress(module, "Experimental_CreateProcessInSandbox");
    if (createAddress == 0)
      return new(false, false, 0, "Experimental_CreateProcessInSandbox is absent");

    var queryAddress = Native.GetProcAddress(module, "Experimental_QuerySandboxSupport");
    if (queryAddress == 0)
    {
      var probe = Marshal.GetDelegateForFunctionPointer<ProbeCreateProcessInSandbox>(createAddress);
      _ = probe(0, 0, 0, 0, false, 0, 0, 0, 0, 0, 0, 0, 0);
      var error = Marshal.GetLastWin32Error();
      if (error == 120 || error == unchecked((int)0x80004001))
        return new(true, false, 0, "create export is feature-gated (Win32 " + error + ")");
      return new(true, true, 0, "create probe reached argument validation (Win32 " + error + ")");
    }

    var query = Marshal.GetDelegateForFunctionPointer<QuerySandboxSupport>(queryAddress);
    if (!query(out var capabilities))
      return new(true, false, 0, new Win32Exception().Message);

    return new(
        true,
        (capabilities & SandboxCapCreateProcess) != 0,
        capabilities,
        null
    );
  }

  private static int Launch(LaunchRequest request)
  {
    var support = ProbeSupport();
    if (!support.Usable)
      throw new InvalidOperationException(
          $"Windows sandbox API is unavailable: {support.Error ?? "capability disabled"}"
      );

    var module = Native.LoadLibraryExW("processmodel.dll", 0, LoadLibrarySearchSystem32);
    var address = Native.GetProcAddress(module, "Experimental_CreateProcessInSandbox");
    var create = Marshal.GetDelegateForFunctionPointer<CreateProcessInSandbox>(address);

    var specification = BuildSpecification(request);
    var environment = BuildEnvironmentBlock(request.Environment);
    var commandLine = new StringBuilder(QuoteCommand(request.Command));
    var startup = new StartupInfo
    {
      Size = Marshal.SizeOf<StartupInfo>(),
      Flags = StartfUseStdHandles,
      StandardInput = Native.GetStdHandle(-10),
      StandardOutput = Native.GetStdHandle(-11),
      StandardError = Native.GetStdHandle(-12),
    };
    SetInheritable(startup.StandardInput);
    SetInheritable(startup.StandardOutput);
    SetInheritable(startup.StandardError);

    var environmentPointer = Marshal.AllocHGlobal(environment.Length * sizeof(char));
    Marshal.Copy(environment, 0, environmentPointer, environment.Length);
    try
    {
      unsafe
      {
        fixed (byte* specificationPointer = specification)
        {
          if (
              !create(
                  null,
                  commandLine,
                  0,
                  0,
                  false,
                  CreateUnicodeEnvironment,
                  environmentPointer,
                  request.RunDirectory,
                  ref startup,
                  request.Identity,
                  (nint)specificationPointer,
                  checked((uint)specification.Length),
                  out var process
              )
          )
          {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Experimental_CreateProcessInSandbox failed"
            );
          }

          try
          {
            Native.CloseHandle(process.Thread);
            var wait = Native.WaitForSingleObject(process.Process, Infinite);
            if (wait != 0)
              throw new Win32Exception(
                  Marshal.GetLastWin32Error(),
                  $"WaitForSingleObject returned {wait}"
              );
            if (!Native.GetExitCodeProcess(process.Process, out var exitCode))
              throw new Win32Exception();
            return unchecked((int)exitCode);
          }
          finally
          {
            Native.CloseHandle(process.Process);
          }
        }
      }
    }
    finally
    {
      Marshal.FreeHGlobal(environmentPointer);
    }
  }

  private static byte[] BuildSpecification(LaunchRequest request)
  {
    var builder = new FlatBufferBuilder(1024);
    var version = builder.CreateString("0.1.0");
    var readWrite = CreateStringVector(builder, [request.RunDirectory]);
    var readOnly = CreateStringVector(builder, request.ReadOnlyPaths);

    Offset<FlatBufferTable> networkPolicy = default;
    if (request.ProxyUrl is not null)
    {
      var proxyUrl = builder.CreateString(request.ProxyUrl);
      builder.StartTable(1);
      builder.AddOffset(0, proxyUrl.Value, 0);
      var proxyInfo = new Offset<FlatBufferTable>(builder.EndTable());

      builder.StartTable(1);
      builder.AddOffset(0, proxyInfo.Value, 0);
      networkPolicy = new Offset<FlatBufferTable>(builder.EndTable());
    }

    builder.StartTable(12);
    builder.AddOffset(0, version.Value, 0);
    builder.AddBool(1, true, false);
    builder.AddBool(3, true, false);
    builder.AddUlong(4, AllUiRestrictions, 0);
    builder.AddBool(5, true, false);
    builder.AddOffset(7, readWrite.Value, 0);
    if (request.ReadOnlyPaths.Count > 0)
      builder.AddOffset(8, readOnly.Value, 0);
    if (request.ProxyUrl is not null)
      builder.AddOffset(9, networkPolicy.Value, 0);
    var root = builder.EndTable();
    builder.Finish(root, "SBOX");
    return builder.SizedByteArray();
  }

  private static VectorOffset CreateStringVector(
      FlatBufferBuilder builder,
      IReadOnlyList<string> values
  )
  {
    var offsets = values.Select(builder.CreateString).ToArray();
    builder.StartVector(sizeof(int), offsets.Length, sizeof(int));
    for (var index = offsets.Length - 1; index >= 0; index--)
      builder.AddOffset(offsets[index].Value);
    return builder.EndVector();
  }

  private static char[] BuildEnvironmentBlock(IReadOnlyDictionary<string, string> environment)
  {
    var result = new StringBuilder();
    foreach (var pair in environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
    {
      if (pair.Key.Contains('=') || pair.Key.Contains('\0') || pair.Value.Contains('\0'))
        throw new ArgumentException($"Invalid environment entry: {pair.Key}");
      result.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
    }
    result.Append('\0');
    if (environment.Count == 0)
      result.Append('\0');
    return result.ToString().ToCharArray();
  }

  private static string QuoteCommand(IReadOnlyList<string> command) =>
      string.Join(" ", command.Select(QuoteArgument));

  private static string QuoteArgument(string argument)
  {
    if (argument.Length > 0 && !argument.Any(character => char.IsWhiteSpace(character) || character == '"'))
      return argument;

    var result = new StringBuilder("\"");
    var backslashes = 0;
    foreach (var character in argument)
    {
      if (character == '\\')
      {
        backslashes++;
        continue;
      }
      if (character == '"')
      {
        result.Append('\\', backslashes * 2 + 1).Append('"');
        backslashes = 0;
        continue;
      }
      result.Append('\\', backslashes).Append(character);
      backslashes = 0;
    }
    return result.Append('\\', backslashes * 2).Append('"').ToString();
  }

  private static void SetInheritable(nint handle)
  {
    if (handle == 0 || handle == -1)
      throw new Win32Exception("A standard handle is unavailable");
    if (!Native.SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit))
      throw new Win32Exception();
  }

  [UnmanagedFunctionPointer(CallingConvention.Winapi, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private delegate bool QuerySandboxSupport(out ulong capabilities);

  [UnmanagedFunctionPointer(CallingConvention.Winapi, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private delegate bool ProbeCreateProcessInSandbox(
      nint applicationName, nint commandLine, nint processAttributes, nint threadAttributes,
      [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags,
      nint environment, nint currentDirectory, nint startupInfo, nint identity,
      nint sandboxSpecification, uint sandboxSpecificationSize, nint processInformation
  );

  [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private delegate bool CreateProcessInSandbox(
      string? applicationName,
      StringBuilder commandLine,
      nint processAttributes,
      nint threadAttributes,
      [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
      uint creationFlags,
      nint environment,
      string currentDirectory,
      ref StartupInfo startupInfo,
      string identity,
      nint sandboxSpecification,
      uint sandboxSpecificationSize,
      out ProcessInformation processInformation
  );

  private sealed record SandboxSupport(
      bool ExportPresent,
      bool Usable,
      ulong Capabilities,
      string? Error
  );

  private readonly record struct FlatBufferTable;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct StartupInfo
  {
    public int Size;
    public string? Reserved;
    public string? Desktop;
    public string? Title;
    public int X;
    public int Y;
    public int XSize;
    public int YSize;
    public int XCountChars;
    public int YCountChars;
    public int FillAttribute;
    public uint Flags;
    public short ShowWindow;
    public short Reserved2Size;
    public nint Reserved2;
    public nint StandardInput;
    public nint StandardOutput;
    public nint StandardError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation
  {
    public nint Process;
    public nint Thread;
    public uint ProcessId;
    public uint ThreadId;
  }

  private static partial class Native
  {
    [LibraryImport("kernel32.dll", EntryPoint = "LoadLibraryExW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    public static partial nint LoadLibraryExW(string fileName, nint file, uint flags);

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    public static partial nint GetProcAddress(nint module, string name);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool CloseHandle(nint handle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    public static partial uint WaitForSingleObject(nint handle, uint milliseconds);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetExitCodeProcess(nint process, out uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    public static partial nint GetStdHandle(int standardHandle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool SetHandleInformation(nint handle, uint mask, uint flags);
  }
}

internal sealed record LaunchRequest(
    string RunDirectory,
    string Identity,
    IReadOnlyList<string> ReadOnlyPaths,
    string? ProxyUrl,
    IReadOnlyDictionary<string, string> Environment,
    IReadOnlyList<string> Command
)
{
  public static LaunchRequest Parse(string[] arguments)
  {
    string? runDirectory = null;
    string? identity = null;
    string? proxyUrl = null;
    var readOnly = new List<string>();
    var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    var index = 0;
    while (index < arguments.Length && arguments[index] != "--")
    {
      var option = arguments[index++];
      if (index >= arguments.Length)
        throw new ArgumentException($"Missing value for {option}");
      var value = arguments[index++];
      switch (option)
      {
        case "--run-dir":
          runDirectory = RequireAbsoluteDirectory(value, option);
          break;
        case "--identity":
          identity = value;
          break;
        case "--read-only":
          readOnly.Add(RequireAbsoluteDirectory(value, option));
          break;
        case "--proxy":
          proxyUrl = new Uri(value, UriKind.Absolute).ToString();
          break;
        case "--env":
          var separator = value.IndexOf('=');
          if (separator < 1)
            throw new ArgumentException("--env must be NAME=VALUE");
          environment.Add(value[..separator], value[(separator + 1)..]);
          break;
        default:
          throw new ArgumentException($"Unknown option: {option}");
      }
    }

    if (index >= arguments.Length || arguments[index++] != "--")
      throw new ArgumentException("Expected -- before the command");
    var command = arguments[index..];
    if (command.Length == 0)
      throw new ArgumentException("A command is required");
    if (runDirectory is null)
      throw new ArgumentException("--run-dir is required");
    if (string.IsNullOrWhiteSpace(identity))
      throw new ArgumentException("--identity is required");

    return new(runDirectory, identity, readOnly, proxyUrl, environment, command);
  }

  private static string RequireAbsoluteDirectory(string value, string option)
  {
    if (!Path.IsPathFullyQualified(value))
      throw new ArgumentException($"{option} must be an absolute path");
    var fullPath = Path.GetFullPath(value);
    if (!Directory.Exists(fullPath))
      throw new DirectoryNotFoundException($"{option} does not exist: {fullPath}");
    return fullPath.TrimEnd(Path.DirectorySeparatorChar);
  }
}
