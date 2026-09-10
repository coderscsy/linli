using System;
using System.Collections.Generic;
using System.Windows.Forms;

namespace OliviaSoul
{
    public sealed class LyricsPresenter : IDisposable
    {
        private readonly Form _owner;
        private readonly NodeBackend _backend;
        private readonly Action<Dictionary<string, object>> _publish;
        private readonly Timer _expiry = new Timer { Interval = 3500 };
        private LyricsOverlayForm _overlay;
        private string _instance;
        private long _sequence;
        private bool _disposed;
        private long _operation;
        private bool? _desiredEnabled;
        private Dictionary<string, object> _lastSettings;
        private Dictionary<string, object> _currentFrame;
        private bool _playbackBusy;
        private readonly object _frameLock = new object();
        private Dictionary<string, object> _pendingFrame;
        private bool _dispatchQueued;
        public event Action SettingsRequested;
        public ToolStripMenuItem EnabledItem { get; } = new ToolStripMenuItem("启用歌词") { CheckOnClick = true };
        public ToolStripMenuItem LockedItem { get; } = new ToolStripMenuItem("锁定歌词位置 / 鼠标穿透") { CheckOnClick = true };
        public LyricsPresenter(Form owner, NodeBackend backend, Action<Dictionary<string, object>> publish)
        {
            _owner = owner; _backend = backend; _publish = publish;
            _backend.LyricsFrame += Receive;
            EnabledItem.Click += delegate { Change("enabled", EnabledItem.Checked); };
            LockedItem.Click += delegate { Change("locked", LockedItem.Checked); };
            _expiry.Tick += delegate { Hide(false); };
        }
        public async void Initialize()
        {
            if (_disposed || _owner.IsDisposed) return;
            try
            {
                // Hidden-at-startup still needs a handle for the initial settings push.
                var handle = _owner.Handle;
                await _backend.SendAsync("getLyrics");
            }
            catch { if (!_disposed) Hide(false); }
        }
        private async void Change(string key, object value)
        {
            if (_disposed) return;
            var operation = ++_operation;
            if (key == "enabled") { _desiredEnabled = (bool)value; if (!(bool)value) Hide(true); }
            try { await _backend.SendAsync("setLyrics", new Dictionary<string, object> { { key, value } }); }
            catch { if (!_disposed) Hide(false); }
            finally
            {
                if (!_disposed && operation == _operation) { _desiredEnabled = null; Initialize(); }
            }
        }
        private void Receive(Dictionary<string, object> frame)
        {
            if (_disposed || frame == null || _owner.IsDisposed || !_owner.IsHandleCreated) return;
            lock (_frameLock)
            {
                _pendingFrame = frame;
                if (_dispatchQueued) return;
                _dispatchQueued = true;
            }
            try { _owner.BeginInvoke((Action)(() => {
                Dictionary<string, object> latest;
                lock (_frameLock) { latest = _pendingFrame; _pendingFrame = null; _dispatchQueued = false; }
                if (latest != null) Apply(latest);
            })); } catch (InvalidOperationException) { lock (_frameLock) { _pendingFrame = null; _dispatchQueued = false; } }
        }
        private void Apply(Dictionary<string, object> frame)
        {
            if (_disposed) return;
            try
            {
                string instance = Convert.ToString(frame["instance"]);
                long sequence = Convert.ToInt64(frame["sequence"]);
                if (instance == _instance && sequence <= _sequence) return;
                _instance = instance; _sequence = sequence;
                var previous = _currentFrame; _currentFrame = frame;
                var settings = (Dictionary<string, object>)frame["settings"];
                bool enabled = Convert.ToBoolean(settings["enabled"]), locked = Convert.ToBoolean(settings["locked"]);
                if (_desiredEnabled.HasValue && enabled != _desiredEnabled.Value) return;
                EnabledItem.Checked = enabled; LockedItem.Checked = locked;
                _publish(new Dictionary<string, object> { { "type", "lyrics-settings" }, { "data", new Dictionary<string, object> { { "settings", settings }, { "status", frame["status"] } } } });
                if (!enabled) { _lastSettings = null; Hide(true); return; }
                if (!Convert.ToBoolean(frame["visible"])) { Hide(false); return; }
                if (_overlay == null)
                {
                    _overlay = new LyricsOverlayForm();
                    _overlay.PositionSaved += SavePosition;
                    _overlay.FontSizeChanged += size => Change("fontSize", size);
                    _overlay.SettingChanged += Change;
                    _overlay.OffsetChanged += AdjustOffset;
                    _overlay.SettingsRequested += () => SettingsRequested?.Invoke();
                    _overlay.PlaybackRequested += Playback;
                    _lastSettings = null;
                }
                if (_lastSettings == null || !Equal(_lastSettings, settings))
                {
                    _overlay.Appearance(settings);
                    _overlay.Configure(Convert.ToInt32(settings["fontSize"]), locked, Number(settings["x"]), Number(settings["y"]));
                    _lastSettings = settings;
                }
                foreach (var key in new[] { "songId", "sessionId", "mediaUrl" }) {
                    object a, b;
                    if (previous != null && previous.TryGetValue(key, out a) && frame.TryGetValue(key, out b) && !object.Equals(a, b)) _overlay.Clear();
                }
                object offset; if (frame.TryGetValue("offsetMs", out offset)) _overlay.Offset(Convert.ToInt32(offset));
                _overlay.Display(Convert.ToString(frame["current"]), Convert.ToString(frame["next"]));
                object playbackState; frame.TryGetValue("playbackState", out playbackState);
                _overlay.Playback(Convert.ToString(playbackState) == "paused", _playbackBusy);
                _expiry.Stop(); _expiry.Start();
            }
            catch { Hide(true); }
        }
        private static int? Number(object value) { return value == null ? (int?)null : Convert.ToInt32(value); }
        private static bool Equal(Dictionary<string, object> a, Dictionary<string, object> b)
        {
            foreach (var key in new[] { "fontSize", "locked", "x", "y", "fontFamily", "fontWeight", "opacity", "lineMode", "orientation", "currentColor", "nextColor", "animate" }) {
                object av, bv; a.TryGetValue(key, out av); b.TryGetValue(key, out bv); if (!object.Equals(av, bv)) return false;
            }
            return true;
        }
        private async void AdjustOffset(int delta, bool reset) {
            if (_disposed || _currentFrame == null) return;
            var target = _overlay;
            var request = new Dictionary<string, object>();
            foreach (var key in new[] { "songId", "sessionId", "mediaUrl", "variant", "controlEpoch" }) {
                object value; if (!_currentFrame.TryGetValue(key, out value)) return; request[key] = value;
            }
            request["deltaMs"] = delta; request["reset"] = reset;
            try { await _backend.SendAsync("adjustLyricsOffset", request); }
            catch { if (!_disposed && target != null && target == _overlay && !target.IsDisposed) target.OffsetError(); }
        }
        private async void SavePosition(int x, int y)
        {
            try { await _backend.SendAsync("setLyrics", new Dictionary<string, object> { { "x", x }, { "y", y } }); } catch { }
        }
        private async void Playback(string action) {
            if (_disposed || _playbackBusy || _currentFrame == null || _overlay == null) return;
            var target = _overlay; var frame = _currentFrame;
            object state; frame.TryGetValue("playbackState", out state);
            bool paused = Convert.ToString(state) == "paused";
            _playbackBusy = true; target.Playback(paused, true);
            string error = null;
            try { await _backend.SendAsync("lyricsPlayerControl", new Dictionary<string, object> {
                { "action", action }, { "songId", frame["songId"] }, { "sessionId", frame["sessionId"] }
            }); } catch { error = "播放操作失败，请确认游戏已打开并更新客户端补丁"; }
            finally {
                _playbackBusy = false;
                if (!_disposed && _overlay == target && !target.IsDisposed) {
                    object current; _currentFrame.TryGetValue("playbackState", out current);
                    target.Playback(Convert.ToString(current) == "paused", false, error);
                }
            }
        }
        private void Hide(bool release)
        {
            _expiry.Stop();
            if (_overlay == null) return;
            _overlay.Clear();
            if (release) { _overlay.Dispose(); _overlay = null; _lastSettings = null; }
        }
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true; _operation++; _backend.LyricsFrame -= Receive;
            lock (_frameLock) { _pendingFrame = null; }
            Hide(true); _expiry.Dispose();
        }
    }
}
