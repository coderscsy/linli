using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class SteamWaiterTests
{
    private static int failures;
    private static readonly string Root = Path.Combine(Environment.GetEnvironmentVariable("OLIVIA_STEAM_WAITER_TEST_ROOT") ?? Path.GetTempPath(), "waiter-test-" + Guid.NewGuid().ToString("N"));

    private static int Main()
    {
        Directory.CreateDirectory(Root);
        try
        {
            Run("early launcher exit remains alive until game exits", EarlyLauncherExitRemainsAliveUntilGameExits);
            Run("delayed child is discovered", DelayedChildIsDiscovered);
            Run("existing single instance remains the tracked process", ExistingSingleInstanceRemainsTracked);
            Run("launcher arguments round-trip", LauncherArgumentsRoundTrip);
            Run("same-name wrong-path process is not adopted", SameNameWrongPathIsNotAdopted);
            Run("CEF same-path process is not adopted", CefProcessIsNotAdopted);
            Run("ambiguous pre-existing processes fail", AmbiguousExistingProcessesFail);
            Run("launcher without resolved Olivia rejects", LauncherWithoutResolvedOliviaRejects);
            Run("hanging launcher without main stops at discovery deadline", HangingLauncherWithoutMainStopsAtDeadline);
            Run("main exit is not delayed by hanging launcher", MainExitIsNotDelayedByHangingLauncher);
            Run("relative launcher input is rejected", RelativeLauncherIsRejected);
            Run("unknown command line is not classified as main", UnknownCommandLineIsNotMain);
            Run("no child reports failure", NoChildReportsFailure);
            Run("invalid launcher is rejected", InvalidLauncherIsRejected);
        }
        finally { TryDelete(Root); }
        return failures == 0 ? 0 : 1;
    }

    private static void EarlyLauncherExitRemainsAliveUntilGameExits()
    {
        string launcher = CreateFixture();
        var waiter = StartWaiter(launcher, "0", "1200", "0", "-");
        Thread.Sleep(350);
        Assert(!waiter.HasExited, "waiter exited when launcher had already handed off to a live game");
        waiter.WaitForExit(5000);
        Assert(waiter.ExitCode == 0, "waiter did not report success after game exit");
    }

    private static void DelayedChildIsDiscovered()
    {
        string launcher = CreateFixture();
        var waiter = StartWaiter(launcher, "350", "300", "0", "-");
        waiter.WaitForExit(5000);
        Assert(waiter.HasExited && waiter.ExitCode == 0, "waiter did not discover a child emitted before launcher exit");
    }

    private static void NoChildReportsFailure()
    {
        string launcher = CreateFixture();
        var waiter = StartWaiter(launcher, "0", "0", "7", "-");
        waiter.WaitForExit(5000);
        Assert(waiter.HasExited && waiter.ExitCode != 0, "waiter accepted launcher failure with no game");
    }

    private static void ExistingSingleInstanceRemainsTracked()
    {
        string launcher = CreateFixture();
        string game = Path.Combine(Path.GetDirectoryName(launcher), "1.2.3.4", "Olivia.exe");
        Process existing = Process.Start(new ProcessStartInfo(game, "900") { UseShellExecute = false });
        Thread.Sleep(150);
        var waiter = StartWaiter(launcher, "0", "50", "7", "-");
        Thread.Sleep(250);
        Assert(!waiter.HasExited, "waiter did not retain the pre-existing matching game instance");
        waiter.WaitForExit(5000);
        Assert(waiter.ExitCode == 0, "waiter failed after the existing game process ended");
        existing.Dispose();
    }

    private static void LauncherArgumentsRoundTrip()
    {
        string launcher = CreateFixture();
        string capture = Path.Combine(Root, "arguments-" + Guid.NewGuid().ToString("N") + ".txt");
        var waiter = StartWaiter(launcher, "0", "800", "0", capture, "", "two words", "quote\"value", "tail\\", "中文");
        waiter.WaitForExit(5000);
        string[] captured = File.ReadAllLines(capture, System.Text.Encoding.UTF8);
        Assert(captured.Length == 9 && captured[4] == "" && captured[5] == "two words" && captured[6] == "quote\"value" && captured[7] == "tail\\" && captured[8] == "中文", "launcher arguments changed during forwarding");
    }

    private static void SameNameWrongPathIsNotAdopted()
    {
        string launcher = CreateFixture();
        string wrongFolder = Path.Combine(Path.GetDirectoryName(launcher), "unrelated");
        Directory.CreateDirectory(wrongFolder);
        string wrong = Path.Combine(wrongFolder, "Olivia.exe");
        File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "FakeOlivia.exe"), wrong);
        Process unrelated = Process.Start(new ProcessStartInfo(wrong, "1800") { UseShellExecute = false });
        Thread.Sleep(120);
        CoreRun waiter = StartWaiter(launcher, "0", "250", "0", "-");
        waiter.WaitForExit(5000);
        Assert(waiter.ExitCode == 0 && !unrelated.HasExited, "waiter bound a same-name process outside the resolved image path");
        unrelated.WaitForExit(5000); unrelated.Dispose(); waiter.Dispose();
    }

    private static void CefProcessIsNotAdopted()
    {
        string launcher = CreateFixture();
        string game = Path.Combine(Path.GetDirectoryName(launcher), "1.2.3.4", "Olivia.exe");
        Process cef = Process.Start(new ProcessStartInfo(game, "--type=renderer") { UseShellExecute = false });
        Thread.Sleep(150);
        CoreRun waiter = StartWaiter(launcher, "0", "0", "7", "-");
        waiter.WaitForExit(5000);
        Assert(waiter.ExitCode != 0, "waiter adopted an exact-path CEF subprocess");
        cef.WaitForExit(5000); cef.Dispose(); waiter.Dispose();
    }

    private static void AmbiguousExistingProcessesFail()
    {
        string launcher = CreateFixture();
        string game = Path.Combine(Path.GetDirectoryName(launcher), "1.2.3.4", "Olivia.exe");
        Process one = Process.Start(new ProcessStartInfo(game, "800") { UseShellExecute = false });
        Process two = Process.Start(new ProcessStartInfo(game, "800") { UseShellExecute = false });
        Thread.Sleep(150);
        CoreRun waiter = StartWaiter(launcher, "0", "0", "0", "-");
        waiter.WaitForExit(5000);
        Assert(waiter.ExitCode != 0, "waiter selected one of multiple existing matching processes");
        one.WaitForExit(5000); two.WaitForExit(5000); one.Dispose(); two.Dispose(); waiter.Dispose();
    }

    private static void LauncherWithoutResolvedOliviaRejects()
    {
        string launcher = CreateFixture();
        File.Delete(Path.Combine(Path.GetDirectoryName(launcher), "1.2.3.4", "Olivia.exe"));
        CoreRun waiter = StartWaiter(launcher, "0", "0", "0", "-");
        waiter.WaitForExit(5000);
        Assert(waiter.ExitCode != 0, "launcher was accepted without its numeric-version Olivia path");
        waiter.Dispose();
    }

    private static void InvalidLauncherIsRejected()
    {
        var waiter = StartWaiter(Path.Combine(Root, "missing.exe"));
        waiter.WaitForExit(5000);
        Assert(waiter.HasExited && waiter.ExitCode != 0, "missing launcher was accepted");
    }

    private static void HangingLauncherWithoutMainStopsAtDeadline()
    {
        string launcher = CreateFixture();
        CoreRun waiter = StartWaiter(300, launcher, "0", "0", "-1", "-");
        waiter.WaitForExit(2000);
        Assert(waiter.ExitCode != 0, "hanging launcher without a main process exceeded the bounded discovery wait");
    }

    private static void MainExitIsNotDelayedByHangingLauncher()
    {
        string launcher = CreateFixture();
        DateTime started = DateTime.UtcNow;
        CoreRun waiter = StartWaiter(500, launcher, "0", "1000", "-2", "-");
        waiter.WaitForExit(1800);
        Assert(waiter.ExitCode == 0 && (DateTime.UtcNow - started).TotalMilliseconds < 1800, "waiter waited for a hanging launcher after the selected main exited");
    }

    private static void RelativeLauncherIsRejected()
    {
        CoreRun waiter = StartWaiter("C:launcher.exe");
        waiter.WaitForExit(5000);
        Assert(waiter.ExitCode != 0, "drive-relative launcher input was accepted");
    }

    private static void UnknownCommandLineIsNotMain()
    {
        Assert(WaiterCore.ClassifyCommandLine(null) == WaiterCore.CandidateKind.Unknown, "missing command line was classified as a main process");
        Assert(WaiterCore.ClassifyCommandLine("--type=renderer") == WaiterCore.CandidateKind.Cef, "CEF command line was classified as main");
    }

    private static string CreateFixture()
    {
        string fixture = Path.Combine(Root, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(fixture);
        Directory.CreateDirectory(Path.Combine(fixture, "1.2.3.4"));
        File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "FakeLauncher.exe"), Path.Combine(fixture, "launcher.exe"));
        File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "FakeOlivia.exe"), Path.Combine(fixture, "1.2.3.4", "Olivia.exe"));
        return Path.Combine(fixture, "launcher.exe");
    }

    private static CoreRun StartWaiter(params string[] args)
    {
        return new CoreRun(args);
    }
    private static CoreRun StartWaiter(int discoveryMilliseconds, params string[] args)
    {
        return new CoreRun(args, discoveryMilliseconds);
    }

    private static string Quote(string[] values)
    {
        var result = new System.Text.StringBuilder();
        foreach (string value in values)
        {
            if (result.Length != 0) result.Append(' ');
            result.Append('"'); int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); result.Append('"');
        }
        return result.ToString();
    }
    private static void Run(string name, Action test) { try { test(); Console.WriteLine("PASS " + name); } catch (Exception ex) { failures++; Console.WriteLine("FAIL " + name + ": " + ex.Message); } }
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static void TryDelete(string path) { try { Directory.Delete(path, true); } catch { } }
}

internal sealed class CoreRun
{
    private readonly Thread thread;
    internal int ExitCode;
    internal bool HasExited { get { return !thread.IsAlive; } }
    internal CoreRun(string[] arguments)
        : this(arguments, 30000) { }
    internal CoreRun(string[] arguments, int discoveryMilliseconds)
    {
        ExitCode = Int32.MinValue;
        thread = new Thread(delegate() { string error; ExitCode = WaiterCore.Run(arguments, out error, discoveryMilliseconds); });
        thread.Start();
    }
    internal void WaitForExit(int milliseconds) { if (!thread.Join(milliseconds)) throw new Exception("waiter test thread did not complete within timeout"); }
    internal void Dispose() { }
}
