using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Globalization;

// No WinForms reference: all visibility dimensions are independent state. Tests
// invoke production methods inserted verbatim by the Node runner, never copies.
class FormClosingEventArgs : EventArgs { public bool Cancel; }
enum FormWindowState { Normal, Minimized }
enum ToolTipIcon { Info }
enum MessageBoxButtons { OK }
enum MessageBoxIcon { Error }
static class MessageBox { public static int Calls; public static void Show(string a, string b, MessageBoxButtons c, MessageBoxIcon d) { Calls++; } }
static class File { public static void WriteAllText(string a, string b) {} }
static class Path { public static string Combine(string a, string b) { return a + b; } }
class Paths { public string UserData = "isolated"; }
static class Application {
    public static event EventHandler Idle;
    public static int Exits;
    public static void Exit() { Exits++; }
}
class Tray { public bool Visible = true; public int Notices; public void ShowBalloonTip(int a, string b, string c, ToolTipIcon d) { Notices++; } }
class Backend {
    public TaskCompletionSource<object> Pending = new TaskCompletionSource<object>();
    public int Stops;
    public Task StopAsync() { Stops++; return Pending.Task; }
}
class OwnedProcess {
    public bool HasExited;
    public int Id = 123;
    public bool WaitForExit(int timeout) { HasExited = true; return true; }
    public void Kill() { throw new Exception("unexpected fallback kill in isolated test"); }
    public void Dispose() {}
}
class BackendLifecycle {
    readonly object _stopLock = new object();
    Task _stopTask;
    OwnedProcess _process = new OwnedProcess();
    IntPtr _job;
    int _disposed;
    public int Sends;
    public TaskCompletionSource<object> Shutdown = new TaskCompletionSource<object>();
    Task SendAsync(string command) { if(command != "shutdown") throw new Exception("wrong shutdown command"); Sends++; return Shutdown.Task; }
    void RaiseLog(string message) {}
    void CloseHandle(IntPtr handle) { throw new Exception("unexpected real handle boundary"); }
    /* BACKEND_HANDLERS */
}
class UiContext : SynchronizationContext {
    readonly Queue<Action> queue = new Queue<Action>();
    public override void Post(SendOrPostCallback action, object state) { lock(queue) queue.Enqueue(() => action(state)); }
    public void Drain() { while(true) { Action action; lock(queue) { if(queue.Count == 0) return; action = queue.Dequeue(); } action(); } }
}
class MainForm {
    bool _quitting, _shutdownComplete, _trayNoticeShown, _hiddenAtLaunch, _backendReady;
    readonly Paths _paths = new Paths();
    public readonly Backend _backend = new Backend();
    public readonly Tray _tray = new Tray();
    public bool IsDisposed, Visible = true, ShowInTaskbar = true;
    /* IS_QUITTING */
    public double Opacity;
    public FormWindowState WindowState;
    public int FinalCloses, CloseThread, UiCalls, ErrorPages;
    public readonly List<string> Logs = new List<string>();
    public TaskCompletionSource<object> Startup = new TaskCompletionSource<object>();
    public TaskCompletionSource<object> Shell = new TaskCompletionSource<object>();
    Task _;
    public void Hide() { Visible = false; }
    public void Show() { Visible = true; }
    public void Activate() {}
    public void BringToFront() {}
    public void BeginInvoke(Action action) { SynchronizationContext.Current.Post(ignored => action(), null); }
    public void Close() { var args = new FormClosingEventArgs(); OnFormClosing(this, args); if (!args.Cancel) { FinalCloses++; CloseThread = Thread.CurrentThread.ManagedThreadId; IsDisposed = true; } }
    void WriteRuntimeLog(string message) { Logs.Add(message); }
    void LogStartupStage(string stage) {}
    Task EnsureUiShellAsync() { return Shell.Task; }
    Task InitializeBackendAsync() { return Startup.Task; }
    Task EnsureUiAsync() { UiCalls++; return Task.FromResult<object>(null); }
    void RenderStartupError(Exception error) { ErrorPages++; }
    public Task StartInitialization() { return InitializeAsync(); }
    /* MAIN_HANDLERS */
}
class SplashForm {
    public static SplashForm Last;
    public event EventHandler FormClosed;
    public Action Continuation;
    public SplashForm() { Last = this; }
    public void BeginAnimation(Action continuation) { Continuation = continuation; }
    public void Show() {}
    public void Dispose() {}
}
class StartupContext {
    readonly MainForm _mainForm;
    readonly bool _showSplash;
    SplashForm _splash;
    public MainForm MainForm;
    public StartupContext(MainForm main, bool splash) { _mainForm = main; _showSplash = splash; }
    public void InvokeStart() { Start(null, EventArgs.Empty); }
    /* STARTUP_HANDLER */
}
class Program {
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static int failures;
    static void Case(string name, Action test) { try { test(); Console.WriteLine("PASS " + name); } catch(Exception error) { failures++; Console.Error.WriteLine("FAIL " + name + ": " + error.Message); } }
    static int Main() {
        try {
            var context = new UiContext(); SynchronizationContext.SetSynchronizationContext(context);
            Case("pending cleanup hides window, taskbar and tray", () => {
            var form = new MainForm();
            form.RequestQuit();
            Check(!form.Visible, "window must be hidden while backend cleanup is pending");
            Check(!form.ShowInTaskbar, "taskbar must be hidden during cleanup");
            Check(!form._tray.Visible, "tray must be hidden during cleanup");
            Check(form.FinalCloses == 0, "must wait for cleanup before final close");
            form._backend.Pending.SetResult(null); context.Drain();
            Check(form.FinalCloses == 1, "successful cleanup must close once");
            });
            Case("repeated quit does not stop twice or dispose early", () => {
                var form = new MainForm(); form.RequestQuit(); form.RequestQuit(); form.Close();
                Check(form._backend.Stops == 1, "cleanup must run once");
                Check(!form.IsDisposed && form.FinalCloses == 0, "manual close must not dispose during cleanup");
                form._backend.Pending.SetResult(null); context.Drain();
                Check(form.FinalCloses == 1, "one final close");
            });
            Case("queued show cannot reopen quitting or disposed form", () => {
                var form = new MainForm(); form.RequestQuit(); form.HideToTray();
                context.Post(ignored => form.ShowFromTray(), null); context.Drain();
                Check(!form.Visible && !form.ShowInTaskbar, "quitting form reopened");
                form._backend.Pending.SetResult(null); context.Drain(); form.ShowFromTray();
                Check(!form.Visible && !form.ShowInTaskbar, "disposed form reopened");
            });
            Case("ordinary X still hides to tray without shutdown", () => {
                var form = new MainForm(); form.Close();
                Check(!form.Visible && !form.ShowInTaskbar && form._tray.Visible, "ordinary close visibility");
                Check(!form.IsDisposed && form._backend.Stops == 0, "ordinary close must keep backend");
                form.ShowFromTray(); Check(form.Visible && form.ShowInTaskbar, "ordinary reopen");
            });
            Case("faulted cleanup closes and exits on UI thread", () => {
                var form = new MainForm(); var uiThread = Thread.CurrentThread.ManagedThreadId; var exits = Application.Exits;
                form.RequestQuit();
                Task.Run(() => form._backend.Pending.SetException(new Exception("controlled-stop-failure"))).Wait();
                context.Drain();
                Check(form.FinalCloses == 1 && Application.Exits == exits + 1, "faulted cleanup did not finalize");
                Check(form.CloseThread == uiThread, "fault finalization must be UI-thread");
                Check(form.Logs.Exists(line => line.Contains("controlled-stop-failure")), "stop failure must be logged");
            });
            Case("successful worker completion finalizes on UI thread", () => {
                var form = new MainForm(); var uiThread = Thread.CurrentThread.ManagedThreadId;
                form.RequestQuit(); Task.Run(() => form._backend.Pending.SetResult(null)).Wait();
                context.Drain(); Check(form.FinalCloses == 1 && form.CloseThread == uiThread, "success finalization must be UI-thread");
            });
            Case("startup success cannot initialize UI after exit begins", () => {
                var form = new MainForm(); var startup = form.StartInitialization(); form.RequestQuit();
                form.Shell.SetResult(null); form.Startup.SetResult(null); context.Drain();
                Check(startup.IsCompleted && form.UiCalls == 0, "startup continuation initialized UI during exit");
                form._backend.Pending.SetResult(null); context.Drain();
            });
            Case("startup failure cannot render or display dialogs during exit", () => {
                var form = new MainForm(); var dialogs = MessageBox.Calls;
                var startup = form.StartInitialization(); form.RequestQuit();
                form.Shell.SetResult(null); form.Startup.SetException(new Exception("controlled-startup-failure")); context.Drain();
                Check(startup.IsCompleted && form.ErrorPages == 0 && MessageBox.Calls == dialogs, "startup error surfaced during exit");
                form._backend.Pending.SetResult(null); context.Drain();
            });
            Case("pending tray initialization failure is silent during exit", () => {
                var form = new MainForm(); var dialogs = MessageBox.Calls; form.ShowFromTray(); form.RequestQuit();
                form.Shell.SetException(new Exception("controlled-shell-failure")); context.Drain();
                Check(MessageBox.Calls == dialogs, "tray initialization error dialog appeared during exit");
                form._backend.Pending.SetResult(null); context.Drain();
            });
            Case("idle startup cannot show after quitting", () => {
                var form = new MainForm(); form.RequestQuit(); form.HideToTray();
                new StartupContext(form, false).InvokeStart(); Check(!form.Visible, "idle startup reopened form");
                form._backend.Pending.SetResult(null); context.Drain();
            });
            Case("queued splash continuation cannot show after quitting", () => {
                var form = new MainForm(); new StartupContext(form, true).InvokeStart();
                form.RequestQuit(); form.HideToTray(); SplashForm.Last.Continuation();
                Check(!form.Visible, "splash continuation reopened form");
                form._backend.Pending.SetResult(null); context.Drain();
            });
            Case("backend stop is single flight including disposal", () => {
                var backend = new BackendLifecycle(); var first = backend.StopAsync(); var second = backend.StopAsync();
                Check(backend.Sends == 1, "repeated StopAsync sent shutdown twice");
                backend.Shutdown.SetResult(null); Task.WaitAll(first, second);
                backend.Dispose(); Check(backend.Sends == 1, "disposal repeated shutdown");
            });
            return failures == 0 ? 0 : 1;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
