using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace OliviaSoul
{
    public enum WindowControlKind
    {
        Minimize,
        Maximize,
        Close,
    }

    public sealed class WindowControlButton : Control
    {
        private readonly WindowControlKind _kind;
        private bool _hovered;
        private bool _pressed;
        private bool _isRestore;

        public WindowControlButton(WindowControlKind kind)
        {
            _kind = kind;
            Dock = DockStyle.Fill;
            Margin = Padding.Empty;
            TabStop = false;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw |
                ControlStyles.SupportsTransparentBackColor |
                ControlStyles.UserPaint,
                true
            );
            BackColor = Color.Transparent;
        }

        public bool IsRestore
        {
            get { return _isRestore; }
            set
            {
                if (_isRestore == value) return;
                _isRestore = value;
                Invalidate();
            }
        }

        protected override void OnMouseEnter(System.EventArgs args)
        {
            _hovered = true;
            Invalidate();
            base.OnMouseEnter(args);
        }

        protected override void OnMouseLeave(System.EventArgs args)
        {
            _hovered = false;
            _pressed = false;
            Invalidate();
            base.OnMouseLeave(args);
        }

        protected override void OnMouseDown(MouseEventArgs args)
        {
            if (args.Button == MouseButtons.Left)
            {
                _pressed = true;
                Invalidate();
            }
            base.OnMouseDown(args);
        }

        protected override void OnMouseUp(MouseEventArgs args)
        {
            _pressed = false;
            Invalidate();
            base.OnMouseUp(args);
        }

        protected override void OnPaint(PaintEventArgs args)
        {
            var graphics = args.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var background = Color.Transparent;
            if (_pressed)
                background = _kind == WindowControlKind.Close ? Color.FromArgb(150, 34, 25) : Color.FromArgb(43, 45, 51);
            else if (_hovered)
                background = _kind == WindowControlKind.Close ? Color.FromArgb(196, 43, 28) : Color.FromArgb(35, 37, 43);
            if (background != Color.Transparent)
                using (var brush = new SolidBrush(background))
                    graphics.FillRectangle(brush, ClientRectangle);

            var iconColor = _hovered && _kind == WindowControlKind.Close
                ? Color.FromArgb(245, 245, 246)
                : Color.FromArgb(105, 108, 117);
            var scale = graphics.DpiX / 96f;
            using (var pen = new Pen(iconColor, 1.6f * scale))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                var centerX = Width / 2f;
                var centerY = Height / 2f;
                var half = 5.5f * scale;
                if (_kind == WindowControlKind.Minimize)
                    graphics.DrawLine(pen, centerX - half, centerY + 2.5f * scale, centerX + half, centerY + 2.5f * scale);
                else if (_kind == WindowControlKind.Close)
                {
                    graphics.DrawLine(pen, centerX - half, centerY - half, centerX + half, centerY + half);
                    graphics.DrawLine(pen, centerX + half, centerY - half, centerX - half, centerY + half);
                }
                else if (_isRestore)
                {
                    var size = 8f * scale;
                    graphics.DrawRectangle(pen, centerX - size / 2 + 2 * scale, centerY - size / 2 - 2 * scale, size, size);
                    graphics.DrawRectangle(pen, centerX - size / 2 - 2 * scale, centerY - size / 2 + 2 * scale, size, size);
                }
                else
                {
                    var size = 10f * scale;
                    graphics.DrawRectangle(pen, centerX - size / 2, centerY - size / 2, size, size);
                }
            }
        }
    }
}
