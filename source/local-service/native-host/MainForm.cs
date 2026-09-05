using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OliviaSoul
{
    public sealed class MainForm : Form
    {
        private const int WmNcLButtonDown = 0x00A1;
        private const int WmNcHitTest = 0x0084;
        private const int HtCaption = 2;
        private const int HtLeft = 10;
        private const int HtRight = 11;
        private const int HtTop = 12;
        private const int HtTopLeft = 13;
        private const int HtTopRight = 14;
        private const int HtBottom = 15;
        private const int HtBottomLeft = 16;
        private const int HtBottomRight = 17;

        private readonly bool _hiddenAtLaunch;
        private readonly AppPaths _paths;
        private readonly NodeBackend _backend;
        private readonly object _runtimeLogLock = new object();
        private readonly Stopwatch _startupClock = Stopwatch.StartNew();
        private readonly WebView2 _webView;
        private readonly NotifyIcon _tray;
        private readonly ToolStripMenuItem _autoStartItem;
        private readonly WindowControlButton _maximizeButton;
        private DesktopBridge _bridge;
        private Task _startupInitialization;
        private Task _uiShellInitialization;
        private Task _uiInitialization;
        private bool _backendReady;
        private bool _quitting;
        private bool _shutdownComplete;
        private bool _trayNoticeShown;
        private string _adminOrigin;

        public bool IsQuitting { get { return _quitting; } }

        public MainForm(bool hiddenAtLaunch)
        {
            _hiddenAtLaunch = hiddenAtLaunch;
            _paths = AppPaths.Detect();
            _backend = new NodeBackend(_paths);
            _backend.PortChanged += NavigateToPort;
            _backend.Log += WriteRuntimeLog;
            WriteRuntimeLog("desktop constructed hidden=" + hiddenAtLaunch);

            Text = "Olivia Soul";
            var workingArea = Screen.PrimaryScreen.WorkingArea;
            Width = Math.Min(1120, Math.Max(820, workingArea.Width - 160));
            Height = Math.Min(720, Math.Max(620, workingArea.Height - 160));
            MinimumSize = new Size(820, 620);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Color.FromArgb(61, 65, 72);
            FormBorderStyle = FormBorderStyle.None;
            Padding = new Padding(1);
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            if (_hiddenAtLaunch)
            {
                Opacity = 0;
                ShowInTaskbar = false;
            }

            _webView = new WebView2
            {
                Dock = DockStyle.Fill,
                Margin = Padding.Empty,
                DefaultBackgroundColor = Color.FromArgb(15, 16, 19),
                CreationProperties = new CoreWebView2CreationProperties
                {
                    UserDataFolder = System.IO.Path.Combine(_paths.UserData, "WebView2"),
                },
            };

            var titleBar = new Panel
            {
                Dock = DockStyle.Fill,
                Margin = Padding.Empty,
                BackColor = Color.FromArgb(15, 16, 19),
            };
            var windowButtons = new TableLayoutPanel
            {
                ColumnCount = 3,
                Dock = DockStyle.Right,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
                RowCount = 1,
                Width = 126,
            };
            windowButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 42));
            windowButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 42));
            windowButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 42));
            windowButtons.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var minimizeButton = new WindowControlButton(WindowControlKind.Minimize);
            _maximizeButton = new WindowControlButton(WindowControlKind.Maximize);
            var closeButton = new WindowControlButton(WindowControlKind.Close);
            minimizeButton.Click += delegate { WindowState = FormWindowState.Minimized; };
            _maximizeButton.Click += delegate { ToggleMaximize(); };
            closeButton.Click += delegate { Close(); };
            windowButtons.Controls.Add(minimizeButton, 0, 0);
            windowButtons.Controls.Add(_maximizeButton, 1, 0);
            windowButtons.Controls.Add(closeButton, 2, 0);
            titleBar.Controls.Add(windowButtons);
            titleBar.MouseDown += DragWindow;
            titleBar.DoubleClick += delegate { ToggleMaximize(); };
            var windowLayout = new TableLayoutPanel
            {
                ColumnCount = 1,
                Dock = DockStyle.Fill,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
                RowCount = 2,
            };
            windowLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            windowLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            windowLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            windowLayout.BackColor = Color.FromArgb(15, 16, 19);
            windowLayout.Controls.Add(titleBar, 0, 0);
            windowLayout.Controls.Add(_webView, 0, 1);
            Controls.Add(windowLayout);

            _autoStartItem = new ToolStripMenuItem("开机自动启动") { CheckOnClick = true };
            _autoStartItem.Click += async delegate { await SetAutoStartAsync(_autoStartItem.Checked); };
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开管理窗口", null, delegate { ShowFromTray(); });
            menu.Items.Add(_autoStartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { RequestQuit(); });
            _tray = new NotifyIcon
            {
                Icon = Icon,
                Text = "Olivia Soul",
                Visible = true,
                ContextMenuStrip = menu,
            };
            _tray.MouseClick += delegate(object sender, MouseEventArgs args)
            {
                if (args.Button != MouseButtons.Left) return;
                ShowFromTray();
            };

            Load += async delegate
            {
                _startupInitialization = InitializeAsync();
                await _startupInitialization;
            };
            FormClosing += OnFormClosing;
            SizeChanged += delegate
            {
                _maximizeButton.IsRestore = WindowState == FormWindowState.Maximized;
            };
        }

        private void DragWindow(object sender, MouseEventArgs args)
        {
            if (args.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
        }

        private void ToggleMaximize()
        {
            if (WindowState == FormWindowState.Maximized)
            {
                WindowState = FormWindowState.Normal;
                return;
            }
            MaximizedBounds = Screen.FromControl(this).WorkingArea;
            WindowState = FormWindowState.Maximized;
        }

        private async Task InitializeAsync()
        {
            if (_quitting || IsDisposed) return;
            var uiTask = EnsureUiShellAsync();
            var backendTask = InitializeBackendAsync();
            try
            {
                await uiTask;
                await backendTask;
                if (_quitting || IsDisposed) return;
                if (_hiddenAtLaunch)
                {
                    BeginInvoke((Action)HideToTray);
                    return;
                }
                await EnsureUiAsync();
                if (_quitting || IsDisposed) return;
                LogStartupStage("admin-visible");
            }
            catch (Exception error)
            {
                if (_quitting || IsDisposed) return;
                WriteRuntimeLog("desktop initialization failed " + error);
                File.WriteAllText(Path.Combine(_paths.UserData, "host-error.log"), error.ToString());
                try
                {
                    await uiTask;
                    if (_quitting || IsDisposed) return;
                    RenderStartupError(error);
                }
                catch (Exception uiError)
                {
                    if (_quitting || IsDisposed) return;
                    WriteRuntimeLog("startup error page failed " + uiError);
                    if (!_hiddenAtLaunch)
                        MessageBox.Show(error.Message, "Olivia Soul 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private async Task InitializeBackendAsync()
        {
            if (_quitting || IsDisposed) return;
            await _backend.StartAsync();
            if (_quitting || IsDisposed) return;
            _backendReady = true;
            LogStartupStage("backend-ready");
            WriteRuntimeLog("desktop backend ready port=" + _backend.Port.ToString(CultureInfo.InvariantCulture));
            await RefreshAutoStartAsync();
        }

        private Task EnsureUiShellAsync()
        {
            if (_uiShellInitialization == null) _uiShellInitialization = InitializeUiShellAsync();
            return _uiShellInitialization;
        }

        private async Task InitializeUiShellAsync()
        {
            if (_quitting || IsDisposed) return;
            await _webView.EnsureCoreWebView2Async();
            if (_quitting || IsDisposed) return;
            _webView.CoreWebView2.ContextMenuRequested += delegate(object sender, CoreWebView2ContextMenuRequestedEventArgs args)
            {
                args.Handled = !args.ContextMenuTarget.IsEditable;
            };
            _webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
            {
                args.Handled = true;
                if (Uri.IsWellFormedUriString(args.Uri, UriKind.Absolute))
                    Process.Start(new ProcessStartInfo(args.Uri) { UseShellExecute = true });
            };
            _webView.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args)
            {
                if (_adminOrigin != null && !args.Uri.StartsWith(_adminOrigin, StringComparison.OrdinalIgnoreCase))
                    args.Cancel = true;
            };
            _webView.CoreWebView2.NavigateToString(BuildLoadingDocument());
            LogStartupStage("ui-shell-ready");
        }

        private Task EnsureUiAsync()
        {
            if (_uiInitialization == null) _uiInitialization = InitializeUiAsync();
            return _uiInitialization;
        }

        private async Task InitializeUiAsync()
        {
            if (_quitting || IsDisposed) return;
            await EnsureUiShellAsync();
            if (_quitting || IsDisposed) return;
            if (_bridge == null)
            {
                _bridge = new DesktopBridge(this, _backend);
                await _bridge.AttachAsync(_webView.CoreWebView2);
            }
            if (_quitting || IsDisposed) return;
            NavigateToPort(_backend.Port);
        }

        private static string BuildLoadingDocument()
        {
            return "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
                "<style>html,body{height:100%;margin:0;background:#111114;color:#eeeae4;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif}" +
                "body{display:grid;place-items:center}.box{text-align:center}.mark{font-size:28px;letter-spacing:.08em}" +
                ".line{width:220px;height:2px;margin:22px auto;background:#2f3035;overflow:hidden}.line:after{display:block;width:45%;height:100%;background:#d9d2c8;content:'';animation:move 1.2s infinite ease-in-out}" +
                "p{color:#85858b;font-size:13px}@keyframes move{from{transform:translateX(-110%)}to{transform:translateX(330%)}}</style>" +
                "<body><div class='box'><div class='mark'>OLIVIA SOUL</div><div class='line'></div><p>正在启动本地服务，请稍候……</p></div></body>";
        }

        private void RenderStartupError(Exception error)
        {
            if (_quitting || IsDisposed) return;
            if (_webView.CoreWebView2 == null) return;
            var message = WebUtility.HtmlEncode(error == null ? "未知错误" : error.Message);
            _webView.CoreWebView2.NavigateToString(
                "<!doctype html><meta charset='utf-8'><style>html,body{height:100%;margin:0;background:#111114;color:#eeeae4;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif}" +
                "body{display:grid;place-items:center}.box{max-width:620px;padding:36px}h1{font-size:22px}p{color:#c9a4a4;line-height:1.7;overflow-wrap:anywhere}</style>" +
                "<body><div class='box'><h1>本地服务启动失败</h1><p>" + message + "</p><p>窗口会继续保留，请检查日志后重新启动。</p></div></body>");
            LogStartupStage("error-visible");
        }

        private void LogStartupStage(string stage)
        {
            WriteRuntimeLog("startup-stage=" + stage + " elapsedMs=" +
                _startupClock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));
        }

        private async Task RefreshAutoStartAsync()
        {
            var result = await _backend.SendAsync("getSettings");
            if (_quitting || IsDisposed) return;
            var settings = result as IDictionary<string, object>;
            if (settings != null && settings.ContainsKey("autoStart"))
                _autoStartItem.Checked = Convert.ToBoolean(settings["autoStart"], CultureInfo.InvariantCulture);
        }

        private async Task SetAutoStartAsync(bool enabled)
        {
            try
            {
                var result = await _backend.SendAsync("setAutoStart", enabled);
                var settings = result as IDictionary<string, object>;
                _autoStartItem.Checked = settings != null && settings.ContainsKey("autoStart") &&
                    Convert.ToBoolean(settings["autoStart"], CultureInfo.InvariantCulture);
            }
            catch (Exception error)
            {
                _autoStartItem.Checked = !enabled;
                MessageBox.Show(error.Message, "开机自启设置失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void NavigateToPort(int port)
        {
            if (_quitting || IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke((Action)(() => NavigateToPort(port)));
                return;
            }
            _adminOrigin = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture);
            if (_webView.CoreWebView2 != null) _webView.CoreWebView2.Navigate(_adminOrigin + "/admin");
        }

        private void OnFormClosing(object sender, FormClosingEventArgs args)
        {
            if (_quitting)
            {
                args.Cancel = !_shutdownComplete;
                return;
            }
            args.Cancel = true;
            HideToTray();
            if (_trayNoticeShown) return;
            _tray.ShowBalloonTip(3000, "Olivia Soul", "应用仍在托盘运行，信件服务不会中断。", ToolTipIcon.Info);
            _trayNoticeShown = true;
        }

        public void HideToTray()
        {
            if (IsDisposed) return;
            Hide();
            ShowInTaskbar = false;
        }

        public void ShowFromTray()
        {
            if (_quitting || IsDisposed) return;
            Opacity = 1;
            ShowInTaskbar = true;
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
            _ = FinishShowFromTrayAsync();
        }

        private async Task FinishShowFromTrayAsync()
        {
            if (_quitting || IsDisposed) return;
            try
            {
                if (_backendReady) await EnsureUiAsync();
                else await EnsureUiShellAsync();
            }
            catch (Exception error)
            {
                if (_quitting || IsDisposed) return;
                WriteRuntimeLog("tray window initialization failed " + error);
                MessageBox.Show(error.Message, "Olivia Soul 窗口打开失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        public async void RequestQuit()
        {
            if (_quitting || IsDisposed) return;
            _quitting = true;
            HideToTray();
            WriteRuntimeLog("desktop quit requested");
            _tray.Visible = false;
            try
            {
                await _backend.StopAsync();
                WriteRuntimeLog("desktop backend stopped");
            }
            catch (Exception error)
            {
                WriteRuntimeLog("desktop backend stop failed " + error);
            }
            finally
            {
                _shutdownComplete = true;
                try { if (!IsDisposed) Close(); }
                finally { Application.Exit(); }
            }
        }

        private void WriteRuntimeLog(string message)
        {
            Debug.WriteLine(message);
            try
            {
                var path = Path.Combine(_paths.UserData, "runtime.log");
                var previousPath = Path.Combine(_paths.UserData, "runtime.previous.log");
                lock (_runtimeLogLock)
                {
                    Directory.CreateDirectory(_paths.UserData);
                    if (File.Exists(path) && new FileInfo(path).Length > 4 * 1024 * 1024)
                    {
                        if (File.Exists(previousPath)) File.Delete(previousPath);
                        File.Move(path, previousPath);
                    }
                    File.AppendAllText(
                        path,
                        DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture) +
                        " desktop=" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) +
                        " " + message + Environment.NewLine,
                        Encoding.UTF8);
                }
            }
            catch (Exception error)
            {
                Debug.WriteLine("runtime log failed: " + error.Message);
            }
        }

        protected override void OnHandleCreated(EventArgs args)
        {
            base.OnHandleCreated(args);
            var enabled = 1;
            var rounded = 2;
            var borderColor = ColorTranslator.ToWin32(Color.FromArgb(61, 65, 72));
            DwmSetWindowAttribute(Handle, 20, ref enabled, sizeof(int));
            DwmSetWindowAttribute(Handle, 33, ref rounded, sizeof(int));
            DwmSetWindowAttribute(Handle, 34, ref borderColor, sizeof(int));
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                parameters.ClassStyle |= 0x00020000;
                return parameters;
            }
        }

        protected override void WndProc(ref Message message)
        {
            base.WndProc(ref message);
            if (message.Msg != WmNcHitTest || (int)message.Result != 1 || WindowState != FormWindowState.Normal) return;

            var value = message.LParam.ToInt64();
            var point = PointToClient(new Point((short)(value & 0xffff), (short)((value >> 16) & 0xffff)));
            var border = (int)Math.Round(10 * CurrentAutoScaleDimensions.Width / 96f);
            var left = point.X < border;
            var right = point.X >= ClientSize.Width - border;
            var top = point.Y < border;
            var bottom = point.Y >= ClientSize.Height - border;
            if (left && top) message.Result = (IntPtr)HtTopLeft;
            else if (right && top) message.Result = (IntPtr)HtTopRight;
            else if (left && bottom) message.Result = (IntPtr)HtBottomLeft;
            else if (right && bottom) message.Result = (IntPtr)HtBottomRight;
            else if (left) message.Result = (IntPtr)HtLeft;
            else if (right) message.Result = (IntPtr)HtRight;
            else if (top) message.Result = (IntPtr)HtTop;
            else if (bottom) message.Result = (IntPtr)HtBottom;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _tray.Dispose();
                _webView.Dispose();
                _backend.Dispose();
            }
            base.Dispose(disposing);
        }

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wordParameter, IntPtr longParameter);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int valueSize);
    }
}
