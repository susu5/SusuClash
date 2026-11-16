"""Build the MSI-only managed EmbeddedUI from verified inputs and shared tokens."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import time
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def pack_native(command, directory, frozen):
    """Retry only a fresh, owned build artifact when Windows denies PE/CAB writes.

    No installer is executed here. Immutable source/input hashes and all ordinary
    compiler/packager failures retain their normal fail-fast behavior.
    """
    history=[]
    for attempt in range(6):
        if any(sha(Path(p)) != expected for p,expected in frozen.items()):
            raise SystemExit('Installer inputs changed before native packaging')
        result=subprocess.run(command,cwd=directory,capture_output=True)
        raw=result.stdout+b'\n'+result.stderr
        (directory/(Path(command[1]).stem+'-pack-attempt'+str(attempt+1)+'.log')).write_bytes(raw)
        message=raw.decode('utf-8',errors='replace')
        legacy=raw.decode('mbcs',errors='replace')
        history.append({'attempt':attempt+1,'exitCode':result.returncode})
        if result.returncode == 0: return history
        transient=bool(re.search(r'Failed to save resource\. Error (5|32|110)\b',message)) or (
            'WinIOError' in message and ('另一进程使用' in legacy or '另一进程使用' in message or 'used by another process' in message))
        if not transient or attempt == 5:
            print(message)
            result.check_returncode()
        time.sleep(.2*(2**attempt))

def build_installer_ui(work, installer_deps, manifest, node, yaml_root, version):
    out = work/'installer'; out.mkdir()
    hashes = manifest['artifacts']
    for kind in ['windowsinstaller','customaction']:
        name = 'wixtoolset.dtf.'+kind+'.7.0.0.nupkg'
        package = installer_deps/name
        if package.is_symlink() or not package.is_file() or sha(package) != hashes[name]['sha256']:
            raise SystemExit('Unverified EmbeddedUI build input: '+name)
        dest=out/kind; dest.mkdir()
        with ZipFile(package) as archive:
            # Extract only ordinary reviewed package entries, never symlinks/absolute paths.
            for item in archive.infolist():
                rel=Path(item.filename)
                if rel.is_absolute() or '..' in rel.parts or item.external_attr >> 16 & 0o170000 == 0o120000:
                    raise SystemExit('Unsafe DTF archive member')
                if not item.is_dir():
                    target=dest/rel; target.parent.mkdir(parents=True,exist_ok=True)
                    target.write_bytes(archive.read(item))
    dtf=out/'windowsinstaller/lib/net20/WixToolset.Dtf.WindowsInstaller.dll'
    tools=out/'customaction/tools'
    generated=out/'InstallerTheme.g.cs'
    env=os.environ.copy(); env['NODE_PATH']=str(yaml_root)
    subprocess.run([str(node),str(ROOT/'packaging/installer/generate-theme.cjs'),str(generated)],check=True,env=env,cwd=ROOT)
    compiler=Path(os.environ.get('WINDIR',r'C:\Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    managed=out/'SusuClash.Installer.dll'
    sources=[ROOT/'packaging/installer'/name for name in ['EngineProgress.cs','EmbeddedUI.cs','InstallerForm.cs']]+[generated]
    state_source=ROOT/'packaging/installer/RebootState.cs'
    assets={'cat-motion.gif':ROOT/'app/cat-motion.gif','cat-poster.png':ROOT/'app/cat-poster.png',
            'icon.ico':ROOT/'app/icon.ico','LICENSE':ROOT/'LICENSE'}
    assembly=out/'AssemblyInfo.g.cs'
    assembly.write_text('using System.Reflection;\n[assembly: AssemblyVersion("'+version+'.0")]\n[assembly: AssemblyFileVersion("'+version+'.0")]\n',encoding='utf-8')
    sources.append(assembly)
    frozen={str(p):sha(p) for p in sources + [state_source] + list(assets.values()) + [ROOT/'packaging/installer/EmbeddedUI.config']}
    args=[str(compiler),'/nologo','/target:library','/platform:x64','/optimize+','/codepage:65001', '/out:'+str(managed),
          '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:'+str(dtf)]
    args += ['/resource:'+str(p)+',SusuClash.Installer.'+name for name,p in assets.items()]
    args += [str(p) for p in sources]
    subprocess.run(args,check=True,cwd=ROOT)
    config=out/'EmbeddedUI.config'
    config.write_bytes((ROOT/'packaging/installer/EmbeddedUI.config').read_bytes())
    native=out/'SusuClash.InstallerUI.dll'
    ui_pack=pack_native([str(tools/'WixToolset.Dtf.MakeSfxCA.exe'),str(native),str(tools/'x64/SfxCA.dll'),str(managed),str(dtf),str(config)],out,frozen)
    state_managed=out/'SusuClash.InstallerState.dll'
    subprocess.run([str(compiler),'/nologo','/target:library','/platform:x64','/optimize+','/codepage:65001',
                    '/out:'+str(state_managed),'/reference:'+str(dtf),str(state_source),str(sources[0]),str(assembly)],check=True,cwd=ROOT)
    state_config=out/'CustomAction.config'; state_config.write_bytes(config.read_bytes())
    state_native=out/'SusuClash.InstallerStateCA.dll'
    state_pack=pack_native([str(tools/'WixToolset.Dtf.MakeSfxCA.exe'),str(state_native),str(tools/'x64/SfxCA.dll'),str(state_managed),str(dtf),str(state_config)],out,frozen)
    if any(sha(Path(p)) != expected for p,expected in frozen.items()):
        raise SystemExit('Installer source changed during compilation; rebuild from a stable snapshot')
    report={'version':version,'sourceFiles':{str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p):sha(p) for p in sources+[state_source]},
            'generatedTheme':str(generated),'managedDll':str(managed),'managedSha256':sha(managed),
            'nativeDll':str(native),'nativeSha256':sha(native),'dtfDll':str(dtf),'dtfSha256':sha(dtf),
            'resources':{ 'SusuClash.Installer.'+name:{'source':str(p.relative_to(ROOT)),'sha256':sha(p)} for name,p in assets.items()},
            'configuration':str(config),'configurationSha256':sha(config),'scope':'MSI installer only; EmbeddedUI plus read-only post-commit reboot state', 'installed':False}
    report.update({'stateManagedDll':str(state_managed),'stateManagedSha256':sha(state_managed),
                   'stateDll':str(state_native),'stateSha256':sha(state_native),
                   'stateConfig':str(state_config),'stateConfigSha256':sha(state_config),
                   'nativePackagingAttempts':{'ui':ui_pack,'state':state_pack}})
    (out/'installer-build.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return native,state_native
