using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace OliviaSoul
{
    public sealed class SplashForm : Form
    {
        private const double EnvelopeScale = 0.7804;
        private const double EnvelopeOffsetX = 0.02;
        private const double EnvelopeOffsetY = -0.0265;
        private const double WordmarkScale = 1.1689;
        private const double WordmarkOffsetX = -0.012;
        private const double WordmarkOffsetY = 0.105;
        private readonly Image _envelope;
        private readonly Image _wordmark;
        private readonly int _layoutBaseWidth;
        private readonly int _layoutBaseHeight;
        private readonly int _envelopeWidth;
        private readonly int _envelopeHeight;
        private readonly int _wordmarkWidth;
        private readonly int _wordmarkHeight;
        private readonly Point _screenLocation;
        private IntPtr _memoryDc;
        private IntPtr _bitmapHandle;
        private IntPtr _previousBitmap;
        private Timer _timer;

        public SplashForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            ShowInTaskbar = false;
            TopMost = true;

            var assembly = Assembly.GetExecutingAssembly();
            using (var stream = assembly.GetManifestResourceStream("OliviaSoul.olivia-soul-gold.png"))
            {
                if (stream == null) throw new InvalidDataException("开屏标题资源缺失");
                using (var image = Image.FromStream(stream))
                    _wordmark = new Bitmap(image);
            }
            using (var stream = assembly.GetManifestResourceStream("OliviaSoul.splash-envelope.png"))
            {
                if (stream == null) throw new InvalidDataException("开屏信封资源缺失");
                using (var image = Image.FromStream(stream))
                    _envelope = new Bitmap(image);
            }
            _layoutBaseWidth = Screen.PrimaryScreen.WorkingArea.Width / 4;
            _layoutBaseHeight = (int)Math.Round(_layoutBaseWidth * _envelope.Height / (double)_envelope.Width);
            _envelopeWidth = (int)Math.Round(_layoutBaseWidth * EnvelopeScale);
            _envelopeHeight = (int)Math.Round(_envelopeWidth * _envelope.Height / (double)_envelope.Width);
            _wordmarkWidth = (int)Math.Round(_layoutBaseWidth * WordmarkScale);
            _wordmarkHeight = (int)Math.Round(_wordmarkWidth * _wordmark.Height / (double)_wordmark.Width);
            ClientSize = new Size((int)Math.Round(_layoutBaseWidth * 1.28), _layoutBaseHeight);
            var workingArea = Screen.PrimaryScreen.WorkingArea;
            _screenLocation = new Point(
                workingArea.Left + (workingArea.Width - ClientSize.Width) / 2,
                workingArea.Top + (workingArea.Height - ClientSize.Height) / 2
            );
            Location = _screenLocation;
            CreateLayeredSurface();
        }

        public void BeginAnimation(Action fadeOutStarted)
        {
            var unused = Handle;
            Present(0);
            var clock = Stopwatch.StartNew();
            var mainWindowShown = false;
            _timer = new Timer { Interval = 8 };
            _timer.Tick += delegate
            {
                var elapsed = clock.ElapsedMilliseconds;
                if (elapsed < 200)
                    Present((byte)Math.Round(elapsed / 200d * 255));
                else if (elapsed < 2200)
                    Present(255);
                else if (elapsed < 2400)
                {
                    if (!mainWindowShown)
                    {
                        mainWindowShown = true;
                        fadeOutStarted();
                    }
                    Present((byte)Math.Round((2400 - elapsed) / 200d * 255));
                }
                else
                {
                    _timer.Stop();
                    Present(0);
                    Close();
                }
            };
            _timer.Start();
        }

        private void CreateLayeredSurface()
        {
            using (var surface = new Bitmap(ClientSize.Width, ClientSize.Height, PixelFormat.Format32bppPArgb))
            {
                using (var graphics = Graphics.FromImage(surface))
                using (var imageAttributes = new ImageAttributes())
                {
                    graphics.Clear(Color.Transparent);
                    graphics.CompositingMode = CompositingMode.SourceOver;
                    graphics.CompositingQuality = CompositingQuality.HighQuality;
                    graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    imageAttributes.SetWrapMode(WrapMode.TileFlipXY);
                    var left = (int)Math.Round(
                        (ClientSize.Width - _envelopeWidth) / 2d + _layoutBaseWidth * EnvelopeOffsetX
                    );
                    var top = (int)Math.Round(
                        (ClientSize.Height - _envelopeHeight) / 2d + _layoutBaseHeight * EnvelopeOffsetY
                    );
                    graphics.DrawImage(
                        _envelope,
                        new Rectangle(left, top, _envelopeWidth, _envelopeHeight),
                        0,
                        0,
                        _envelope.Width,
                        _envelope.Height,
                        GraphicsUnit.Pixel,
                        imageAttributes
                    );
                    graphics.DrawImage(
                        _wordmark,
                        new Rectangle(
                            (int)Math.Round(
                                (ClientSize.Width - _wordmarkWidth) / 2d + _layoutBaseWidth * WordmarkOffsetX
                            ),
                            (int)Math.Round(
                                (ClientSize.Height - _wordmarkHeight) / 2d + _layoutBaseHeight * WordmarkOffsetY
                            ),
                            _wordmarkWidth,
                            _wordmarkHeight
                        ),
                        0,
                        0,
                        _wordmark.Width,
                        _wordmark.Height,
                        GraphicsUnit.Pixel,
                        imageAttributes
                    );
                }

                var area = new Rectangle(Point.Empty, surface.Size);
                var data = surface.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
                var rowBytes = surface.Width * 4;
                var pixels = new byte[rowBytes * surface.Height];
                for (var y = 0; y < surface.Height; y++)
                    Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), pixels, y * rowBytes, rowBytes);
                surface.UnlockBits(data);

                var info = new BitmapInfo
                {
                    Header = new BitmapInfoHeader
                    {
                        Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader)),
                        Width = surface.Width,
                        Height = -surface.Height,
                        Planes = 1,
                        BitCount = 32,
                        Compression = 0,
                        SizeImage = (uint)pixels.Length,
                    },
                };
                _memoryDc = CreateCompatibleDC(IntPtr.Zero);
                IntPtr bits;
                _bitmapHandle = CreateDIBSection(IntPtr.Zero, ref info, 0, out bits, IntPtr.Zero, 0);
                if (_memoryDc == IntPtr.Zero || _bitmapHandle == IntPtr.Zero)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                Marshal.Copy(pixels, 0, bits, pixels.Length);
                _previousBitmap = SelectObject(_memoryDc, _bitmapHandle);
            }
        }

        private void Present(byte opacity)
        {
            var destination = new NativePoint(_screenLocation.X, _screenLocation.Y);
            var source = new NativePoint(0, 0);
            var size = new NativeSize(ClientSize.Width, ClientSize.Height);
            var blend = new BlendFunction
            {
                BlendOperation = 0,
                SourceConstantAlpha = opacity,
                AlphaFormat = 1,
            };
            var screenDc = GetDC(IntPtr.Zero);
            try
            {
                if (!UpdateLayeredWindow(Handle, screenDc, ref destination, ref size, _memoryDc, ref source, 0, ref blend, 2))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                parameters.ExStyle |= 0x00080000 | 0x00000080;
                return parameters;
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_timer != null) _timer.Dispose();
                if (_memoryDc != IntPtr.Zero && _previousBitmap != IntPtr.Zero)
                    SelectObject(_memoryDc, _previousBitmap);
                if (_bitmapHandle != IntPtr.Zero) DeleteObject(_bitmapHandle);
                if (_memoryDc != IntPtr.Zero) DeleteDC(_memoryDc);
                _envelope.Dispose();
                _wordmark.Dispose();
            }
            base.Dispose(disposing);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativePoint
        {
            public int X;
            public int Y;

            public NativePoint(int x, int y)
            {
                X = x;
                Y = y;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeSize
        {
            public int Width;
            public int Height;

            public NativeSize(int width, int height)
            {
                Width = width;
                Height = height;
            }
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct BlendFunction
        {
            public byte BlendOperation;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BitmapInfoHeader
        {
            public uint Size;
            public int Width;
            public int Height;
            public ushort Planes;
            public ushort BitCount;
            public uint Compression;
            public uint SizeImage;
            public int XPixelsPerMeter;
            public int YPixelsPerMeter;
            public uint ColorsUsed;
            public uint ColorsImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BitmapInfo
        {
            public BitmapInfoHeader Header;
            public uint Colors;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr window, IntPtr deviceContext);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateCompatibleDC(IntPtr deviceContext);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateDIBSection(
            IntPtr deviceContext,
            ref BitmapInfo bitmapInfo,
            uint usage,
            out IntPtr bits,
            IntPtr section,
            uint offset
        );

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr deviceContext, IntPtr drawingObject);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr drawingObject);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr deviceContext);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UpdateLayeredWindow(
            IntPtr window,
            IntPtr destinationDeviceContext,
            ref NativePoint destination,
            ref NativeSize size,
            IntPtr sourceDeviceContext,
            ref NativePoint source,
            int colorKey,
            ref BlendFunction blend,
            int flags
        );
    }
}
