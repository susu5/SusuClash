// Native presentation for the approved author-v3 / installer-ring-v2 surface.
// The production form never calls MSI, launches a process, or manufactures progress.
// The separate qa/installer harness is compiled only with INSTALLER_QA.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace SusuClash.Installer
{
    public sealed class InstallerThemeData
    {
        public string Key, Name;
        public Color Window, Surface, Text, Muted, Accent, Track, NavSelected, NavText, NavAccent;
        public Color ShadowRaisedDark, ShadowRaisedLight, ShadowInsetDark, ShadowInsetLight;
        public float ShadowRaisedOffsetX, ShadowRaisedOffsetY, ShadowRaisedBlur;
        public float ShadowRaisedLightOffsetX, ShadowRaisedLightOffsetY, ShadowRaisedLightBlur;
        public float ShadowInsetOffsetX, ShadowInsetOffsetY, ShadowInsetBlur;
        public float ShadowInsetLightOffsetX, ShadowInsetLightOffsetY, ShadowInsetLightBlur;
    }

    internal static class InstallerNative
    {
        [DllImport("user32.dll")] internal static extern bool ReleaseCapture();
        [DllImport("user32.dll")] internal static extern IntPtr SendMessage(IntPtr h, int message, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr h, int attribute, ref int value, int size);
        internal static void PrepareThread() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { } }
        internal static float Scale(IntPtr window)
        {
            try { uint dpi = GetDpiForWindow(window); if (dpi > 0) return dpi / 96f; } catch (EntryPointNotFoundException) { }
            using (Graphics graphics = Graphics.FromHwnd(window)) return graphics.DpiX / 96f;
        }
        internal static bool ReducedMotion()
        {
            bool enabled;
            return SystemParametersInfo(0x1042, 0, out enabled, 0) && !enabled;
        }
        internal static void SquareWindow(IntPtr window)
        {
            try { int square = 1, noBorder = unchecked((int)0xFFFFFFFE); DwmSetWindowAttribute(window, 33, ref square, 4); DwmSetWindowAttribute(window, 34, ref noBorder, 4); } catch (DllNotFoundException) { }
        }
    }

    internal sealed class InstallerAssets : IDisposable
    {
        private readonly List<Stream> streams = new List<Stream>();
        internal readonly Image Gif, Poster;
        internal readonly Icon Icon;
        internal readonly string License;
        internal InstallerAssets()
        {
            try {
                Gif = Image.FromStream(Open("cat-motion.gif"));
                Poster = Image.FromStream(Open("cat-poster.png"));
                Icon = new Icon(Open("icon.ico"));
                using (StreamReader reader = new StreamReader(Open("LICENSE"), Encoding.UTF8, true)) License = reader.ReadToEnd();
            } catch { Dispose(); throw; }
        }
        private Stream Open(string suffix)
        {
            Assembly assembly = typeof(InstallerForm).Assembly;
            string exact = "SusuClash.Installer." + suffix;
            Stream stream = assembly.GetManifestResourceStream(exact);
            if (stream == null) throw new InvalidOperationException("Missing embedded installer asset: " + suffix);
            streams.Add(stream); return stream;
        }
        public void Dispose()
        {
            if (Gif != null) Gif.Dispose(); if (Poster != null) Poster.Dispose(); if (Icon != null) Icon.Dispose();
            foreach (Stream stream in streams) stream.Dispose(); streams.Clear();
        }
    }

    internal static class InstallerTypography
    {
        private static readonly string cjk = FindCjk();
        private static string FindCjk()
        {
            foreach (string name in new string[] { "Microsoft YaHei UI", "Microsoft YaHei" }) try { using (FontFamily family = new FontFamily(name)) return family.Name; } catch (ArgumentException) { }
            return InstallerTheme.FontFamily;
        }
        internal static string Family(string text)
        { if (text == null) return cjk; foreach (char character in text) if (character >= '\u2e80' && character <= '\uffef') return cjk; return InstallerTheme.FontFamily; }
    }

    internal static class InstallerPaint
    {
        private static readonly Dictionary<string, Bitmap> shadows = new Dictionary<string, Bitmap>();
        internal static Color Blend(Color foreground, Color background, float amount)
        {
            return Color.FromArgb(255, (int)(foreground.R * amount + background.R * (1 - amount)), (int)(foreground.G * amount + background.G * (1 - amount)), (int)(foreground.B * amount + background.B * (1 - amount)));
        }
        internal static Color PrimaryText(InstallerThemeData theme) { return theme.Key == "whale" ? theme.Window : InstallerTheme.All[0].NavSelected; }
        internal static GraphicsPath Rounded(RectangleF bounds, float radius)
        {
            GraphicsPath path = new GraphicsPath(); float diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
            if (diameter <= 0) { path.AddRectangle(bounds); return path; }
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90); path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90); path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90); path.CloseFigure(); return path;
        }
        internal static void Fill(Graphics graphics, RectangleF bounds, float radius, Color color)
        { using (GraphicsPath path = Rounded(bounds, radius)) using (Brush brush = new SolidBrush(color)) graphics.FillPath(brush, path); }
        private static float[] Blur(float[] input, int width, int height, int radius)
        {
            if (radius < 1) return input;
            float[] horizontal = new float[input.Length], output = new float[input.Length]; int diameter = radius * 2 + 1;
            for (int y = 0; y < height; y++) {
                float sum = 0; int row = y * width;
                for (int i = -radius; i <= radius; i++) sum += input[row + Math.Max(0, Math.Min(width - 1, i))];
                for (int x = 0; x < width; x++) { horizontal[row + x] = sum / diameter; sum += input[row + Math.Min(width - 1, x + radius + 1)] - input[row + Math.Max(0, x - radius)]; }
            }
            for (int x = 0; x < width; x++) {
                float sum = 0;
                for (int i = -radius; i <= radius; i++) sum += horizontal[Math.Max(0, Math.Min(height - 1, i)) * width + x];
                for (int y = 0; y < height; y++) { output[y * width + x] = sum / diameter; sum += horizontal[Math.Min(height - 1, y + radius + 1) * width + x] - horizontal[Math.Max(0, y - radius) * width + x]; }
            }
            return output;
        }
        private static void Shadow(Graphics graphics, RectangleF bounds, float radius, Color color, float offsetX, float offsetY, float blur, bool inset)
        {
            int width = Math.Max(1, (int)Math.Ceiling(bounds.Width)), height = Math.Max(1, (int)Math.Ceiling(bounds.Height));
            int pad = (int)Math.Ceiling(blur * 2 + Math.Max(Math.Abs(offsetX), Math.Abs(offsetY)) + 2);
            string key = width + ":" + height + ":" + radius + ":" + color.ToArgb() + ":" + offsetX + ":" + offsetY + ":" + blur + ":" + inset;
            Bitmap bitmap;
            if (!shadows.TryGetValue(key, out bitmap)) {
                bitmap = new Bitmap(width + pad * 2, height + pad * 2, PixelFormat.Format32bppArgb);
                using (Graphics mask = Graphics.FromImage(bitmap)) {
                    mask.SmoothingMode = SmoothingMode.AntiAlias;
                    if (inset) mask.Clear(Color.White); else mask.Clear(Color.Transparent);
                    mask.CompositingMode = CompositingMode.SourceCopy;
                    Fill(mask, new RectangleF(pad + offsetX, pad + offsetY, bounds.Width, bounds.Height), radius, inset ? Color.Transparent : Color.White);
                }
                Rectangle rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
                BitmapData data = bitmap.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
                int[] pixels = new int[bitmap.Width * bitmap.Height]; Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                float[] alpha = new float[pixels.Length]; for (int i = 0; i < pixels.Length; i++) alpha[i] = (uint)pixels[i] >> 24;
                int box = Math.Max(1, (int)Math.Ceiling(blur * .29f)); for (int pass = 0; pass < 3; pass++) alpha = Blur(alpha, bitmap.Width, bitmap.Height, box);
                for (int i = 0; i < pixels.Length; i++) pixels[i] = ((int)(Math.Max(0, Math.Min(255, alpha[i])) * color.A / 255) << 24) | (color.R << 16) | (color.G << 8) | color.B;
                Marshal.Copy(pixels, 0, data.Scan0, pixels.Length); bitmap.UnlockBits(data);
                if (shadows.Count > 96) ClearCache(); shadows[key] = bitmap;
            }
            GraphicsState saved = graphics.Save();
            if (inset) using (GraphicsPath path = Rounded(bounds, radius)) graphics.SetClip(path, CombineMode.Intersect);
            graphics.DrawImageUnscaled(bitmap, (int)Math.Round(bounds.X) - pad, (int)Math.Round(bounds.Y) - pad); graphics.Restore(saved);
        }
        internal static void Elevation(Graphics graphics, RectangleF bounds, float radius, InstallerThemeData theme, float scale, bool inset)
        {
            if (inset) {
                Shadow(graphics, bounds, radius, theme.ShadowInsetDark, theme.ShadowInsetOffsetX * scale, theme.ShadowInsetOffsetY * scale, theme.ShadowInsetBlur * scale, true);
                Shadow(graphics, bounds, radius, theme.ShadowInsetLight, theme.ShadowInsetLightOffsetX * scale, theme.ShadowInsetLightOffsetY * scale, theme.ShadowInsetLightBlur * scale, true);
            } else {
                Shadow(graphics, bounds, radius, theme.ShadowRaisedDark, theme.ShadowRaisedOffsetX * scale, theme.ShadowRaisedOffsetY * scale, theme.ShadowRaisedBlur * scale, false);
                Shadow(graphics, bounds, radius, theme.ShadowRaisedLight, theme.ShadowRaisedLightOffsetX * scale, theme.ShadowRaisedLightOffsetY * scale, theme.ShadowRaisedLightBlur * scale, false);
            }
        }
        internal static void ClearCache() { foreach (Bitmap value in shadows.Values) value.Dispose(); shadows.Clear(); }
        internal static void Icon(Graphics graphics, string name, RectangleF rect, Color color, float scale)
        {
            GraphicsState saved = graphics.Save(); graphics.TranslateTransform(rect.X, rect.Y); graphics.ScaleTransform(rect.Width / 24f, rect.Height / 24f);
            using (Pen pen = new Pen(color, 1.7f)) {
                pen.StartCap = pen.EndCap = LineCap.Round; pen.LineJoin = LineJoin.Round;
                if (name == "close") { graphics.DrawLine(pen, 6, 6, 18, 18); graphics.DrawLine(pen, 18, 6, 6, 18); }
                else if (name == "check") graphics.DrawLines(pen, new PointF[] { new PointF(5,12), new PointF(10,17), new PointF(19,7) });
                else if (name == "download") { graphics.DrawLine(pen,12,3,12,15); graphics.DrawLines(pen,new PointF[]{new PointF(7,10),new PointF(12,15),new PointF(17,10)});graphics.DrawLines(pen,new PointF[]{new PointF(5,16),new PointF(5,21),new PointF(19,21),new PointF(19,16)}); }
                else if (name == "clock") { graphics.DrawEllipse(pen,3,3,18,18);graphics.DrawLines(pen,new PointF[]{new PointF(12,7),new PointF(12,12),new PointF(15,14)}); }
                else { graphics.DrawLine(pen,4,12,20,12); graphics.DrawLines(pen,new PointF[]{new PointF(14,6),new PointF(20,12),new PointF(14,18)}); }
            }
            graphics.Restore(saved);
        }
    }

    internal sealed class ThemePanel : Panel
    {
        internal InstallerThemeData Theme;
        internal float ScaleFactor = 1;
        internal Action<Graphics> DrawContent;
        internal ThemePanel() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true); }
        protected override void OnPaintBackground(PaintEventArgs e) { e.Graphics.Clear(Theme == null ? BackColor : Theme.Window); }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            if (DrawContent != null) DrawContent(e.Graphics);
            foreach (Control child in Controls) {
                ThemeButton button = child as ThemeButton;
                if (button != null && button.Visible && button.Enabled && button.Raised && !button.Pressed) InstallerPaint.Elevation(e.Graphics, button.Bounds, button.Radius * ScaleFactor, Theme, ScaleFactor, false);
            }
            base.OnPaint(e);
        }
    }

    internal sealed class TextBlock : Control
    {
        internal float LineSpacing = 1.5f;
        internal bool Centered;
        internal TextBlock() { SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true); BackColor = Color.Transparent; TabStop = false; AccessibleRole = AccessibleRole.StaticText; }
        internal static List<string> Lines(string text, Font font, int width)
        {
            List<string> lines = new List<string>();
            foreach (string paragraph in (text ?? "").Replace("\r", "").Split('\n')) {
                if (paragraph.Length == 0) { lines.Add(""); continue; }
                string line = "";
                for (int i = 0; i < paragraph.Length; i++) {
                    string next = line + paragraph[i];
                    if (line.Length > 0 && TextRenderer.MeasureText(next, font, new Size(Int32.MaxValue, Int32.MaxValue), TextFormatFlags.NoPadding).Width > width) {
                        int split = line.LastIndexOf(' ');
                        if (split > line.Length / 2) { lines.Add(line.Substring(0, split)); line = line.Substring(split + 1) + paragraph[i]; }
                        else { lines.Add(line); line = paragraph[i].ToString(); }
                    } else line = next;
                }
                lines.Add(line);
            }
            return lines;
        }
        internal int NeededHeight(int width) { return (int)Math.Ceiling(Lines(Text, Font, Math.Max(1, width)).Count * Font.Size * LineSpacing); }
        protected override void OnPaint(PaintEventArgs e)
        {
            List<string> lines = Lines(Text, Font, Math.Max(1, ClientSize.Width)); float y = 0;
            foreach (string line in lines) {
                TextRenderer.DrawText(e.Graphics, line, Font, new Rectangle(0, (int)Math.Round(y), Width, (int)Math.Ceiling(Font.Size * LineSpacing)), ForeColor,
                    TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | (Centered ? TextFormatFlags.HorizontalCenter : TextFormatFlags.Left));
                y += Font.Size * LineSpacing;
            }
        }
    }

    internal sealed class ThemeButton : Button
    {
        internal InstallerThemeData Theme;
        internal float ScaleFactor = 1, Radius = InstallerTheme.ControlRadius;
        internal bool Primary, Ghost, Raised = true, Pressed;
        internal string Glyph;
        internal ThemeButton() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true); FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; BackColor = Color.Transparent; Cursor = Cursors.Hand; UseVisualStyleBackColor = false; }
        protected override void OnMouseDown(MouseEventArgs e) { Pressed = true; Invalidate(); if (Parent != null) Parent.Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { Pressed = false; Invalidate(); if (Parent != null) Parent.Invalidate(); base.OnMouseUp(e); }
        protected override void OnMouseLeave(EventArgs e) { Pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
        protected override void OnPaintBackground(PaintEventArgs e) { e.Graphics.Clear(Theme == null ? BackColor : Theme.Window); }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Window); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill = Primary ? Theme.Accent : Theme.Surface, foreground = Primary ? InstallerPaint.PrimaryText(Theme) : (Ghost ? Theme.Accent : Theme.Text);
            if (!Enabled) { fill = InstallerPaint.Blend(fill, Theme.Window, .45f); foreground = InstallerPaint.Blend(foreground, Theme.Window, .45f); }
            if (!Ghost) InstallerPaint.Fill(e.Graphics, ClientRectangle, Radius * ScaleFactor, fill);
            if (Pressed && !Ghost && Enabled) InstallerPaint.Elevation(e.Graphics, ClientRectangle, Radius * ScaleFactor, Theme, ScaleFactor, true);
            if (Glyph == "close") InstallerPaint.Icon(e.Graphics, "close", new RectangleF((Width - 13 * ScaleFactor) / 2, (Height - 13 * ScaleFactor) / 2, 13 * ScaleFactor, 13 * ScaleFactor), foreground, ScaleFactor);
            else {
                int iconWidth = String.IsNullOrEmpty(Glyph) ? 0 : (int)(30 * ScaleFactor);
                TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(0, 0, Width - iconWidth, Height), foreground, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.WordBreak);
                if (iconWidth > 0) InstallerPaint.Icon(e.Graphics, Glyph, new RectangleF(Width - 36 * ScaleFactor, (Height - 18 * ScaleFactor) / 2, 18 * ScaleFactor, 18 * ScaleFactor), foreground, ScaleFactor);
            }
            if (Focused && ShowFocusCues) using (GraphicsPath path = InstallerPaint.Rounded(new RectangleF(2 * ScaleFactor, 2 * ScaleFactor, Width - 4 * ScaleFactor, Height - 4 * ScaleFactor), Radius * ScaleFactor)) using (Pen pen = new Pen(Theme.Accent, 2 * ScaleFactor)) e.Graphics.DrawPath(pen, path);
        }
    }

    internal sealed class LargeCheckBox : CheckBox
    {
        internal InstallerThemeData Theme;
        internal float ScaleFactor = 1;
        internal LargeCheckBox() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true); AutoSize = false; BackColor = Color.Transparent; Cursor = Cursors.Hand; AccessibleRole = AccessibleRole.CheckButton; }
        protected override void OnCheckedChanged(EventArgs e) { base.OnCheckedChanged(e); Invalidate(); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Window);e.Graphics.SmoothingMode = SmoothingMode.AntiAlias; float box = 24 * ScaleFactor;
            RectangleF rectangle = new RectangleF(0, (Height - box) / 2, box, box);
            InstallerPaint.Fill(e.Graphics, rectangle, 2 * ScaleFactor, Checked ? Theme.Accent : Theme.Window);
            if (!Checked) using (Pen pen = new Pen(Theme.Muted, ScaleFactor)) using (GraphicsPath path = InstallerPaint.Rounded(new RectangleF(.5f * ScaleFactor, rectangle.Y + .5f * ScaleFactor, box - ScaleFactor, box - ScaleFactor), 2 * ScaleFactor)) e.Graphics.DrawPath(pen, path);
            else InstallerPaint.Icon(e.Graphics, "check", rectangle, InstallerPaint.PrimaryText(Theme), ScaleFactor);
            TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle((int)(36 * ScaleFactor), 0, Math.Max(1, Width - (int)(36 * ScaleFactor)), Height), Enabled ? Theme.Text : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            if (Focused && ShowFocusCues) using (Pen pen = new Pen(Theme.Accent, 2 * ScaleFactor)) { pen.DashStyle = DashStyle.Dot; e.Graphics.DrawRectangle(pen, ScaleFactor, ScaleFactor, Width - 2 * ScaleFactor, Height - 2 * ScaleFactor); }
        }
    }

    internal sealed class OrbitControl : Control
    {
        private readonly InstallerAssets assets;
        private bool animating;
        internal InstallerThemeData Theme;
        internal float ScaleFactor = 1;
        internal int? Percent;
        internal bool ConfirmedComplete;
        internal OrbitControl(InstallerAssets assets) { this.assets = assets; SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true); TabStop = false; AccessibleRole = AccessibleRole.Graphic; }
        internal bool Running { get { return animating; } }
        internal void Run(bool running)
        {
            if (animating == running) return;
            animating = running;
            if (running) ImageAnimator.Animate(assets.Gif, OnFrame); else ImageAnimator.StopAnimate(assets.Gif, OnFrame);
            Invalidate();
        }
        private void OnFrame(object sender, EventArgs e)
        { if (IsDisposed || !IsHandleCreated || !animating) return; try { BeginInvoke((Action)delegate { if (!IsDisposed && animating) Invalidate(); }); } catch (InvalidOperationException) { } }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Window); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias; e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            float scale = ScaleFactor; RectangleF photo = new RectangleF(12 * scale, 12 * scale, 280 * scale, 280 * scale);
            InstallerPaint.Elevation(e.Graphics, photo, 140 * scale, Theme, scale, false);
            GraphicsState saved = e.Graphics.Save(); using (GraphicsPath circle = new GraphicsPath()) { circle.AddEllipse(photo); e.Graphics.SetClip(circle); if (animating) ImageAnimator.UpdateFrames(assets.Gif); e.Graphics.DrawImage(animating ? assets.Gif : assets.Poster, photo); } e.Graphics.Restore(saved);
            RectangleF ring = new RectangleF(5 * scale, 5 * scale, 294 * scale, 294 * scale);
            using (Pen track = new Pen(Theme.Track, 6 * scale)) e.Graphics.DrawEllipse(track, ring);
            using (Pen fill = new Pen(Theme.Accent, 6 * scale)) {
                if (ConfirmedComplete) e.Graphics.DrawEllipse(fill, ring);
                else if (Percent.HasValue && Percent.Value > 0) { fill.StartCap = fill.EndCap = LineCap.Round; e.Graphics.DrawArc(fill, ring, -90, Math.Max(0, Math.Min(99, Percent.Value)) * 3.6f); }
            }
        }
        protected override void Dispose(bool disposing) { if (disposing) Run(false); base.Dispose(disposing); }
    }

    public sealed class InstallerForm : Form, IInstallerView
    {
        public event Action StartRequested, CancelRequested, CloseRequested, FinishRequested;
        private readonly InstallerAssets assets;
        private readonly ThemePanel header = new ThemePanel(), footer = new ThemePanel(), content = new ThemePanel();
        private readonly Panel viewport = new Panel();
        private readonly List<Control> dynamic = new List<Control>();
        private readonly List<Font> fonts = new List<Font>();
        private readonly List<ThemeButton> themeButtons = new List<ThemeButton>();
        private readonly OrbitControl orbit;
        private readonly ThemeButton closeButton = new ThemeButton();
        private InstallerThemeData theme = InstallerTheme.All[0];
        private float scale = 1;
        private string page = "welcome", phase = "正在准备安装", detail = "等待 Windows Installer 提供进度";
        private int? percent;
        private bool busy, terminal, canCancel, cancellationRequested, rollback, allowClose, startPending, reducedMotion;
        private volatile bool desktopSelected = true, launchSelected = true;
        private bool consent;
        private InstallerOutcome outcome = InstallerOutcome.Unknown;
        private InstallerSheet activeSheet;
        private ThemeButton primaryButton, secondaryButton;
        private LargeCheckBox consentBox, desktopBox, launchBox;
        private TextBlock liveLead, liveCaption, consentHelp;
        private Font phaseRegularFont, phaseBoldFont;
        private readonly List<TextBlock> phaseLabels = new List<TextBlock>();
        private readonly List<PhaseIcon> phaseIcons = new List<PhaseIcon>();
        private RectangleF pathCard;
        private int rightX, rightWidth;
        private volatile bool finishApproved;
        public bool CreateDesktopShortcut { get { return desktopSelected; } }
        public bool LaunchAfterInstall { get { return launchSelected; } }
        public bool FinishApproved { get { return finishApproved; } }

        public InstallerForm()
        {
            InstallerNative.PrepareThread();
            assets = new InstallerAssets(); orbit = new OrbitControl(assets);
            AutoScaleMode = AutoScaleMode.None; FormBorderStyle = FormBorderStyle.None; StartPosition = FormStartPosition.CenterScreen;
            Text = "SusuClash 安装程序"; Icon = assets.Icon; KeyPreview = true; BackColor = theme.Window; Padding = Padding.Empty;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
            header.Name = "installer-header"; footer.Name = "installer-footer"; content.Name = "installer-content"; viewport.Name = "installer-viewport"; viewport.AutoScroll = true; viewport.TabStop = false;
            Controls.Add(viewport); Controls.Add(header); Controls.Add(footer); viewport.Controls.Add(content); content.Controls.Add(orbit);
            closeButton.Name = "close"; closeButton.AccessibleName = "关闭安装程序"; closeButton.Glyph = "close"; closeButton.Radius = 9; closeButton.Click += delegate { RequestUserClose(); }; header.Controls.Add(closeButton);
            for (int index = 0; index < InstallerTheme.All.Length; index++) {
                InstallerThemeData choice = InstallerTheme.All[index]; ThemeButton button = new ThemeButton(); button.Name = "theme-" + choice.Key; button.Text = choice.Name; button.AccessibleName = choice.Name + "主题"; button.Raised = false; button.Ghost = true;
                button.Click += delegate { if (!busy && !startPending && page == "welcome") { theme = choice; Rebuild(); } }; themeButtons.Add(button); header.Controls.Add(button);
            }
            header.DrawContent = PaintHeader; footer.DrawContent = PaintFooter; content.DrawContent = PaintContent;
            header.MouseDown += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { InstallerNative.ReleaseCapture(); InstallerNative.SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); } };
            reducedMotion = InstallerNative.ReducedMotion(); SystemEvents.UserPreferenceChanged += PreferencesChanged;
            VisibleChanged += delegate { UpdateAnimation(); }; Resize += delegate { if (IsHandleCreated) Rebuild(); };
            ClientSize = new Size(760, 569);
        }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e); InstallerNative.SquareWindow(Handle); scale = InstallerNative.Scale(Handle);
            Rebuild();
        }
        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Rectangle working = Screen.FromHandle(Handle).WorkingArea;
            ClientSize = new Size(Math.Min(P(760), Math.Max(P(360), working.Width - P(32))), Math.Min(P(569), Math.Max(P(340), working.Height - P(32)))); Rebuild();
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x02E0 && IsHandleCreated) {
                scale = Math.Max(.75f, (message.WParam.ToInt32() & 0xffff) / 96f); Rebuild();
            }
            base.WndProc(ref message);
        }
        private int P(float value) { return (int)Math.Round(value * scale); }
        private Font MakeFont(float pixels, bool bold, string text = null)
        { Font font = new Font(InstallerTypography.Family(text), pixels * scale, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel); fonts.Add(font); return font; }
        private void Ui(Action action)
        {
            if (IsDisposed || Disposing) return;
            if (InvokeRequired) { try { Invoke(action); } catch (InvalidOperationException) { } } else action();
        }
        public void BeginInstall()
        {
            Ui(delegate { if (terminal || busy) return; busy = true; startPending = false; page = "installing"; phase = "正在准备安装"; detail = "等待 Windows Installer 提供进度"; percent = null; canCancel = true; CloseSheetFromEngine(); Rebuild(); });
        }
        public void UpdateProgress(ProgressSnapshot snapshot)
        {
            if (snapshot == null) return;
            Ui(delegate {
                if (terminal) return;
                string nextPhase = snapshot.Phase ?? "", nextDetail = snapshot.Detail ?? "";
                int? nextPercent = snapshot.Percent.HasValue ? (int?)Math.Max(0, Math.Min(99, snapshot.Percent.Value)) : null;
                if (phase == nextPhase && detail == nextDetail && percent == nextPercent && canCancel == snapshot.CanCancel && cancellationRequested == snapshot.CancellationRequested && rollback == snapshot.IsRollback) return;
                string previousPage = page;
                phase = nextPhase; detail = nextDetail; percent = nextPercent;
                canCancel = snapshot.CanCancel; cancellationRequested = snapshot.CancellationRequested; rollback = snapshot.IsRollback;
                if (busy) page = rollback ? "rollback" : cancellationRequested ? "cancelling" : "installing";
                if (page != previousPage) Rebuild(); else UpdateBusyPresentation();
            });
        }
        public void Complete(InstallerOutcome finalOutcome)
        {
            Ui(delegate {
                if (terminal) return;
                terminal = true; busy = false; startPending = false; canCancel = false; outcome = finalOutcome;
                page = finalOutcome == InstallerOutcome.Success ? "success" : finalOutcome == InstallerOutcome.RestartRequired ? "restart" : finalOutcome == InstallerOutcome.Cancelled ? "cancelled" : "failure";
                if (finalOutcome == InstallerOutcome.Success || finalOutcome == InstallerOutcome.RestartRequired) percent = 100;
                else if (percent.HasValue) percent = Math.Min(99, percent.Value);
                CloseSheetFromEngine(); Rebuild();
                if (primaryButton != null) primaryButton.Focus();
            });
        }
        public void CloseFromEngine() { Ui(delegate { allowClose = true; CloseSheetFromEngine(); Close(); }); }
        private void PreferencesChanged(object sender, UserPreferenceChangedEventArgs e) { Ui(delegate { reducedMotion = InstallerNative.ReducedMotion(); UpdateAnimation(); }); }
        private void UpdateAnimation() { if (orbit != null && !orbit.IsDisposed) orbit.Run(!reducedMotion && Visible && WindowState != FormWindowState.Minimized && (page == "welcome" || busy)); }
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!allowClose && e.CloseReason != CloseReason.WindowsShutDown && e.CloseReason != CloseReason.TaskManagerClosing) { e.Cancel = true; RequestUserClose(); }
            base.OnFormClosing(e);
        }
        private void RequestUserClose()
        {
            if (activeSheet != null) return;
            if (busy) { if (canCancel && !cancellationRequested && !rollback) ConfirmCancel(); return; }
            if (startPending) return;
            Action close = CloseRequested; if (close != null) close();
        }
        private void RequestFinish()
        {
            if (!terminal || busy) return;
            if (outcome == InstallerOutcome.Success) finishApproved = true;
            Action finish = FinishRequested; if (finish != null) finish();
        }
        private void ConfirmCancel()
        {
            if (!busy || !canCancel || cancellationRequested || rollback) return;
            bool confirmed = ShowSheet(false);
            if (!confirmed || !busy || !canCancel || rollback || terminal) return;
            cancellationRequested = true; canCancel = false; page = "cancelling"; Rebuild();
            Action cancel = CancelRequested; if (cancel != null) cancel();
        }
        private bool ShowSheet(bool license)
        {
            Control invoker = FocusedDescendant(this);
            using (InstallerSheet sheet = new InstallerSheet(theme, assets.License, license, scale)) {
                activeSheet = sheet;
                try { return sheet.ShowDialog(this) == DialogResult.OK; }
                finally { activeSheet = null; if (invoker != null && !invoker.IsDisposed && invoker.CanFocus) invoker.Focus(); }
            }
        }
        private void CloseSheetFromEngine() { if (activeSheet != null && !activeSheet.IsDisposed) { activeSheet.DialogResult = DialogResult.Cancel; activeSheet.Close(); } }
        private void Start()
        {
            if (!consent || busy || terminal || startPending) return;
            startPending = true; Rebuild(); Action start = StartRequested;
            if (start != null) start(); else { startPending = false; Rebuild(); }
        }
        private TextBlock AddText(string name, string text, float pixels, bool bold, Color color, int x, int y, int width, float lineSpacing)
        {
            TextBlock label = new TextBlock(); label.Name = name; label.Text = text; label.AccessibleName = text; label.Font = MakeFont(pixels, bold, text); label.ForeColor = color; label.LineSpacing = lineSpacing;
            label.SetBounds(x, y, width, label.NeededHeight(width)); content.Controls.Add(label); dynamic.Add(label); return label;
        }
        private ThemeButton Button(ThemePanel parent, string name, string text, bool primary, bool ghost, Action clicked)
        {
            ThemeButton button = new ThemeButton(); button.Name = name; button.Text = text; button.AccessibleName = text; button.Primary = primary; button.Ghost = ghost; button.Raised = !ghost; button.Theme = theme; button.BackColor=theme.Window;button.ScaleFactor = scale; button.Font = MakeFont(ghost ? InstallerTheme.CaptionPixels : InstallerTheme.BodyPixels, !ghost);
            button.Click += delegate { clicked(); }; parent.Controls.Add(button); dynamic.Add(button); return button;
        }
        private LargeCheckBox Check(string name, string text, bool value, int x, int y, int width, Action<bool> changed)
        {
            LargeCheckBox check = new LargeCheckBox(); check.Name = name; check.Text = text; check.AccessibleName = text; check.Theme = theme; check.ScaleFactor = scale; check.Font = MakeFont(InstallerTheme.BodyPixels, false); check.Checked = value; check.SetBounds(x, y, width, P(56)); check.CheckedChanged += delegate { changed(check.Checked); };
            content.Controls.Add(check); dynamic.Add(check); return check;
        }
        private void Rebuild()
        {
            if (Disposing || IsDisposed || !IsHandleCreated) return;
            SuspendLayout(); content.SuspendLayout(); header.SuspendLayout(); footer.SuspendLayout();
            Point scroll = viewport.AutoScrollPosition; string focusName = FocusedControlName(this);
            foreach (Control child in dynamic) { if (child.Parent != null) child.Parent.Controls.Remove(child); child.Dispose(); } dynamic.Clear();
            foreach (Font font in fonts) font.Dispose(); fonts.Clear();
            phaseLabels.Clear(); phaseIcons.Clear(); liveLead = liveCaption = consentHelp = null;
            BackColor = theme.Window; header.Theme = footer.Theme = content.Theme = theme; header.ScaleFactor = footer.ScaleFactor = content.ScaleFactor = scale; viewport.BackColor = theme.Window;
            int width = ClientSize.Width, headerHeight = P(InstallerTheme.TitlebarHeight), footerHeight = P(width / scale < 600 ? 114 : 86);
            header.SetBounds(0, 0, width, headerHeight); footer.SetBounds(0, ClientSize.Height - footerHeight, width, footerHeight); viewport.SetBounds(0, headerHeight, width, Math.Max(P(100), ClientSize.Height - headerHeight - footerHeight));
            closeButton.Theme = theme; closeButton.BackColor=theme.Window;closeButton.ScaleFactor = scale; closeButton.Font = MakeFont(12, false); closeButton.SetBounds(width - P(49), P(9), P(33), P(30)); closeButton.Enabled = !(busy && (!canCancel || cancellationRequested || rollback)) && !startPending;
            for (int i = 0; i < themeButtons.Count; i++) { ThemeButton choice = themeButtons[i]; choice.Theme = theme;choice.BackColor=theme.Window;choice.ScaleFactor = scale; choice.Font = MakeFont(12, theme.Key == InstallerTheme.All[i].Key); choice.Visible = page == "welcome"; choice.Enabled = !busy && !startPending; choice.SetBounds(width - P(202) + P(i * 46), P(9), P(42), P(30)); }
            bool needsScroll = page == "welcome" || viewport.ClientSize.Height < P(434) || width / scale < 600;
            int contentWidth = Math.Max(P(320), width - (needsScroll ? SystemInformation.VerticalScrollBarWidth : 0)); content.Width = contentWidth;
            bool stacked = contentWidth / scale < 600; int padding = P(stacked ? 18 : 26), top = P(32);
            rightX = stacked ? padding : padding + P(304 + 32); rightWidth = contentWidth - rightX - padding;
            orbit.Theme = theme; orbit.ScaleFactor = scale; orbit.Percent = page == "welcome" ? null : percent; orbit.ConfirmedComplete = terminal && (outcome == InstallerOutcome.Success || outcome == InstallerOutcome.RestartRequired);
            orbit.AccessibleName = page == "welcome" ? "小猫圆窗" : "安装进度 " + (percent.HasValue ? percent.Value + "%" : "等待引擎进度");
            int orbTop = top, y = top + (stacked ? P(384) : 0);
            int stage = page == "welcome" ? 1 : busy ? 2 : 3;
            DrawStepsControls(stage, rightX, y); y += P(48);
            string title, lead;
            if (page == "welcome") { title = "准备安装"; lead = "把 SusuClash 装到这台电脑，\n开始管理代理与检查 Codex 网络。"; }
            else if (page == "success") { title = "安装成功"; lead = "SusuClash 已准备就绪。\n可以开始使用了。"; }
            else if (page == "restart") { title = "安装完成，需要重启"; lead = "Windows 报告需要重启，\n才能完成这次安装。"; }
            else if (page == "cancelled") { title = "安装已取消"; lead = "本次安装没有完成。\n需要时，可以重新运行安装程序。"; }
            else if (page == "failure") { title = outcome == InstallerOutcome.Unknown ? "安装结果尚未确认" : "安装未完成"; lead = outcome == InstallerOutcome.Unknown ? "未收到可确认的最终安装结果。\n请查看 Windows Installer 的提示。" : "这次安装没有完成。\n请查看 Windows Installer 的提示。"; }
            else if (page == "rollback") { title = "正在回滚安装"; lead = "Windows Installer 正在撤回本次变更。\n请保持窗口打开。"; }
            else if (page == "cancelling") { title = "正在取消安装"; lead = "等待当前步骤安全结束，\n再由安装引擎处理必要的回滚。"; }
            else { title = "正在安装 SusuClash"; lead = CurrentInstallationLine() + "\n请保持窗口打开，稍等一会儿。"; }
            TextBlock titleLabel = AddText("page-title", title, InstallerTheme.TitlePixels, true, theme.Text, rightX, y, rightWidth, 1.3f); y += titleLabel.Height + P(18);
            TextBlock leadLabel = AddText("page-lead", lead, InstallerTheme.BodyPixels, false, theme.Text, rightX, y, rightWidth, 1.7f); liveLead = leadLabel; y += leadLabel.Height + P(18); pathCard = RectangleF.Empty;
            if (page == "welcome") {
                int cardHeight = P(82); pathCard = new RectangleF(rightX, y, rightWidth, cardHeight);
                AddText("path-label", "安装位置 · 当前用户", 12, false, theme.Muted, rightX + P(18), y + P(18), rightWidth - P(36), 1.5f);
                AddText("install-path", "%LOCALAPPDATA%\\Programs\\ClashGlass", 12, false, theme.Text, rightX + P(18), y + P(44), rightWidth - P(36), 1.5f); y += cardHeight + P(18);
                desktopBox = Check("desktop", "创建桌面快捷方式", desktopSelected, rightX, y, rightWidth, delegate(bool value) { desktopSelected = value; }); y += P(56);
                int consentWidth = rightWidth >= P(350) ? P(218) : rightWidth;
                consentBox = Check("consent", "我已阅读并接受许可协议", consent, rightX, y, consentWidth, delegate(bool value) { consent = value; if (primaryButton != null) primaryButton.Enabled = consent && !startPending;if(consentHelp!=null){consentHelp.Text=consent?"准备好了，可以开始安装。":"请先阅读并接受许可协议。";consentHelp.Invalidate();} });
                ThemeButton license = Button(content, "license", "查看 GPL-3.0 许可协议", false, true, delegate { if (ShowSheet(true)) { consent = true; if (consentBox != null && !consentBox.IsDisposed) consentBox.Checked = true; } });
                if (consentWidth < rightWidth) license.SetBounds(rightX + consentWidth + P(6), y + P(10), rightWidth - consentWidth - P(6), P(36));
                else { y += P(56); license.SetBounds(rightX + P(36), y, rightWidth - P(36), P(30)); }
                y += P(56); TextBlock help = AddText("consent-help", consent ? "准备好了，可以开始安装。" : "请先阅读并接受许可协议。", 12, false, theme.Muted, rightX, y, rightWidth, 1.5f);consentHelp=help; y += help.Height;
            } else if (page == "success") {
                y = ListLine("应用文件已就位", "check", false, y); y = ListLine("开始菜单入口已创建", "check", false, y);
                if (desktopSelected) y = ListLine("桌面快捷方式已创建", "check", false, y);
                y += P(6); launchBox = Check("launch", "完成后打开 SusuClash", launchSelected, rightX, y, rightWidth, delegate(bool value) { launchSelected = value; if (primaryButton != null) primaryButton.Text = value ? "完成并打开" : "完成"; }); y += P(56 + 12);
                TextBlock note = AddText("success-help", "打开后，点击首页动物大圆开始检查。", 12, false, theme.Muted, rightX, y, rightWidth, 1.7f); y += note.Height;
            } else if (busy) {
                phaseRegularFont = MakeFont(14,false); phaseBoldFont = MakeFont(14,true);
                string[] stageText, stageGlyph; bool[] muted;
                CurrentStages(out stageText, out stageGlyph, out muted);
                for (int i = 0; i < 3; i++) {
                    TextBlock label = AddText("install-stage-" + i, stageText[i], 14, i == CurrentStage() && page == "installing", muted[i] ? theme.Muted : theme.Text, rightX + P(30), y, rightWidth - P(30), 1.5f);
                    PhaseIcon icon = new PhaseIcon(); icon.Glyph = stageGlyph[i]; icon.Theme = theme; icon.ScaleFactor = scale; icon.Muted = muted[i]; icon.SetBounds(rightX,y+P(1),P(18),P(18)); content.Controls.Add(icon); dynamic.Add(icon); phaseLabels.Add(label); phaseIcons.Add(icon); y += label.Height + P(18);
                }
            } else {
                string message = page == "restart" ? "请先保存工作，之后手动重启电脑。\n不会倒计时或自动重启。" : page == "cancelled" ? "安装引擎已结束本次安装。\n不默认声称所有系统状态均已恢复。" : outcome == InstallerOutcome.Unknown ? "安装引擎已结束，但结果尚未确认。\n可以关闭窗口，查看 Windows Installer 的提示。" : "安装引擎已结束本次安装。需要重试时，\n请关闭本窗口后重新运行安装程序。";
                TextBlock note = AddText("result-help", message, 12, false, theme.Muted, rightX, y, rightWidth, 1.7f); y += note.Height;
            }
            int requiredHeight = Math.Max(y + P(32), P(434));
            if (!stacked) orbTop = Math.Max(P(32), (requiredHeight - P(367)) / 2);
            orbit.SetBounds(stacked ? (contentWidth - P(304)) / 2 : padding, orbTop, P(304), P(304));
            string caption = page == "welcome" ? "你好，我们一起出发。" : (percent.HasValue ? percent.Value + "%" : "—") + " · " + (page == "success" || page == "restart" ? "安装完成" : page == "rollback" ? "正在回滚" : page == "cancelling" ? "正在取消" : page == "cancelled" ? "安装已取消" : page == "failure" ? (outcome==InstallerOutcome.Unknown?"结果待确认":"安装未完成") : "正在安装");
            TextBlock captionLabel = AddText("orbit-caption", caption, 14, false, theme.Text, orbit.Left, orbTop + P(316), P(304), 1.5f); captionLabel.Centered = true; liveCaption = captionLabel;
            TextBlock version = AddText("orbit-version", "SusuClash · Windows x64", 12, false, theme.Muted, orbit.Left, orbTop + P(349), P(304), 1.5f); version.Centered = true;
            content.Height = Math.Max(viewport.ClientSize.Height, requiredHeight); viewport.AutoScrollMinSize = new Size(0, content.Height);
            BuildFooter(width, footerHeight); content.ResumeLayout(false); header.ResumeLayout(false); footer.ResumeLayout(false); ResumeLayout(false);
            viewport.AutoScrollPosition = new Point(Math.Abs(scroll.X), Math.Abs(scroll.Y)); header.Invalidate(); footer.Invalidate(); content.Invalidate(); orbit.Invalidate(); UpdateAnimation();
            if (!String.IsNullOrEmpty(focusName)) { Control[] found = Controls.Find(focusName,true); if (found.Length > 0 && found[0].CanFocus) found[0].Focus(); }
        }
        private static string FocusedControlName(Control parent)
        { Control focused=FocusedDescendant(parent);return focused==null?null:focused.Name; }
        private static Control FocusedDescendant(Control parent)
        { foreach(Control child in parent.Controls){if(child.Focused)return child;if(child.ContainsFocus)return FocusedDescendant(child);}return null; }
        private int CurrentStage()
        {
            if (detail.IndexOf("复制",StringComparison.Ordinal)>=0) return 1;
            if (detail.IndexOf("创建",StringComparison.Ordinal)>=0 || detail.IndexOf("保存",StringComparison.Ordinal)>=0 || detail.IndexOf("提交",StringComparison.Ordinal)>=0) return 2;
            return 0;
        }
        private string CurrentInstallationLine()
        { return String.IsNullOrEmpty(detail) || detail.StartsWith("等待",StringComparison.Ordinal) ? "正在准备安装文件。" : detail.TrimEnd('。','.') + "。"; }
        private void CurrentStages(out string[] text,out string[] glyph,out bool[] muted)
        {
            int stage = CurrentStage();
            if (rollback || cancellationRequested) { text=new string[]{rollback?"正在撤回本次安装变更":"正在等待当前步骤结束","请保持窗口打开","等待安装引擎确认结果"};glyph=new string[]{"clock","clock","clock"};muted=new bool[]{false,true,true};return; }
            text=new string[]{stage>0?"安装文件已准备好":"正在准备安装文件",stage==1?detail:stage>1?"应用文件复制步骤已结束":"等待复制应用文件",stage==2?detail:"等待完成安装设置"};
            glyph=new string[]{stage>0?"check":"download",stage==1?"download":stage>1?"check":"clock",stage==2?"download":"clock"};muted=new bool[]{false,stage<1,stage<2};
        }
        private void UpdateBusyPresentation()
        {
            orbit.Percent = percent; orbit.AccessibleName = "安装进度 " + (percent.HasValue ? percent.Value+"%" : "等待进度"); orbit.Invalidate();
            if (liveCaption != null) { liveCaption.Text = (percent.HasValue ? percent.Value+"%" : "—") + " · " + (rollback?"正在回滚":cancellationRequested?"正在取消":"正在安装");liveCaption.Invalidate(); }
            if (liveLead != null && page == "installing") { liveLead.Text=CurrentInstallationLine()+"\n请保持窗口打开，稍等一会儿。";liveLead.Invalidate(); }
            string[] text,glyph;bool[] muted;CurrentStages(out text,out glyph,out muted);
            for(int i=0;i<phaseLabels.Count;i++){phaseLabels[i].Text=text[i];phaseLabels[i].Font=page=="installing"&&i==CurrentStage()?phaseBoldFont:phaseRegularFont;phaseLabels[i].ForeColor=muted[i]?theme.Muted:theme.Text;phaseLabels[i].Invalidate();phaseIcons[i].Glyph=glyph[i];phaseIcons[i].Muted=muted[i];phaseIcons[i].Invalidate();}
            if (secondaryButton != null) { secondaryButton.Enabled=canCancel&&!cancellationRequested&&!rollback;secondaryButton.Text=cancellationRequested||rollback?"等待安全结束…":"取消安装";secondaryButton.Invalidate(); }
            closeButton.Enabled=!(busy&&(!canCancel||cancellationRequested||rollback));footer.Invalidate();
        }
        private int ListLine(string text, string glyph, bool muted, int y)
        {
            TextBlock label = AddText("phase-" + y, text, 14, false, muted ? theme.Muted : theme.Text, rightX + P(30), y, rightWidth - P(30), 1.5f);
            PhaseIcon icon = new PhaseIcon(); icon.Glyph = glyph; icon.Theme = theme; icon.ScaleFactor = scale; icon.SetBounds(rightX, y + P(1), P(18), P(18)); content.Controls.Add(icon); dynamic.Add(icon); return y + label.Height + P(12);
        }
        private void DrawStepsControls(int stage, int x, int y)
        {
            string[] names = { "准备", "安装", "结果" }; int cursor = x;
            for (int i = 0; i < names.Length; i++) {
                StepControl step = new StepControl(); step.Theme = theme; step.ScaleFactor = scale; step.Number = i + 1; step.Selected = stage == i + 1; step.Text = names[i]; step.Font = MakeFont(12, step.Selected); step.SetBounds(cursor, y, P(64), P(24)); step.AccessibleName = names[i] + (step.Selected ? "，当前阶段" : ""); content.Controls.Add(step); dynamic.Add(step); cursor += P(82);
            }
        }
        private void BuildFooter(int width, int height)
        {
            bool stacked = width / scale < 600; int padding = P(stacked ? 18 : 26), y = stacked ? P(48) : P(19);
            primaryButton = secondaryButton = null;
            if (page == "welcome") {
                secondaryButton = Button(footer, "close-install", "取消", false, false, RequestUserClose);
                primaryButton = Button(footer, "start", startPending ? "等待安装引擎…" : "开始安装", true, false, Start); primaryButton.Glyph = "arrow"; primaryButton.Enabled = consent && !startPending;
            } else if (busy) {
                secondaryButton = Button(footer, "cancel-install", cancellationRequested || rollback ? "等待安全结束…" : "取消安装", false, false, ConfirmCancel); secondaryButton.Enabled = canCancel && !cancellationRequested && !rollback;
            } else primaryButton = Button(footer, "finish", page == "success" ? (launchSelected ? "完成并打开" : "完成") : page == "restart" ? "稍后重启" : "关闭", true, false, RequestFinish);
            int primaryWidth = P(144), secondaryWidth = P(busy ? 144 : 76), gap = P(12);
            if (primaryButton != null) primaryButton.SetBounds(width - padding - primaryWidth, y, primaryWidth, P(48));
            if (secondaryButton != null) secondaryButton.SetBounds(width - padding - secondaryWidth - (primaryButton == null ? 0 : primaryWidth + gap), y, secondaryWidth, P(48));
            if (primaryButton != null && page == "success" && launchSelected) primaryButton.Glyph = "arrow";
        }
        private void PaintHeader(Graphics graphics)
        {
            graphics.DrawIcon(assets.Icon, new Rectangle(P(16), P(13), P(22), P(22)));
            using (Font font = new Font(InstallerTypography.Family("安装程序"), 12*scale, FontStyle.Bold, GraphicsUnit.Pixel)) TextRenderer.DrawText(graphics, "SusuClash 安装程序", font, new Rectangle(P(46), 0, P(210), header.Height), theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            using (Pen pen = new Pen(InstallerPaint.Blend(theme.Muted, theme.Window, .22f), Math.Max(1, scale))) graphics.DrawLine(pen, 0, header.Height - 1, header.Width, header.Height - 1);
        }
        private void PaintFooter(Graphics graphics)
        {
            using (Pen pen = new Pen(InstallerPaint.Blend(theme.Muted, theme.Window, .20f), Math.Max(1, scale))) graphics.DrawLine(pen, 0, 0, footer.Width, 0);
            string text = page == "welcome" ? "仅为当前 Windows 用户安装" : busy ? "正在进行安装，请保持窗口打开" : page == "success" ? "一切就绪，欢迎使用 SusuClash" : page == "restart" ? "重启前请先保存工作" : "可以关闭窗口，稍后再试";
            bool stacked = footer.Width / scale < 600;
            using (Font font = new Font(InstallerTypography.Family(text), 12 * scale, FontStyle.Regular, GraphicsUnit.Pixel)) TextRenderer.DrawText(graphics, text, font, new Rectangle(P(stacked ? 18 : 26), stacked ? P(10) : 0, stacked ? footer.Width - P(36) : P(320), stacked ? P(28) : footer.Height), theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | (stacked ? TextFormatFlags.HorizontalCenter : TextFormatFlags.Left));
        }
        private void PaintContent(Graphics graphics)
        {
            if (!pathCard.IsEmpty) { InstallerPaint.Elevation(graphics, pathCard, InstallerTheme.PanelRadius * scale, theme, scale, false); InstallerPaint.Fill(graphics, pathCard, InstallerTheme.PanelRadius * scale, theme.Surface); }
        }
#if INSTALLER_QA
        internal void HarnessTheme(string key) { foreach (InstallerThemeData choice in InstallerTheme.All) if (choice.Key == key) { theme = choice; Rebuild(); return; } throw new ArgumentException("Unknown theme"); }
        internal void HarnessConsent() { if (consentBox != null) consentBox.Checked = true; }
        internal void HarnessReducedMotion(bool reduced) { reducedMotion = reduced; UpdateAnimation(); }
        internal void HarnessSize(int width, int height) { ClientSize = new Size(P(width), P(height)); Rebuild(); }
        internal string HarnessMetrics()
        {
            return "{\"theme\":\"" + theme.Key + "\",\"page\":\"" + page + "\",\"scale\":" + scale.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"width\":" + ClientSize.Width + ",\"height\":" + ClientSize.Height + ",\"ringWidth\":" + orbit.Width + ",\"imageDiameter\":" + P(280) + ",\"stroke\":" + (6 * scale).ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"checkbox\":" + P(24) + ",\"checkRow\":" + P(56) + ",\"smallText\":" + (12 * scale).ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"running\":" + orbit.Running.ToString().ToLowerInvariant() + ",\"busy\":" + busy.ToString().ToLowerInvariant() + ",\"percent\":" + (percent.HasValue ? percent.Value.ToString() : "null") + "}";
        }
        internal bool HarnessBusy { get { return busy; } }
        internal ThemeButton HarnessPrimary { get { return primaryButton; } }
        internal ThemeButton HarnessCancel { get { return secondaryButton; } }
        internal OrbitControl HarnessOrbit { get { return orbit; } }
        internal void HarnessLicense() { Control[] license=Controls.Find("license",true);if(license.Length>0){license[0].Focus();((Button)license[0]).PerformClick();} }
        internal bool HarnessCheckShortScroll()
        {
            Control target = launchBox != null && !launchBox.IsDisposed ? (Control)launchBox : consentBox;
            if (target == null || target.IsDisposed) return false;
            int before = footer.Top; viewport.ScrollControlIntoView(target);
            Rectangle visible = viewport.RectangleToScreen(viewport.ClientRectangle), actual = target.RectangleToScreen(target.ClientRectangle);
            return footer.Top == before && actual.Top >= visible.Top && actual.Bottom <= visible.Bottom && content.Height > viewport.ClientSize.Height;
        }
#endif
        protected override void Dispose(bool disposing)
        {
            if (disposing) { SystemEvents.UserPreferenceChanged -= PreferencesChanged; orbit.Run(false); foreach (Font font in fonts) font.Dispose(); fonts.Clear(); assets.Dispose(); }
            base.Dispose(disposing);
        }
    }

    internal sealed class PhaseIcon : Control
    {
        internal InstallerThemeData Theme; internal string Glyph; internal float ScaleFactor; internal bool Muted;
        internal PhaseIcon() { SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true); BackColor = Color.Transparent; TabStop = false; }
        protected override void OnPaint(PaintEventArgs e) { e.Graphics.SmoothingMode = SmoothingMode.AntiAlias; InstallerPaint.Icon(e.Graphics, Glyph, ClientRectangle, Muted ? Theme.Muted : Theme.Accent, ScaleFactor); }
    }
    internal sealed class StepControl : Control
    {
        internal InstallerThemeData Theme; internal float ScaleFactor; internal int Number; internal bool Selected;
        internal StepControl() { SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true); BackColor = Color.Transparent; TabStop = false; AccessibleRole = AccessibleRole.StaticText; }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias; RectangleF circle = new RectangleF(0, 0, 24 * ScaleFactor, 24 * ScaleFactor);
            InstallerPaint.Fill(e.Graphics, circle, 12 * ScaleFactor, Theme.Surface); InstallerPaint.Elevation(e.Graphics, circle, 12 * ScaleFactor, Theme, ScaleFactor, !Selected);
            TextRenderer.DrawText(e.Graphics, Number.ToString(), Font, Rectangle.Round(circle), Selected ? Theme.Accent : Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle((int)(32 * ScaleFactor),0,Width-(int)(32*ScaleFactor),Height), Selected ? Theme.Text : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }

    internal sealed class InstallerSheet : Form
    {
        private readonly ThemePanel panel = new ThemePanel();
        private readonly InstallerThemeData theme;
        private readonly float scale;
        private readonly bool license;
        private readonly RichTextBox text;
        private readonly ThemeButton confirm, dismiss, close;
        private RectangleF licenseBox;
        private readonly List<Font> fonts = new List<Font>();
        private int P(float value) { return (int)Math.Round(value * scale); }
        private Font FontFor(float pixels, bool bold, bool cjk = true) { Font font = new Font(InstallerTypography.Family(cjk ? null : "GPL"), pixels * scale, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel); fonts.Add(font); return font; }
        internal InstallerSheet(InstallerThemeData theme, string licenseText, bool license, float scale)
        {
            this.theme = theme; this.scale = scale; this.license = license; AutoScaleMode = AutoScaleMode.None; FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; BackColor = theme.Window; KeyPreview = true;
            AccessibleName = license ? "GNU GPL v3 许可协议" : "取消安装确认"; Text = AccessibleName;
            panel.Theme = theme; panel.ScaleFactor = scale; panel.Dock = DockStyle.Fill; Controls.Add(panel);
            int width = P(520), screenHeight = Screen.PrimaryScreen.WorkingArea.Height; ClientSize = new Size(width, Math.Min(P(license ? 480 : 280), screenHeight - P(32)));
            panel.DrawContent = delegate(Graphics graphics) { InstallerPaint.Fill(graphics, panel.ClientRectangle, InstallerTheme.SheetRadius * scale, theme.Window);if(!licenseBox.IsEmpty)InstallerPaint.Fill(graphics,licenseBox,InstallerTheme.PanelRadius*scale,theme.Surface); };
            TextBlock title = new TextBlock(); title.Text = license ? "GNU GPL v3 许可协议" : "要取消这次安装吗？"; title.Font = FontFor(20, true); title.ForeColor = theme.Text; title.LineSpacing = 1.3f; title.Name = "sheet-title"; panel.Controls.Add(title);
            close = MakeButton("sheet-close", "", false); close.Glyph = "close"; close.Radius = 9; close.AccessibleName = "关闭对话框"; close.DialogResult = DialogResult.Cancel;
            TextBlock copy = new TextBlock(); copy.Name = "sheet-copy"; copy.Text = license ? "应用采用 GPL-3.0-only。以下为完整许可原文，可独立滚动阅读。" : "正在写入的步骤会先结束，再由 Windows Installer 处理本次安装的必要回滚。\n需要安装引擎确认后才会退出，不会直接关掉正在运行的安装。"; copy.Font = FontFor(14, false); copy.ForeColor = theme.Text; copy.LineSpacing = 1.7f; panel.Controls.Add(copy);
            if (license) { text = new RichTextBox(); text.Name = "license-text"; text.AccessibleName = "完整 GNU GPL v3 许可协议，可滚动阅读"; text.ReadOnly = true; text.DetectUrls = false; text.AcceptsTab = false; text.BorderStyle = BorderStyle.None; text.BackColor = theme.Surface; text.ForeColor = theme.Text; text.Font = FontFor(12, false, false); text.Text = licenseText; text.ScrollBars = RichTextBoxScrollBars.Vertical; text.WordWrap = true; panel.Controls.Add(text); }
            dismiss = MakeButton("sheet-dismiss", license ? "返回" : "取消安装", false); dismiss.DialogResult = license ? DialogResult.Cancel : DialogResult.OK;
            confirm = MakeButton("sheet-confirm", license ? "我已阅读并接受" : "继续安装", true); confirm.DialogResult = license ? DialogResult.OK : DialogResult.Cancel;
            AcceptButton = confirm; CancelButton = license ? dismiss : confirm;
            Shown += delegate { Rectangle owner = Owner == null ? Screen.FromControl(this).WorkingArea : Owner.RectangleToScreen(Owner.ClientRectangle); int w = Math.Min(P(520), owner.Width - P(32)); int h = Math.Min(ClientSize.Height, owner.Height - P(32)); ClientSize = new Size(Math.Max(P(280), w), Math.Max(P(240), h)); Location = new Point(owner.Left + (owner.Width - Width) / 2, owner.Top + (owner.Height - Height) / 2); LayoutSheet(title, copy); confirm.Focus(); };
        }
        private ThemeButton MakeButton(string name, string label, bool primary)
        { ThemeButton button = new ThemeButton(); button.Name = name; button.Text = label; button.AccessibleName = label; button.Theme = theme;button.BackColor=theme.Window;button.ScaleFactor = scale; button.Primary = primary; button.Font = FontFor(14, true); panel.Controls.Add(button); return button; }
        private void LayoutSheet(TextBlock title, TextBlock copy)
        {
            int padding = P(24), width = ClientSize.Width; title.SetBounds(padding, padding, width - padding * 2 - P(49), title.NeededHeight(width - padding * 2 - P(49)));
            close.SetBounds(width - padding - P(33), padding, P(33), P(30)); int y = title.Bottom + P(18); copy.SetBounds(padding, y, width - padding * 2, copy.NeededHeight(width - padding * 2)); y = copy.Bottom + P(18);
            int buttonHeight = P(width / scale < 380 ? 64 : 48), buttonY = ClientSize.Height - padding - buttonHeight;
            if (text != null) {licenseBox=new RectangleF(padding,y,width-padding*2,Math.Max(P(76),buttonY-P(24)-y));text.SetBounds(padding+P(18),y+P(18),width-padding*2-P(36),Math.Max(P(40),(int)licenseBox.Height-P(36)));}
            dismiss.SetBounds(padding, buttonY, Math.Max(1, (width - padding * 2 - P(12)) / 2), buttonHeight); confirm.SetBounds(dismiss.Right + P(12), buttonY, width - padding - dismiss.Right - P(12), buttonHeight);
            using (GraphicsPath path = InstallerPaint.Rounded(new RectangleF(0,0,Width,Height),InstallerTheme.SheetRadius*scale)) { Region previous = Region; Region = new Region(path); if (previous != null) previous.Dispose(); }
            panel.Invalidate();
        }
        protected override bool ProcessCmdKey(ref Message message, Keys keyData)
        {
            if (keyData == Keys.Tab || keyData == (Keys.Shift | Keys.Tab)) { SelectNextControl(ActiveControl, keyData == Keys.Tab, true, true, true); return true; }
            return base.ProcessCmdKey(ref message, keyData);
        }
#if INSTALLER_QA
        internal bool HarnessKey(Keys keys) { Message message = new Message(); return keys == Keys.Escape ? ProcessDialogKey(keys) : ProcessCmdKey(ref message,keys); }
        internal RichTextBox LicenseControl { get { return text; } }
        internal ThemeButton ConfirmControl { get { return confirm; } }
        internal ThemeButton DismissControl { get { return dismiss; } }
#endif
        protected override void Dispose(bool disposing) { if (disposing) foreach (Font font in fonts) font.Dispose(); base.Dispose(disposing); }
    }


}
