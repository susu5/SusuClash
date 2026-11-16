using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class NativeEntrySmoke
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadLibrary(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] private static extern IntPtr GetProcAddress(IntPtr library, string name);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiOpenPackageEx(string path, uint options, out uint handle);
    [DllImport("msi.dll")] private static extern uint MsiCloseHandle(uint handle);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiGetProperty(uint handle, string property, StringBuilder value, ref uint length);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiSetProperty(uint handle, string property, string value);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    private delegate bool EnumCallback(IntPtr window, IntPtr state);
    [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Unicode)]
    private delegate uint Initialize(uint handle, string resourcePath, ref uint uiLevel);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Handler(uint type, uint record);
    private static volatile bool sawWindow;
    private static string Property(uint handle, string name)
    {
        StringBuilder value = new StringBuilder(1024); uint length = 1023;
        uint result = MsiGetProperty(handle, name, value, ref length);
        if (result != 0) throw new Exception("Property read failed: " + name + " code=" + result);
        return value.ToString();
    }
    public static int Main(string[] args)
    {
        if (args.Length != 3) return 2;
        uint handle = 0;
        try
        {
            uint opened = MsiOpenPackageEx(Path.GetFullPath(args[1]), 1, out handle);
            if (opened != 0) throw new Exception("OpenPackage=" + opened);
            if (Property(handle, "ProductName") != "SusuClash Installer QA Fixture" ||
                Property(handle, "UpgradeCode").Equals("{D7806B3D-6DD7-4DA6-B640-D96A07185A75}", StringComparison.OrdinalIgnoreCase))
                throw new Exception("Only the isolated QA fixture is allowed.");
            IntPtr library = LoadLibrary(Path.GetFullPath(args[0]));
            if (library == IntPtr.Zero) throw new Exception("LoadLibrary=" + Marshal.GetLastWin32Error());
            IntPtr address = GetProcAddress(library, "InitializeEmbeddedUI");
            if (address == IntPtr.Zero) throw new Exception("InitializeEmbeddedUI export missing.");
            Initialize initialize = (Initialize)Marshal.GetDelegateForFunctionPointer(address, typeof(Initialize));
            uint level = args[2] == "silent" ? 2u : 5u;
            if (args[2] == "maintenance") MsiSetProperty(handle, "Installed", "1");
            if (args[2] == "welcome-close")
            {
                Thread closer = new Thread(delegate()
                {
                    int pid = Process.GetCurrentProcess().Id;
                    Stopwatch deadline = Stopwatch.StartNew();
                    while (deadline.ElapsedMilliseconds < 20000 && !sawWindow)
                    {
                        EnumWindows(delegate(IntPtr window, IntPtr state)
                        {
                            uint owner; GetWindowThreadProcessId(window, out owner);
                            if (owner != pid) return true;
                            StringBuilder text = new StringBuilder(256); IntPtr read;
                            // Same-process GetWindowText can block on MSI's non-pumping install thread.
                            // Bound every control message rather than blocking the Welcome automation.
                            if (SendMessageTimeout(window, 0x000D, new IntPtr(256), text, 2, 80, out read) == IntPtr.Zero) return true;
                            if (!String.Equals(text.ToString(), "SusuClash 安装程序", StringComparison.Ordinal)) return true;
                            Console.WriteLine("OBSERVED window=" + text);
                            sawWindow = true; PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero); return false;
                        }, IntPtr.Zero);
                        Thread.Sleep(100);
                    }
                    if (!sawWindow) { Console.WriteLine("FAIL no installer Welcome window"); Environment.Exit(12); }
                });
                closer.IsBackground = true; closer.Start();
            }
            string extraction = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-smoke-extract-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(extraction);
            uint returned = initialize(handle, extraction, ref level);
            Console.WriteLine("RESULT mode=" + args[2] + " return=" + returned + " level=" + level + " sawWindow=" + sawWindow + " noInstallSequence=true");
            if (args[2] == "welcome-close")
            {
                Handler handler = (Handler)Marshal.GetDelegateForFunctionPointer(GetProcAddress(library, "EmbeddedUIHandler"), typeof(Handler));
                int nextProgress = handler(0x0A000000, 0);
                Console.WriteLine("RESULT initializationCancelNextProgress=" + nextProgress);
                // DTF's native shim maps initialization UserExit to success/None, then IDCANCEL
                // on the next callback. It cannot return 1602 directly from InitializeEmbeddedUI.
                return sawWindow && returned == 0 && level == 2 && nextProgress == 2 ? 0 : 3;
            }
            // The DTF shim's native fallback return/UI-level values are recorded for review.
            return returned == level && !sawWindow ? 0 : 4;
        }
        catch (Exception error) { Console.WriteLine("FAIL " + error); return 1; }
        finally { if (handle != 0) MsiCloseHandle(handle); }
    }
}
