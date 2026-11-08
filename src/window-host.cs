// SusuClash's local WebView2 window. Browser profiles are supplied by the
// parent process and are isolated from the user's Edge installation.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class SusuWindow : Form
{
    private const int WM_NCHITTEST = 0x84, WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12,
        HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out NativeRect rect);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr h, out NativeRect rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr h, ref Point p);

    private readonly Uri root;
    private readonly string profile;
    private readonly int parentId;
    private readonly WebView2 browser = new WebView2();
    private readonly Timer parentMonitor = new Timer();
    private bool testMode;
    private int exitCode;
    private int lastTitleDown;
    private Point lastTitlePoint;

    private SusuWindow(Uri root, string profile, int parentId, bool testMode)
    {
        this.root = root; this.profile = profile; this.parentId = parentId; this.testMode = testMode;
        Text = "SusuClash";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(466, 850);
        MinimumSize = new Size(360, 600);
        BackColor = ColorTranslator.FromHtml("#f3eaf0");
        Padding = new Padding(5);
        KeyPreview = true;
        try { Icon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "app", "icon.ico")); } catch { }
        browser.Dock = DockStyle.Fill;
        Controls.Add(browser);
        if (testMode) { ShowInTaskbar = false; Opacity = 0; }
        Shown += async delegate { await StartBrowser(); };
        Resize += delegate { SendState(); };
        parentMonitor.Interval = 2000;
        parentMonitor.Tick += delegate { try { if (Process.GetProcessById(parentId).HasExited) Close(); } catch { Close(); } };
        parentMonitor.Start();
    }

    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.Style |= 0x00040000 | 0x00010000 | 0x00020000 | 0x00080000; return cp; }
    }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try { int noCorners = 1; DwmSetWindowAttribute(Handle, 33, ref noCorners, sizeof(int)); } catch { }
    }
    protected override void WndProc(ref Message m)
    {
        // WS_THICKFRAME keeps native resizing and Win+arrow support; extend the
        // client area over its non-client frame so it cannot draw a black rim.
        if (m.Msg == 0x0083) { m.Result = IntPtr.Zero; return; }
        if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal) {
            base.WndProc(ref m);
            int packed = unchecked((int)m.LParam.ToInt64());
            var p = PointToClient(new Point(unchecked((short)(packed & 0xffff)), unchecked((short)((packed >> 16) & 0xffff))));
            const int border = 6;
            bool left = p.X < border, right = p.X >= ClientSize.Width - border;
            bool top = p.Y < border, bottom = p.Y >= ClientSize.Height - border;
            int hit = top ? (left ? HTTOPLEFT : right ? HTTOPRIGHT : HTTOP) : bottom ? (left ? HTBOTTOMLEFT : right ? HTBOTTOMRIGHT : HTBOTTOM) : left ? HTLEFT : right ? HTRIGHT : 0;
            if (hit != 0) m.Result = (IntPtr)hit;
            return;
        }
        base.WndProc(ref m);
    }
    private bool IsLocal(string value)
    {
        Uri u;
        return Uri.TryCreate(value, UriKind.Absolute, out u) && u.Scheme == "http" &&
            u.Host == "127.0.0.1" && u.Port == root.Port && u.UserInfo.Length == 0 &&
            u.AbsolutePath.StartsWith(root.AbsolutePath, StringComparison.Ordinal);
    }
    private static bool AllowedExternal(string value)
    {
        Uri u;
        if (!Uri.TryCreate(value, UriKind.Absolute, out u) || u.Scheme != "https" || !u.IsDefaultPort || u.UserInfo.Length != 0) return false;
        if (u.Host.Equals("susu5.cn", StringComparison.OrdinalIgnoreCase)) return u.AbsolutePath == "/";
        if (!u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)) return false;
        string path = u.AbsolutePath.TrimEnd('/');
        return (path.Equals("/susu5", StringComparison.OrdinalIgnoreCase) ||
                path.Equals("/susu5/SusuClash/releases", StringComparison.OrdinalIgnoreCase)) &&
               u.Query.Length == 0 && u.Fragment.Length == 0;
    }
    private static void OpenExternal(string value)
    {
        if (!AllowedExternal(value)) return;
        try { Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); }
        catch { MessageBox.Show("无法打开系统默认浏览器，请检查 Windows 默认应用设置。", "SusuClash", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }
    private void SendState()
    {
        if (browser.CoreWebView2 == null || !IsLocal(browser.Source == null ? "" : browser.Source.AbsoluteUri)) return;
        browser.CoreWebView2.PostWebMessageAsString(WindowState == FormWindowState.Maximized ? "window:state:maximized" : "window:state:normal");
    }
    private void ToggleMaximize()
    {
        if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
        else { MaximizedBounds = Screen.FromControl(this).WorkingArea; WindowState = FormWindowState.Maximized; }
        SendState();
    }
    private void SendCaptionDrag()
    {
        Point cursor = Cursor.Position;
        int coordinates = unchecked((cursor.Y << 16) | (cursor.X & 0xffff));
        ReleaseCapture(); SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, (IntPtr)coordinates);
    }
    private void RestoreAndDrag()
    {
        if (WindowState != FormWindowState.Maximized) return;
        Point cursor = Cursor.Position;
        var bounds = Bounds;
        double ratio = bounds.Width > 0 ? Math.Max(0, Math.Min(1, (double)(cursor.X - bounds.Left) / bounds.Width)) : .5;
        WindowState = FormWindowState.Normal;
        Location = new Point(cursor.X - (int)(Width * ratio), cursor.Y - Math.Min(20, Height / 2));
        lastTitleDown = 0;
        if (!testMode) SendCaptionDrag();
        SendState();
    }
    private void HandleTitleDown()
    {
        int now = Environment.TickCount;
        Point cursor = testMode ? Point.Empty : Cursor.Position;
        var size = SystemInformation.DoubleClickSize;
        bool doubleClick = lastTitleDown != 0 && unchecked((uint)(now - lastTitleDown)) <= (uint)SystemInformation.DoubleClickTime &&
            Math.Abs(cursor.X - lastTitlePoint.X) <= size.Width && Math.Abs(cursor.Y - lastTitlePoint.Y) <= size.Height;
        if (doubleClick) { lastTitleDown = 0; ToggleMaximize(); return; }
        lastTitleDown = now; lastTitlePoint = cursor;
        if (WindowState == FormWindowState.Normal && !testMode) {
            var before = Location;
            SendCaptionDrag();
            // A genuine drag is never the first half of a double-click.
            if (Location != before) lastTitleDown = 0;
        }
    }
    private async Task StartBrowser()
    {
        try {
            var options = new CoreWebView2EnvironmentOptions();
            options.AllowSingleSignOnUsingOSPrimaryAccount = false;
            options.AdditionalBrowserArguments = "--no-proxy-server --disable-background-networking";
            var environment = await CoreWebView2Environment.CreateAsync(null, profile, options);
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                if (!IsLocal(e.Uri)) { e.Cancel = true; OpenExternal(e.Uri); }
            };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; OpenExternal(e.Uri); };
            core.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs e) {
                if (e.ProcessFailedKind != CoreWebView2ProcessFailedKind.BrowserProcessExited && e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessExited) return;
                exitCode = testMode ? 1 : 11;
                if (!testMode) MessageBox.Show("窗口进程异常退出，请重新打开 SusuClash。", "SusuClash", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            };
            core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
                if (!IsLocal(e.Source)) return;
                string message; try { message = e.TryGetWebMessageAsString(); } catch { return; }
                switch (message) {
                    case "window:minimize": WindowState = FormWindowState.Minimized; break;
                    case "window:maximize": ToggleMaximize(); break;
                    case "window:close": Close(); break;
                    case "window:drag": HandleTitleDown(); break;
                    case "window:restore-drag": RestoreAndDrag(); break;
                    case "theme:cat": BackColor = ColorTranslator.FromHtml("#f3eaf0"); break;
                    case "theme:fish": BackColor = ColorTranslator.FromHtml("#dcf0e5"); break;
                    case "theme:whale": BackColor = ColorTranslator.FromHtml("#192641"); break;
                }
            };
            core.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
                if (!e.IsSuccess) { exitCode = testMode ? 1 : 11; if (!testMode) MessageBox.Show("无法加载 SusuClash 页面，请重试。", "SusuClash"); Close(); return; }
                SendState();
                if (testMode) {
                    try {
                        NativeRect win, client; var origin = Point.Empty;
                        if (!IsWindowVisible(Handle)) throw new Exception();
                        if (!GetWindowRect(Handle, out win) || !GetClientRect(Handle, out client) || !ClientToScreen(Handle, ref origin)) throw new Exception();
                        File.WriteAllText(Path.Combine(profile, "window-metrics.txt"), String.Join(",", new[] {win.Left,win.Top,win.Right,win.Bottom,origin.X,origin.Y,client.Right,client.Bottom}));
                        if (!AllowedExternal("https://susu5.cn/") || !AllowedExternal("https://github.com/susu5") || !AllowedExternal("https://github.com/susu5/SusuClash/releases") || AllowedExternal("https://github.com/susu5/SusuClash/releases/evil") || AllowedExternal("https://github.com/susu5/SusuClash/releases?token=x") || AllowedExternal("https://susu5.cn.example.test/") || AllowedExternal("http://susu5.cn/") || AllowedExternal("https://github.com/another")) throw new Exception();
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('theme:whale')");
                        await Task.Delay(200);
                        if (BackColor != ColorTranslator.FromHtml("#192641")) throw new Exception();
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('window:maximize')");
                        await Task.Delay(250);
                        if (WindowState != FormWindowState.Maximized) throw new Exception();
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('window:maximize')");
                        await Task.Delay(250);
                        if (WindowState != FormWindowState.Normal) throw new Exception();
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('window:drag')");
                        await Task.Delay(80);
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('window:drag')");
                        await Task.Delay(150);
                        if (WindowState != FormWindowState.Maximized) throw new Exception();
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('window:drag')");
                        await Task.Delay(80);
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('window:drag')");
                        await Task.Delay(150);
                        if (WindowState != FormWindowState.Normal) throw new Exception();
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('window:maximize')");
                        await Task.Delay(150);
                        await core.ExecuteScriptAsync("window.chrome.webview.postMessage('window:restore-drag')");
                        await Task.Delay(150);
                        if (WindowState != FormWindowState.Normal) throw new Exception();
                    } catch { exitCode = 1; }
                    Close();
                }
            };
            browser.Source = root;
        } catch (Exception) {
            exitCode = testMode ? 1 : 11;
            if (!testMode) MessageBox.Show("无法启动窗口。请确认已安装 Microsoft Edge WebView2 Runtime，然后重新打开 SusuClash。", "SusuClash", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 3) return 2;
        Uri root; int parent;
        if (!Uri.TryCreate(args[0], UriKind.Absolute, out root) || root.Scheme != "http" || root.Host != "127.0.0.1" || !root.AbsolutePath.EndsWith("/") || !Int32.TryParse(args[2], out parent)) return 2;
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var window = new SusuWindow(root, args[1], parent, args.Length > 3 && args[3] == "--test");
        Application.Run(window);
        return window.exitCode;
    }
}
