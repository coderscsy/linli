using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using OliviaSoul;

// Only Node IPC is replaced; production presenter and native window run unchanged.
namespace OliviaSoul {
    public sealed class NodeBackend {
        public event Action<Dictionary<string, object>> LyricsFrame;
        public Task<object> SendAsync(string name, Dictionary<string, object> data = null) { return Task.FromResult<object>(null); }
        public void Emit(Dictionary<string, object> frame) { LyricsFrame?.Invoke(frame); }
        public int Subscribers { get { return LyricsFrame == null ? 0 : LyricsFrame.GetInvocationList().Length; } }
    }
}
class Harness {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    static long sequence;
    static Dictionary<string, object> Frame(bool enabled, bool visible, bool locked = false, string current = "Current") {
        return new Dictionary<string, object> {
            { "instance", "isolated" }, { "sequence", ++sequence }, { "generation", sequence },
            { "visible", visible }, { "status", "test" }, { "current", current }, { "next", "Next" },
            { "settings", new Dictionary<string, object> { { "enabled", enabled }, { "locked", locked }, { "fontSize", 28 }, { "x", 99999 }, { "y", -99999 } } }
        };
    }
    static void Check(bool ok, string reason) { if (!ok) throw new Exception(reason); }
    static LyricsOverlayForm Overlay() { return Application.OpenForms.Cast<Form>().OfType<LyricsOverlayForm>().SingleOrDefault(); }
    static void Pump() { Application.DoEvents(); }
    [STAThread] static int Main() {
        try {
            using (var owner = new Form()) {
                var handle = owner.Handle;
                var backend = new NodeBackend();
                var presenter = new LyricsPresenter(owner, backend, frame => {});
                Check(backend.Subscribers == 1, "single subscription");
                backend.Emit(Frame(false, false)); Pump(); Check(Overlay() == null, "default must not create overlay");
                var foreground = GetForegroundWindow();
                backend.Emit(Frame(true, true)); Pump(); var overlay = Overlay();
                Check(overlay != null && overlay.Visible && overlay.TopMost && !overlay.ShowInTaskbar, "native two-line window visible");
                Check(GetForegroundWindow() == foreground, "overlay stole focus");
                Check(Screen.AllScreens.Any(s => s.WorkingArea.Contains(overlay.Bounds)), "offscreen position not clamped");
                backend.Emit(Frame(true, true, true)); Pump();
                Check((GetWindowLong(overlay.Handle, -20) & 0x20) != 0 && presenter.LockedItem.Checked, "click-through lock");
                backend.Emit(Frame(true, true, false)); Pump();
                Check((GetWindowLong(overlay.Handle, -20) & 0x20) == 0, "unlock from settings");
                var doubleHeight = overlay.Height;
                var style = new Dictionary<string, object> { { "fontFamily", "missing-font-test" }, { "lineMode", "single" }, { "animate", false }, { "currentColor", "#00ff00" }, { "nextColor", "#ffffff" } };
                overlay.Appearance(style); overlay.Configure(28, false, 0, 0);
                Check(overlay.Height < doubleHeight, "single line must shrink window");
                overlay.Display("", "future"); Check(!overlay.Visible, "single mode before first line");
                overlay.Display("current", "future"); Check(overlay.Visible, "single mode current line");
                Check(!string.IsNullOrEmpty(LyricsAppearance.Resolve("missing-font-test")), "font fallback");
                int delta = 0; overlay.OffsetChanged += (value, reset) => delta = value;
                var strip = overlay.Controls.OfType<ToolStrip>().Single();
                var activation = Message.Create(strip.Handle, 0x21, overlay.Handle, (IntPtr)(1 | (0x201 << 16)));
                var activationArgs = new object[] { activation };
                strip.GetType().GetMethod("WndProc", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(strip, activationArgs);
                Check(((Message)activationArgs[0]).Result == (IntPtr)3, "inactive toolbar must not eat the first click");
                Check(!strip.Items.OfType<ToolStripLabel>().Any(), "offset must not occupy a permanent toolbar label");
                strip.Items.Cast<ToolStripItem>().Single(i => i.ToolTipText == "提前 0.5 秒").PerformClick();
                Check(delta == -500, "advance button convention");
                Check(strip.Dock == DockStyle.None && strip.BackColor.GetBrightness() < 0.3, "centered floating toolbar");
                Check(strip.Items.Cast<ToolStripItem>().Last().ToolTipText == "关闭歌词，不停止音乐", "close at end of centered group");
                style["orientation"] = "vertical"; overlay.Appearance(style); overlay.Configure(28, false, 0, 0);
                Check(overlay.Height > overlay.Width, "vertical lyrics layout");
                style["orientation"] = "horizontal"; overlay.Appearance(style); overlay.Configure(28, false, 0, 0);
                Check(overlay.Width > overlay.Height && overlay.Cursor == Cursors.SizeAll, "horizontal layout and drag cursor");
                var updatePointer = typeof(LyricsOverlayForm).GetMethod("UpdatePointer", BindingFlags.Instance | BindingFlags.NonPublic);
                var savedLocation = overlay.Location;
                overlay.Location = new System.Drawing.Point(Cursor.Position.X + 200, Cursor.Position.Y + 200);
                updatePointer.Invoke(overlay, null); Check(!strip.Visible, "toolbar hides outside window");
                var stableSize = overlay.Size;
                overlay.Location = new System.Drawing.Point(Cursor.Position.X - 20, Cursor.Position.Y - 45);
                updatePointer.Invoke(overlay, null); Check(strip.Visible, "toolbar appears over lyric background");
                Check(overlay.Size == stableSize && Math.Abs(strip.Left * 2 + strip.Width - overlay.Width) <= 1, "hover preserves layout and horizontal centering");
                using (var bitmap = new System.Drawing.Bitmap(overlay.Width, overlay.Height)) {
                    overlay.DrawToBitmap(bitmap, overlay.ClientRectangle);
                    Check(bitmap.GetPixel(12, overlay.Height - 12).ToArgb() == System.Drawing.Color.Magenta.ToArgb(), "foreground must stay transparent over independently blended backdrop");
                }
                var backdrop = Application.OpenForms.Cast<Form>().OfType<LyricsBackdropForm>().Single();
                Check(backdrop.Visible && Math.Abs(backdrop.Opacity - 0.15) < 0.01 && backdrop.Bounds == overlay.Bounds, "hover backdrop uses independent 15 percent opacity and matching bounds");
                var mouseMove = typeof(Control).GetMethod("OnMouseMove", BindingFlags.Instance | BindingFlags.NonPublic);
                var actionButton = strip.Items.OfType<ToolStripButton>().Single(i=>i.ToolTipText == "缩小歌词");
                var originalPointer = Cursor.Position;
                overlay.Location = Screen.PrimaryScreen.WorkingArea.Location;
                Cursor.Position = overlay.PointToScreen(new System.Drawing.Point(20, 45));
                updatePointer.Invoke(overlay, null);
                Cursor.Position = strip.PointToScreen(new System.Drawing.Point(actionButton.Bounds.Left + actionButton.Bounds.Width / 2, actionButton.Bounds.Top + actionButton.Bounds.Height / 2));
                Pump();
                typeof(ToolStripItem).GetMethod("OnMouseEnter", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(actionButton, new object[] { EventArgs.Empty });
                var cursorMessage = Message.Create(strip.Handle, 0x20, strip.Handle, (IntPtr)1);
                var cursorArgs = new object[] { cursorMessage };
                strip.GetType().GetMethod("WndProc", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(strip, cursorArgs);
                Check(strip.Cursor == Cursors.Hand, "action button uses native hand cursor");
                var actions = typeof(LyricsOverlayForm).GetField("_actions", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(overlay);
                typeof(LyricsControls).GetMethod("ShowHint", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(actions, null);
                var hintWindow = (Form)typeof(LyricsControls).GetField("_hint", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(actions);
                Check(hintWindow.Visible && hintWindow.Controls.OfType<Label>().Single().Text == "缩小歌词", "nonactivating toolbar shows Chinese hint");
                Check((GetWindowLong(hintWindow.Handle, -20) & 0x80020) == 0x80020, "tooltip must be layered and transparent to pass clicks across windows");
                int firstClickActions = 0; overlay.FontSizeChanged += value => firstClickActions++;
                var buttonPoint = new System.Drawing.Point(actionButton.Bounds.Left + 15, actionButton.Bounds.Top + 15);
                foreach (int msg in new[] { 0x201, 0x202 }) {
                    var click = Message.Create(strip.Handle, msg, msg == 0x201 ? (IntPtr)1 : IntPtr.Zero, (IntPtr)(buttonPoint.X | (buttonPoint.Y << 16)));
                    strip.GetType().GetMethod("WndProc", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(strip, new object[] { click });
                }
                Check(firstClickActions == 1, "one button press/release with hint visible must execute exactly once");
                Check(!hintWindow.Visible, "press hides hint immediately");
                Check(!strip.Items.OfType<ToolStripLabel>().Any(), "offset must not occupy a permanent toolbar label");
                Check(strip.Items.OfType<ToolStripButton>().All(i => i.DisplayStyle == ToolStripItemDisplayStyle.Image && i.Image != null && i.Width == 30 && i.Height == 30), "all toolbar actions are 30px icon targets");
                overlay.Offset(80); Check(strip.Items.OfType<ToolStripButton>().Any(i => i.ToolTipText.Contains("+80 ms")), "offset precision available in hint");
                overlay.Offset(90); Check(strip.Items.OfType<ToolStripButton>().Any(i => i.ToolTipText.Contains("+90 ms")), "offset hint updates");
                Cursor.Position = strip.PointToScreen(new System.Drawing.Point(0, 0));
                typeof(ToolStripItem).GetMethod("OnMouseLeave", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(actionButton, new object[] { EventArgs.Empty });
                mouseMove.Invoke(strip, new object[] { new MouseEventArgs(MouseButtons.None, 0, 0, 0, 0) });
                Check(!hintWindow.Visible, "hint hides when moving to toolbar empty space");
                Check(strip.Cursor == Cursors.SizeAll, "toolbar empty space offers drag cursor");
                Cursor.Position = originalPointer;
                Check(!strip.ShowItemToolTips, "automatic tooltip must not duplicate positioned hint");
                var screenBounds = new System.Drawing.Rectangle(0, 0, 800, 600);
                var hintSize = new System.Drawing.Size(200, 40);
                Check(LyricsControls.HintPosition(new System.Drawing.Point(200, 100), hintSize, screenBounds) == new System.Drawing.Point(208, 124), "hint below pointer with cursor clearance");
                var hintPosition = LyricsControls.HintPosition(new System.Drawing.Point(780, 590), hintSize, screenBounds);
                Check(screenBounds.Contains(new System.Drawing.Rectangle(hintPosition, hintSize)) && hintPosition.Y + hintSize.Height < 590, "hint avoids bottom and right edges");
                overlay.Location = savedLocation;
                Check(overlay.ContextMenuStrip.Items.OfType<ToolStripMenuItem>().Any(i => i.Text == "歌词操作" && i.DropDownItems.Count >= 3), "grouped offset menu");
                int settingsOpened = 0; overlay.SettingsRequested += () => settingsOpened++;
                strip.Items.Cast<ToolStripItem>().Single(i => i.ToolTipText == "更多歌词设置").PerformClick();
                Check(settingsOpened == 1, "settings button opens management");
                string changedKey = null; object changedValue = null;
                overlay.SettingChanged += (key, value) => { changedKey = key; changedValue = value; };
                overlay.ContextMenuStrip.Items.OfType<ToolStripMenuItem>().Single(i => i.Text == "恢复外观默认").PerformClick();
                Check(changedKey == "resetAppearance" && object.Equals(changedValue, true), "reset is appearance-only action");
                style["opacity"] = 40; style["fontWeight"] = "bold";
                overlay.Appearance(style); overlay.Display("current", "future");
                Check(Math.Abs(overlay.Opacity - 0.4) < 0.01, "saved opacity applied");
                overlay.Clear(); overlay.Display("again", "next");
                Check(Math.Abs(overlay.Opacity - 0.4) < 0.01, "hide/show must preserve opacity");
                style["animate"] = true; overlay.Appearance(style); overlay.Display("fade", "next");
                Check(Math.Abs(overlay.Opacity - 0.4) < 0.01, "sentence fade must not flash toolbar or window");
                var fadeDeadline = DateTime.UtcNow.AddMilliseconds(300);
                while (DateTime.UtcNow < fadeDeadline) { Pump(); System.Threading.Thread.Sleep(5); }
                Check(Math.Abs(overlay.Opacity - 0.4) < 0.01, "fade settles to saved opacity not full opacity");
                Check(overlay.ContextMenuStrip.Items.OfType<ToolStripMenuItem>().All(i => i.ShortcutKeys == Keys.None), "no keyboard shortcuts");
                overlay.Configure(28, true, 0, 0); Check(!strip.Visible, "locked controls hidden");
                var unlock = overlay.Controls.OfType<Button>().Single();
                style["orientation"] = "vertical"; overlay.Appearance(style); overlay.Configure(28, true, 0, 0);
                Check(Math.Abs(unlock.Top * 2 + unlock.Height - overlay.Height) <= 1 && unlock.Left == strip.Left, "vertical unlock centered in toolbar lane");
                Check(unlock.BackColor == System.Drawing.Color.Black && unlock.Width >= 46 && unlock.Height >= 46, "unlock black expanded click target");
                var lockPointer = Cursor.Position;
                Cursor.Position = overlay.PointToScreen(new System.Drawing.Point(20, 45)); updatePointer.Invoke(overlay, null);
                Check(unlock.Visible && unlock.Image != null && unlock.Text == "", "hover reveals icon-only unlock target");
                Cursor.Position = unlock.PointToScreen(new System.Drawing.Point(2, 2)); updatePointer.Invoke(overlay, null);
                Check((GetWindowLong(overlay.Handle, -20) & 0x20) == 0, "unlock padding receives clicks instead of passing through");
                unlock.PerformClick(); Check(changedKey == "locked" && object.Equals(changedValue, false), "unlock requests shared setting");
                Cursor.Position = overlay.PointToScreen(new System.Drawing.Point(overlay.Width + 50, overlay.Height + 50)); updatePointer.Invoke(overlay, null);
                Check(!unlock.Visible, "unlock hides when pointer leaves"); Cursor.Position = lockPointer;
                var stale = Frame(true, true, false, "stale");
                backend.Emit(Frame(false, false)); Pump(); Check(overlay.IsDisposed && Overlay() == null, "off must dispose window");
                backend.Emit(stale); Pump(); Check(Overlay() == null, "old frame revived disabled lyrics");
                for (int i = 0; i < 60; i++) {
                    backend.Emit(Frame(true, true)); Pump();
                    Check(Overlay() != null, "on");
                    backend.Emit(Frame(true, false)); Pump(); Check(!Overlay().Visible && presenter.EnabledItem.Checked, "automatic hide must keep enabled");
                    backend.Emit(Frame(false, false)); Pump(); Check(Overlay() == null, "window accumulated");
                }
                for (int i = 0; i < 100; i++) backend.Emit(Frame(true, true));
                backend.Emit(Frame(false, false)); Pump(); Check(Overlay() == null, "coalescing did not use final state");
                backend.Emit(Frame(true, true)); Pump();
                presenter.Dispose(); presenter.Dispose(); Pump();
                Check(backend.Subscribers == 0 && Overlay() == null, "dispose retained subscription or window");
                backend.Emit(Frame(true, true)); Pump(); Check(Overlay() == null, "post-disposal frame revived overlay");
            }
            Console.WriteLine("PASS native focus, clamp, lock, stale frames, 60 lifecycle cycles, coalescing and disposal");
            return 0;
        } catch (Exception failure) { Console.Error.WriteLine(failure); return 1; }
    }
}
