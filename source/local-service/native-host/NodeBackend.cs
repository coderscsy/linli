using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OliviaSoul
{
    public sealed class NodeBackend : IDisposable
    {
        private const string ProtocolPrefix = "OLIVIA\t";
        private readonly AppPaths _paths;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private readonly object _writeLock = new object();
        private readonly ConcurrentDictionary<string, TaskCompletionSource<object>> _pending =
            new ConcurrentDictionary<string, TaskCompletionSource<object>>();
        private readonly TaskCompletionSource<int> _ready = new TaskCompletionSource<int>();
        private Process _process;
        private IntPtr _job;
        private int _disposed;
        private readonly object _stopLock = new object();
        private Task _stopTask;

        public int Port { get; private set; }
        public event Action<int> PortChanged;
        public event Action<string> Log;

        public NodeBackend(AppPaths paths)
        {
            _paths = paths;
        }

        public async Task StartAsync()
        {
            if (!File.Exists(_paths.NodeHostScript)) throw new FileNotFoundException("缺少 Node 宿主脚本", _paths.NodeHostScript);
            Directory.CreateDirectory(_paths.Workspace);
            Directory.CreateDirectory(_paths.Data);
            StopStaleProcesses();
            _process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = _paths.NodeExecutable,
                    Arguments = string.Join(" ", new[]
                    {
                        Quote(_paths.NodeHostScript),
                        "--root", Quote(_paths.Workspace),
                        "--data-dir", Quote(_paths.Data),
                        "--template", Quote(_paths.Template),
                        "--app-data", Quote(_paths.UserData),
                        "--usersettings", Quote(_paths.GameUserSettings),
                        "--executable", Quote(Application.ExecutablePath),
                        "--parent-pid", Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture),
                    }),
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(_paths.NodeHostScript),
                },
                EnableRaisingEvents = true,
            };
            _process.OutputDataReceived += OnOutput;
            _process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (!string.IsNullOrWhiteSpace(args.Data)) RaiseLog(args.Data);
            };
            _process.Exited += delegate
            {
                var error = new InvalidOperationException("Node 服务已退出，退出码：" + _process.ExitCode);
                RaiseLog("node exited pid=" + _process.Id.ToString(CultureInfo.InvariantCulture) +
                    " code=" + _process.ExitCode.ToString(CultureInfo.InvariantCulture));
                _ready.TrySetException(error);
                foreach (var item in _pending) item.Value.TrySetException(error);
            };
            if (!_process.Start()) throw new InvalidOperationException("无法启动内置 Node 服务");
            BindToCurrentProcessLifetime();
            RaiseLog("node started pid=" + _process.Id.ToString(CultureInfo.InvariantCulture) +
                " parent=" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
            var completed = await Task.WhenAny(_ready.Task, Task.Delay(TimeSpan.FromSeconds(30))).ConfigureAwait(false);
            if (completed != _ready.Task) throw new TimeoutException("等待本机服务启动超时");
            Port = await _ready.Task.ConfigureAwait(false);
        }

        private void BindToCurrentProcessLifetime()
        {
            _job = CreateJobObject(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var information = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new JobObjectBasicLimitInformation
                {
                    LimitFlags = JobObjectLimitKillOnJobClose,
                },
            };
            var length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            var pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(information, pointer, false);
                if (!SetInformationJobObject(_job, 9, pointer, (uint)length))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                if (!AssignProcessToJobObject(_job, _process.Handle))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            catch
            {
                _process.Kill();
                CloseHandle(_job);
                _job = IntPtr.Zero;
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        private void StopStaleProcesses()
        {
            var processName = Path.GetFileNameWithoutExtension(_paths.NodeExecutable);
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try
                {
                    if (!string.Equals(process.MainModule.FileName, _paths.NodeExecutable, StringComparison.OrdinalIgnoreCase)) continue;
                    RaiseLog("stale node found pid=" + process.Id.ToString(CultureInfo.InvariantCulture));
                    process.Kill();
                    process.WaitForExit(5000);
                    RaiseLog("stale node stopped pid=" + process.Id.ToString(CultureInfo.InvariantCulture));
                }
                catch (InvalidOperationException)
                {
                }
                catch (System.ComponentModel.Win32Exception)
                {
                }
                finally
                {
                    process.Dispose();
                }
            }
        }

        public async Task<object> SendAsync(string method, params object[] args)
        {
            if (_process == null || _process.HasExited) throw new InvalidOperationException("本机服务未运行");
            var id = Guid.NewGuid().ToString("N");
            var completion = new TaskCompletionSource<object>();
            if (!_pending.TryAdd(id, completion)) throw new InvalidOperationException("无法登记桌面命令");
            var payload = new Dictionary<string, object>
            {
                { "type", "command" },
                { "id", id },
                { "method", method },
                { "args", args ?? new object[0] },
            };
            try
            {
                lock (_writeLock)
                {
                    _process.StandardInput.WriteLine(_json.Serialize(payload));
                    _process.StandardInput.Flush();
                }
            }
            catch
            {
                TaskCompletionSource<object> ignored;
                _pending.TryRemove(id, out ignored);
                throw;
            }
            return await completion.Task.ConfigureAwait(false);
        }

        public Task StopAsync()
        {
            lock (_stopLock)
            {
                if (_stopTask == null) _stopTask = StopCoreAsync();
                return _stopTask;
            }
        }

        private async Task StopCoreAsync()
        {
            if (_process == null || _process.HasExited) return;
            RaiseLog("node graceful stop pid=" + _process.Id.ToString(CultureInfo.InvariantCulture));
            try
            {
                var shutdown = SendAsync("shutdown");
                var completed = await Task.WhenAny(shutdown, Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false);
                if (completed == shutdown) await shutdown.ConfigureAwait(false);
                if (!_process.WaitForExit(5000)) _process.Kill();
            }
            catch
            {
                if (!_process.HasExited) _process.Kill();
            }
        }

        private void OnOutput(object sender, DataReceivedEventArgs args)
        {
            var line = args.Data;
            if (string.IsNullOrEmpty(line)) return;
            if (!line.StartsWith(ProtocolPrefix, StringComparison.Ordinal))
            {
                RaiseLog(line);
                return;
            }
            try
            {
                var message = _json.Deserialize<Dictionary<string, object>>(line.Substring(ProtocolPrefix.Length));
                var type = Convert.ToString(message["type"], CultureInfo.InvariantCulture);
                if (type == "ready")
                {
                    _ready.TrySetResult(Convert.ToInt32(message["port"], CultureInfo.InvariantCulture));
                    return;
                }
                if (type == "port")
                {
                    Port = Convert.ToInt32(message["port"], CultureInfo.InvariantCulture);
                    var changed = PortChanged;
                    if (changed != null) changed(Port);
                    return;
                }
                if (type != "response") return;
                var id = Convert.ToString(message["id"], CultureInfo.InvariantCulture);
                TaskCompletionSource<object> completion;
                if (!_pending.TryRemove(id, out completion)) return;
                if (Convert.ToBoolean(message["ok"], CultureInfo.InvariantCulture))
                    completion.TrySetResult(message.ContainsKey("data") ? message["data"] : null);
                else
                    completion.TrySetException(new InvalidOperationException(Convert.ToString(message["error"], CultureInfo.InvariantCulture)));
            }
            catch (Exception error)
            {
                RaiseLog("桌面协议解析失败：" + error.Message);
            }
        }

        private void RaiseLog(string message)
        {
            var handler = Log;
            if (handler != null) handler(message);
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            if (_process != null)
            {
                try
                {
                    StopAsync().GetAwaiter().GetResult();
                }
                catch
                {
                    if (!_process.HasExited) _process.Kill();
                }
                _process.Dispose();
                _process = null;
            }
            if (_job != IntPtr.Zero)
            {
                CloseHandle(_job);
                _job = IntPtr.Zero;
            }
        }

        private const uint JobObjectLimitKillOnJobClose = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
