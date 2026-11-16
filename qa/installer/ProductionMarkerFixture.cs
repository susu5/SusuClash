using System; using System.IO; using System.Text; using System.Threading; using System.Diagnostics; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text.RegularExpressions; using System.Security.Cryptography;
internal static class ProductionMarkerE2E {
 [DllImport("msi.dll",CharSet=CharSet.Unicode)] static extern uint MsiOpenPackageEx(string p,uint o,out uint h);
 [DllImport("msi.dll")] static extern uint MsiCloseHandle(uint h);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)] static extern uint MsiGetProperty(uint h,string n,StringBuilder v,ref uint c);
 [DllImport("msi.dll")] static extern uint MsiSetInternalUI(uint l,IntPtr w);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)] static extern uint MsiEnableLog(uint m,string p,uint a);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)] static extern uint MsiInstallProduct(string p,string options);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)] static extern uint MsiConfigureProductEx(string product,int level,int state,string options);
 [DllImport("msi.dll",CharSet=CharSet.Unicode)] static extern int MsiQueryProductState(string product);
 delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,Callback cb,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,StringBuilder t,uint f,uint timeout,out IntPtr r);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] struct UP {public int pid;public System.Runtime.InteropServices.ComTypes.FILETIME start;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct PI {public UP proc;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)]public string app;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)]public string service;public uint type,status,session;[MarshalAs(UnmanagedType.Bool)]public bool restartable;}
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)]static extern int RmStartSession(out uint s,uint f,StringBuilder k);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)]static extern int RmRegisterResources(uint s,uint n,string[] files,uint a,UP[] apps,uint sn,string[] names);
 [DllImport("rstrtmgr.dll")]static extern int RmGetList(uint s,out uint need,ref uint count,[In,Out]PI[] apps,ref uint reason);
 [DllImport("rstrtmgr.dll")]static extern int RmEndSession(uint s);
 static string testDirectory,hostResource;
 static string ExpectedUIHash;
 static int HostPID() {
  try {
   if(hostResource==null) {
    string logged;using(var file=new FileStream(Path.Combine(testDirectory,"install-engine.log"),FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(var reader=new StreamReader(file,true))logged=reader.ReadToEnd();
    Match match=Regex.Match(logged,@"SFXCA: Extracting embedded UI to temporary directory: ([^\r\n]+)");if(!match.Success)return 0;
    string path=Path.GetFullPath(match.Groups[1].Value.Trim());string temp=Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\')+"\\";
    if(!path.StartsWith(temp+"MSI",StringComparison.OrdinalIgnoreCase)||(File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)return 0;
    string resource=Path.Combine(path,"SusuClash.InstallerUI.dll");string hash;using(var crypto=SHA256.Create())using(var file=File.OpenRead(resource))hash=BitConverter.ToString(crypto.ComputeHash(file)).Replace("-","").ToLowerInvariant();
    if(hash!=ExpectedUIHash)return 0;hostResource=resource;
   }
   uint s;if(RmStartSession(out s,0,new StringBuilder(33))!=0)return 0;
   try {
    if(RmRegisterResources(s,1,new[]{hostResource},0,null,0,null)!=0)return 0;
    uint need,count=0,reason=0;int result=RmGetList(s,out need,ref count,null,ref reason);if(result!=234||need!=1)return 0;
    PI[] list=new PI[need];count=need;if(RmGetList(s,out need,ref count,list,ref reason)!=0||count!=1)return 0;
    return list[0].proc.pid;
   } finally {RmEndSession(s);}
  }catch {return 0;}
 }
 static volatile bool returned,sawWelcome,sawBusy,sawSuccess,sawHundred,closedByX,automationFailed;
 static string Text(IntPtr h) {var t=new StringBuilder(512);IntPtr r;return SendMessageTimeout(h,0xD,new IntPtr(512),t,2,60,out r)==IntPtr.Zero?"":t.ToString();}
 static string Prop(uint h,string n) {var v=new StringBuilder(4096);uint c=4095;uint r=MsiGetProperty(h,n,v,ref c);if(r!=0)throw new Exception(n+"="+r);return v.ToString();}
 static void Automate() {
  bool consented=false,clickedStart=false;int lastPID=0;Stopwatch deadline=Stopwatch.StartNew();
  while(!returned) {
   int pid=HostPID();if(pid==0){Thread.Sleep(60);continue;}if(pid!=lastPID){lastPID=pid;Console.WriteLine("HOST identity=fixture-log+extracted-UI-SHA256+RestartManager-readonly-owner pid="+pid+" resource="+hostResource);}
   EnumWindows(delegate(IntPtr form,IntPtr unused){
    uint owner;GetWindowThreadProcessId(form,out owner);if(owner!=pid||Text(form)!="SusuClash 安装程序")return true;
    var controls=new Dictionary<string,IntPtr>();EnumChildWindows(form,delegate(IntPtr child,IntPtr no){string t=Text(child);if(t.Length>0&&!controls.ContainsKey(t))controls[t]=child;return true;},IntPtr.Zero);
    if(controls.ContainsKey("准备安装")) {
     sawWelcome=true;
     if(!consented&&controls.ContainsKey("我已阅读并接受许可协议")){PostMessage(controls["我已阅读并接受许可协议"],0xF5,IntPtr.Zero,IntPtr.Zero);consented=true;Console.WriteLine("UI consent checked");}
     if(consented&&!clickedStart&&controls.ContainsKey("开始安装")&&IsWindowEnabled(controls["开始安装"])) {clickedStart=true;PostMessage(controls["开始安装"],0xF5,IntPtr.Zero,IntPtr.Zero);Console.WriteLine("UI clicked Start");}
    }
    if(controls.ContainsKey("正在安装 SusuClash"))sawBusy=true;
    if(controls.ContainsKey("安装成功")) {
     sawSuccess=true;foreach(string text in controls.Keys)if(text.StartsWith("100%",StringComparison.Ordinal))sawHundred=true;
     if(!closedByX){closedByX=true;Console.WriteLine("UI actual Success; close via X, never Finish");PostMessage(form,0x10,IntPtr.Zero,IntPtr.Zero);}
    }
    foreach(string bad in new string[]{"安装结果尚未确认","安装未完成","安装已取消","安装完成，需要重启"}) if(controls.ContainsKey(bad)) {
     automationFailed=true;if(!closedByX){closedByX=true;Console.WriteLine("UI unexpected terminal="+bad+"; closing via X");PostMessage(form,0x10,IntPtr.Zero,IntPtr.Zero);}
    }
    if(deadline.ElapsedMilliseconds>90000&&!automationFailed){automationFailed=true;Console.WriteLine("UI timeout; requesting normal cancellation");PostMessage(form,0x10,IntPtr.Zero,IntPtr.Zero);}
    return true;
   },IntPtr.Zero);
   Thread.Sleep(40);
  }
 }
 public static int Main(string[] args) {
  uint h=0,installed=9999,cleaned=9999;string product="",dir="",marker="";bool ran=false;Thread controller=null;
  try {
   ExpectedUIHash=args.Length>1?args[1]:"";if(!Regex.IsMatch(ExpectedUIHash,"^[0-9a-f]{64}$"))throw new Exception("Verified UI SHA256 argument required."); string msi=Path.GetFullPath(args[0]);dir=Path.GetDirectoryName(msi);testDirectory=dir;
   if(!dir.Contains("\\outputs\\working\\production-marker-fixture-"))throw new Exception("Isolated production marker fixture required.");
   uint open=MsiOpenPackageEx(msi,1,out h);if(open!=0)throw new Exception("OpenPackage="+open);
   if(Prop(h,"ProductName")!="SusuClash Installer QA Fixture"||Prop(h,"UpgradeCode")=="{D7806B3D-6DD7-4DA6-B640-D96A07185A75}")throw new Exception("Isolated identity required.");
   if(Path.GetFullPath(Prop(h,"QAFIXTUREDIR")).TrimEnd('\\')!=Path.Combine(dir,"installed"))throw new Exception("Isolated marker path required.");
   product=Prop(h,"ProductCode");marker=Path.Combine(dir,"installed\\marker.txt");MsiCloseHandle(h);h=0;
   MsiEnableLog(0x1fff,Path.Combine(dir,"install-engine.log"),0);MsiSetInternalUI(5,IntPtr.Zero);
   controller=new Thread(Automate);controller.IsBackground=true;controller.Start();
   ran=true;installed=MsiInstallProduct(msi,"REBOOT=ReallySuppress");returned=true;controller.Join();
   Console.WriteLine("INSTALL return="+installed+" marker="+File.Exists(marker)+" sawWelcome="+sawWelcome+" sawBusy="+sawBusy+" sawSuccess="+sawSuccess+" saw100="+sawHundred+" closedByX="+closedByX);
  } catch(Exception e){Console.WriteLine("FAIL "+e);}
  finally {
   returned=true;if(h!=0)MsiCloseHandle(h);
   if(ran){MsiSetInternalUI(2,IntPtr.Zero);MsiEnableLog(0x1fff,Path.Combine(dir,"cleanup-engine.log"),0);cleaned=MsiConfigureProductEx(product,0,2,"REBOOT=ReallySuppress");Console.WriteLine("CLEANUP return="+cleaned+" state="+MsiQueryProductState(product)+" marker="+File.Exists(marker));}
  }
  return installed==0&&cleaned==0&&sawWelcome&&sawBusy&&sawSuccess&&sawHundred&&closedByX&&!automationFailed&&!File.Exists(marker)&&MsiQueryProductState(product)==-1?0:1;
 }
}
