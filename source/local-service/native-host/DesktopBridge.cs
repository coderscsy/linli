using Microsoft.Web.WebView2.Core;
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OliviaSoul
{
    public sealed class DesktopBridge
    {
        private readonly MainForm _form;
        private readonly NodeBackend _backend;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private CoreWebView2 _webView;

        public DesktopBridge(MainForm form, NodeBackend backend)
        {
            _form = form;
            _backend = backend;
        }

        public async Task AttachAsync(CoreWebView2 webView)
        {
            _webView = webView;
            _webView.WebMessageReceived += OnMessage;
            await _webView.AddScriptToExecuteOnDocumentCreatedAsync(@"
(() => {
  const pending = new Map();
  chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'olivia-response') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.data);
    else request.reject(new Error(message.error || '桌面操作失败'));
  });
  const invoke = (method, args) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pending.set(id, { resolve, reject });
    chrome.webview.postMessage({ type: 'olivia-command', id, method, args });
  });
  window.oliviaDesktop = {
    getSettings: () => invoke('getSettings', []),
    setAutoStart: enabled => invoke('setAutoStart', [enabled]),
    selectClient: () => invoke('selectClient', []),
    selectMediaFile: () => invoke('selectMediaFile', []),
    getClientStatus: () => invoke('getClientStatus', []),
    mountClient: port => invoke('mountClient', [port]),
    restoreClient: () => invoke('restoreClient', []),
    exportSoul: () => invoke('exportSoul', []),
    exportRemoteSoul: jobId => invoke('exportRemoteSoul', [jobId]),
    hideToTray: () => invoke('hideToTray', [])
  };
})();");
        }

        private async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            string id = "";
            try
            {
                var message = _json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson);
                if (Convert.ToString(message["type"]) != "olivia-command") return;
                id = Convert.ToString(message["id"]);
                var method = Convert.ToString(message["method"]);
                var values = message.ContainsKey("args") ? message["args"] as ArrayList : new ArrayList();
                object result;
                switch (method)
                {
                    case "hideToTray":
                        _form.HideToTray();
                        result = new Dictionary<string, object>();
                        break;
                    case "selectClient":
                        result = await SelectClientAsync();
                        break;
                    case "selectMediaFile":
                        result = SelectMediaFile();
                        break;
                    case "exportSoul":
                        result = await ExportSoulAsync();
                        break;
                    case "exportRemoteSoul":
                        result = await ExportRemoteSoulAsync(values != null && values.Count > 0 ? Convert.ToString(values[0]) : "");
                        break;
                    case "getSettings":
                    case "getClientStatus":
                    case "restoreClient":
                        result = await _backend.SendAsync(method);
                        break;
                    case "setAutoStart":
                    case "mountClient":
                        result = await _backend.SendAsync(method, values != null && values.Count > 0 ? values[0] : null);
                        break;
                    default:
                        throw new InvalidOperationException("不支持的桌面命令：" + method);
                }
                Respond(id, true, result, null);
            }
            catch (Exception error)
            {
                Respond(id, false, null, error.Message);
            }
        }

        private async Task<object> SelectClientAsync()
        {
            using (var picker = new OpenFileDialog
            {
                Title = "选择游戏客户端",
                Filter = "Windows 可执行文件 (*.exe)|*.exe",
                CheckFileExists = true,
                Multiselect = false,
            })
            {
                if (picker.ShowDialog(_form) != DialogResult.OK)
                    return await _backend.SendAsync("getClientStatus");
                return await _backend.SendAsync("setClient", picker.FileName);
            }
        }

        private async Task<object> ExportSoulAsync()
        {
            await _backend.SendAsync("assertSoulExport");
            using (var picker = new SaveFileDialog
            {
                Title = "导出 Olivia Soul 记忆",
                Filter = "Olivia Soul 记忆 (*.soul)|*.soul",
                DefaultExt = "soul",
                AddExtension = true,
                FileName = "OliviaSoul-memory-" + DateTime.Now.ToString("yyyy-MM-dd") + ".soul",
                OverwritePrompt = true,
            })
            {
                if (picker.ShowDialog(_form) != DialogResult.OK)
                    return new Dictionary<string, object> { { "cancelled", true } };
                return await _backend.SendAsync("exportSoul", picker.FileName);
            }
        }

        private object SelectMediaFile()
        {
            using (var picker = new OpenFileDialog
            {
                Title = "选择要转写的视频或音频",
                Filter = "媒体文件|*.mp4;*.mkv;*.mov;*.webm;*.avi;*.wav;*.mp3;*.m4a;*.flac;*.ogg|所有文件 (*.*)|*.*",
                CheckFileExists = true,
                Multiselect = false,
            })
            {
                if (picker.ShowDialog(_form) != DialogResult.OK)
                    return new Dictionary<string, object> { { "cancelled", true } };
                return new Dictionary<string, object> {
                    { "cancelled", false },
                    { "path", picker.FileName },
                    { "name", Path.GetFileName(picker.FileName) },
                };
            }
        }

        private async Task<object> ExportRemoteSoulAsync(string jobId)
        {
            await _backend.SendAsync("assertRemoteSoulExport", jobId);
            using (var picker = new SaveFileDialog
            {
                Title = "导出远端 Olivia Soul 记忆",
                Filter = "Olivia Soul 记忆 (*.soul)|*.soul",
                DefaultExt = "soul",
                AddExtension = true,
                FileName = "OliviaSoul-remote-" + DateTime.Now.ToString("yyyy-MM-dd") + ".soul",
                OverwritePrompt = true,
            })
            {
                if (picker.ShowDialog(_form) != DialogResult.OK)
                    return new Dictionary<string, object> { { "cancelled", true } };
                return await _backend.SendAsync("exportRemoteSoul", jobId, picker.FileName);
            }
        }

        private void Respond(string id, bool ok, object data, string error)
        {
            if (_webView == null || _form.IsDisposed) return;
            var payload = _json.Serialize(new Dictionary<string, object>
            {
                { "type", "olivia-response" },
                { "id", id },
                { "ok", ok },
                { "data", data },
                { "error", error },
            });
            if (_form.InvokeRequired) _form.BeginInvoke((Action)(() => _webView.PostWebMessageAsJson(payload)));
            else _webView.PostWebMessageAsJson(payload);
        }
    }
}
