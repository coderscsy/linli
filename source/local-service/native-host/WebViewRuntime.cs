using Microsoft.Web.WebView2.Core;
using System;
using System.Diagnostics;
using System.IO;

namespace OliviaSoul
{
    internal static class WebViewRuntime
    {
        public static void EnsureInstalled()
        {
            if (IsInstalled()) return;
            var bootstrapper = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "redist", "MicrosoftEdgeWebview2Setup.exe");
            if (!File.Exists(bootstrapper))
                throw new InvalidOperationException("未检测到 WebView2 Runtime，且安装包缺少微软在线引导程序。请从 https://developer.microsoft.com/microsoft-edge/webview2/ 下载后重试。");

            using (var process = Process.Start(new ProcessStartInfo
            {
                FileName = bootstrapper,
                Arguments = "/silent /install",
                UseShellExecute = true,
            }))
            {
                process.WaitForExit();
                if (process.ExitCode != 0)
                    throw new InvalidOperationException("WebView2 Runtime 安装失败，退出码：" + process.ExitCode);
            }
            if (!IsInstalled())
                throw new InvalidOperationException("WebView2 Runtime 安装完成后仍不可用，请重启 Windows 后重试。");
        }

        private static bool IsInstalled()
        {
            try
            {
                return !string.IsNullOrWhiteSpace(CoreWebView2Environment.GetAvailableBrowserVersionString());
            }
            catch (WebView2RuntimeNotFoundException)
            {
                return false;
            }
        }
    }
}
