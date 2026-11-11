#!/usr/bin/env python3
"""Build a public MSI from a reviewed source snapshot and verified upstream inputs.

This script does not download files, install software, or touch user settings.
The manifest and all third-party notices must be reviewed before invoking it.
"""
from pathlib import Path, PurePosixPath
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

SOURCE = Path(__file__).resolve().parent.parent
NS = 'http://wixtoolset.org/schemas/v4/wxs'
UI_NS = 'http://wixtoolset.org/schemas/v4/wxs/ui'
ET.register_namespace('', NS)
ET.register_namespace('ui', UI_NS)

def el(parent, tag, **attrs):
    return ET.SubElement(parent, '{%s}%s' % (NS, tag), attrs)

def stable(prefix, path):
    return prefix + hashlib.sha256(path.as_posix().lower().encode('utf8')).hexdigest()[:28]

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()

def check_design_system(node, yaml_module_root):
    """Validate the approved style contract with already verified build inputs."""
    design_env = os.environ.copy()
    # The reviewed yaml archive has already been extracted to <root>/yaml.
    # This keeps the check usable in a clean source snapshot without npm install.
    design_env['NODE_PATH'] = str(yaml_module_root)
    subprocess.run(
        [str(node), str(SOURCE/'scripts'/'design-system.cjs'), 'check'],
        cwd=str(SOURCE), env=design_env, check=True, timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )

def main():
    parser=argparse.ArgumentParser(description='Build SusuClash from reviewed upstream dependencies')
    parser.add_argument('--deps',required=True,help='directory containing the verified upstream files')
    parser.add_argument('--output',required=True,help='new .msi output path; existing files will not be overwritten')
    parser.add_argument('--work-dir',required=True,help='directory for temporary compiled inputs and WiX source')
    args=parser.parse_args()
    deps=Path(args.deps).resolve();output=Path(args.output).resolve();working=Path(args.work_dir).resolve()
    if not deps.is_dir():raise SystemExit('Dependency directory not found')
    working.mkdir(parents=True,exist_ok=True);output.parent.mkdir(parents=True,exist_ok=True)
    data=json.loads((SOURCE/'package.json').read_text(encoding='utf8'))
    version=data.get('version','')
    if not re.fullmatch(r'\d+\.\d+\.\d+',version) or data.get('license')!='GPL-3.0-only':
        raise SystemExit('Unexpected release version or license')
    major,minor,build=map(int,version.split('.'))
    if major>255 or minor>255 or build>65535:raise SystemExit('Version exceeds MSI limits')
    if output.exists(): raise SystemExit('Refusing to overwrite an existing public release MSI')
    manifest_name='release-dependencies-v'+version+'.json'
    manifest=json.loads((SOURCE/'packaging'/manifest_name).read_text(encoding='utf8'))
    required=['node-official.exe','NODE-LICENSE','mihomo-official.exe','geoip.dat','geosite.dat',
              'dbip-country-lite-2026-11.mmdb','dbip-asn-lite-2026-11.mmdb',
              'microsoft.web.webview2.1.0.4078.44.nupkg','yaml-2.8.1.tgz']
    artifacts=manifest.get('artifacts',{})
    for name in required:
        entry=artifacts.get(name,{})
        expected=entry.get('sha256','')
        p=deps/name
        if not re.fullmatch(r'[0-9a-f]{64}',expected) or not entry.get('source') or not p.is_file() or p.is_symlink() or digest(p)!=expected:
            raise SystemExit('Missing or mismatched reviewed dependency: '+name)
    raw=(deps/'yaml-2.8.1.tgz').read_bytes()
    integrity=base64.b64encode(hashlib.sha512(raw).digest()).decode('ascii')
    if integrity!='lcYcMxX2PO9XMGvAJkJ3OsNMw+/7FKes7/hgerGUYWIoWu5j/+YQqcZr5JnPZWzOsEBgMbSbiSTn/dv/69Mkpw==':
        raise SystemExit('yaml archive does not match checked-in lockfile integrity')

    legal=SOURCE/'licenses'
    legal_names=['Mihomo-GPL-3.0.txt','Node-LICENSE.txt','V2Fly-GeoIP-CC-BY-SA-4.0.txt',
                 'V2Fly-GeoSite-MIT.txt','MetaCubeX-GeoSite-GPL-3.0.txt','DB-IP-CC-BY-4.0.txt','CC-BY-SA-4.0.txt',
                 'WebView2-LICENSE.txt','WebView2-NOTICE.txt','yaml-ISC.txt']
    legal_inputs={'Mihomo-GPL-3.0.txt':'MIHOMO-LICENSE','Node-LICENSE.txt':'NODE-LICENSE',
                  'V2Fly-GeoIP-CC-BY-SA-4.0.txt':'V2FLY-GEOIP-LICENSE','V2Fly-GeoSite-MIT.txt':'V2FLY-GEOSITE-LICENSE',
                  'MetaCubeX-GeoSite-GPL-3.0.txt':'METACUBEX-GEOSITE-LICENSE',
                  'DB-IP-CC-BY-4.0.txt':'CC-BY-4.0-LICENSE','CC-BY-SA-4.0.txt':'CC-BY-SA-4.0-LICENSE',
                  'WebView2-LICENSE.txt':'WEBVIEW2-LICENSE.txt','WebView2-NOTICE.txt':'WEBVIEW2-NOTICE.txt'}
    for name in legal_names:
        p=legal/name
        if not p.is_file() or p.is_symlink():raise SystemExit('Missing license notice: '+name)
        if name in legal_inputs and digest(p)!=artifacts.get(legal_inputs[name],{}).get('sha256'):
            raise SystemExit('Mismatched license notice: '+name)

    work=Path(tempfile.mkdtemp(prefix='public-msi-build-',dir=working))
    geodata_manifest=SOURCE/'runtime'/'geodata.json'
    geodata=json.loads(geodata_manifest.read_text(encoding='utf8'))
    if geodata.get('version')!=1 or geodata.get('geosite',{}).get('sha256')!=artifacts['geosite.dat']['sha256']:
        raise SystemExit('Runtime geodata manifest does not match the reviewed database')
    # Validate the DNS fallback and Meta categories that regressed in 0.1.9.
    probe=work/'geodata-probe';probe.mkdir()
    import shutil
    for name in ['geoip.dat','geosite.dat']:
        shutil.copyfile(deps/name,probe/name)
    shutil.copyfile(deps/'dbip-country-lite-2026-11.mmdb',probe/'Country.mmdb')
    shutil.copyfile(deps/'dbip-asn-lite-2026-11.mmdb',probe/'ASN.mmdb')
    probe_config=probe/'compat.yaml'
    probe_config.write_text('mode: rule\nmixed-port: 0\ndns:\n  enable: true\n  nameserver: [1.1.1.1]\n  fallback: [8.8.8.8]\n  fallback-filter:\n    geoip: false\n    geosite: [gfw]\nrules:\n  - GEOSITE,apple-cn,DIRECT\n  - GEOSITE,google-cn,DIRECT\n  - GEOSITE,cn,DIRECT\n  - MATCH,DIRECT\n',encoding='utf8')
    probe_result=subprocess.run([str(deps/'mihomo-official.exe'),'-d',str(probe),'-f',str(probe_config),'-t'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=20,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if probe_result.returncode:
        print(probe_result.stdout);print(probe_result.stderr)
        raise SystemExit('GeoSite DNS/Meta compatibility probe failed')
    unpack=work/'unpacked';unpack.mkdir()
    files={}
    def add(rel,source):
        rel=Path(rel)
        if rel.is_absolute() or '..' in rel.parts or rel in files or not source.is_file() or source.is_symlink():
            raise SystemExit('Invalid or duplicate package input: '+str(rel))
        if any(p.lower() in {'profiles','subscriptions','configs','config','logs','.env','.git','sessions'} for p in rel.parts):
            raise SystemExit('Potentially private input refused: '+str(rel))
        files[rel]=source
    for name in ['Start-Clash-Glass.cmd','恢复SusuClash.cmd','package.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md']:
        add(name,SOURCE/name)
    for folder,suffixes in [('app',{'.html','.css','.js','.svg','.png','.gif','.webp','.ico','.woff2'}),('src',{'.mjs','.ps1','.cs'})]:
        base=SOURCE/folder
        for p in base.rglob('*'):
            if p.is_file() and not p.is_symlink() and p.suffix.lower() in suffixes:add(p.relative_to(SOURCE),p)

    sdk={'lib/net462/Microsoft.Web.WebView2.Core.dll':'Microsoft.Web.WebView2.Core.dll',
         'lib/net462/Microsoft.Web.WebView2.WinForms.dll':'Microsoft.Web.WebView2.WinForms.dll',
         'runtimes/win-x64/native/WebView2Loader.dll':'WebView2Loader.dll',
         'LICENSE.txt':'LICENSE.txt','NOTICE.txt':'NOTICE.txt'}
    webview=unpack/'webview2';webview.mkdir()
    with ZipFile(deps/'microsoft.web.webview2.1.0.4078.44.nupkg') as archive:
        for original,name in sdk.items():
            p=webview/name;p.write_bytes(archive.read(original));add(Path('runtime/webview2')/name,p)
    compiler=Path(os.environ.get('WINDIR',r'C:\Windows'))/'Microsoft.NET'/'Framework64'/'v4.0.30319'/'csc.exe'
    host=webview/'SusuClashWindow.exe'
    subprocess.run([str(compiler),'/nologo','/target:winexe','/platform:x64','/out:'+str(host),
                    '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',
                    '/reference:'+str(webview/'Microsoft.Web.WebView2.Core.dll'),
                    '/reference:'+str(webview/'Microsoft.Web.WebView2.WinForms.dll'),str(SOURCE/'src'/'window-host.cs')],check=True)
    add('runtime/webview2/SusuClashWindow.exe',host)

    node=deps/'node-official.exe';add('runtime/node/node.exe',node)
    add('runtime/mihomo.exe',deps/'mihomo-official.exe')
    for rel,name in [('runtime/geoip.dat','geoip.dat'),('runtime/geosite.dat','geosite.dat'),
                     ('runtime/Country.mmdb','dbip-country-lite-2026-11.mmdb'),('runtime/ASN.mmdb','dbip-asn-lite-2026-11.mmdb')]:add(rel,deps/name)
    add('runtime/geodata.json',geodata_manifest)
    # Existing MSI builder requires this path. Its contents are generated from
    # the reviewed notice, not from any existing user runtime directory.
    runtime_readme=unpack/'runtime-readme.md'
    runtime_readme.write_text('本安装包使用经核验的公开组件。来源和许可证见安装目录 licenses。\n',encoding='utf8')
    add('runtime/README.md',runtime_readme)
    with tarfile.open(deps/'yaml-2.8.1.tgz','r:gz') as archive:
        if archive.extractfile('package/LICENSE').read() != (legal/'yaml-ISC.txt').read_bytes():
            raise SystemExit('yaml license does not match the verified package')
        for member in archive.getmembers():
            name=PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or (not member.isfile() and not member.isdir()):raise SystemExit('Unsafe yaml package entry')
            if not member.isfile() or not name.parts or name.parts[0]!='package':continue
            sub=Path(*name.parts[1:])
            if sub.suffix.lower() not in {'.js','.json','.mjs','.cjs','.ts','.md'} and sub.name!='LICENSE':continue
            dest=unpack/'yaml'/sub;dest.parent.mkdir(parents=True,exist_ok=True)
            dest.write_bytes(archive.extractfile(member).read());add(Path('node_modules/yaml')/sub,dest)
    yaml_pkg=unpack/'yaml'/'package.json'
    if json.loads(yaml_pkg.read_text(encoding='utf8')).get('version')!='2.8.1':raise SystemExit('Unexpected yaml package version')
    check_design_system(node, unpack)
    for name in legal_names:add(Path('licenses')/name,legal/name)
    add(Path('packaging')/manifest_name,SOURCE/'packaging'/manifest_name)

    # Render the complete GPL license as the setup dialog, replacing the old
    # local-only test notice which explicitly prohibited public distribution.
    def escape_rtf(text):
        return text.replace('\\','\\\\').replace('{','\\{').replace('}','\\}').replace('\r','').replace('\n','\\par\n')
    rtf=work/'gpl.rtf';rtf.write_text(r'{\rtf1\ansi\deff0{\fonttbl{\f0 Segoe UI;}}\f0\fs18 '+escape_rtf((SOURCE/'LICENSE').read_text(encoding='utf8'))+'}',encoding='ascii')

    wix=ET.Element('{%s}Wix'%NS)
    package=el(wix,'Package',Name='SusuClash',Manufacturer='SusuClash',Version=version,UpgradeCode='{D7806B3D-6DD7-4DA6-B640-D96A07185A75}',Scope='perUser')
    ET.SubElement(package,'{%s}WixUI'%UI_NS,{'Id':'WixUI_Minimal'})
    el(package,'WixVariable',Id='WixUILicenseRtf',Value=str(rtf))
    el(package,'MajorUpgrade',Schedule='afterInstallInitialize',DowngradeErrorMessage='A newer version of SusuClash is already installed.')
    el(package,'MediaTemplate',EmbedCab='yes')
    el(package,'Icon',Id='SusuClashIcon',SourceFile=str(SOURCE/'app'/'icon.ico'))
    el(package,'Property',Id='ARPPRODUCTICON',Value='SusuClashIcon')
    local=el(package,'StandardDirectory',Id='LocalAppDataFolder')
    programs=el(local,'Directory',Id='LocalPrograms',Name='Programs')
    install=el(programs,'Directory',Id='INSTALLFOLDER',Name='ClashGlass')
    dirs={Path('.'):install};components=[];starter=None
    for rel,source in sorted(files.items(),key=lambda x:x[0].as_posix().lower()):
        current=Path('.')
        for part in rel.parent.parts:
            child=current/part
            if child not in dirs:dirs[child]=el(dirs[current],'Directory',Id=stable('D',child),Name=part)
            current=child
        cid=stable('C',rel);fid=stable('F',rel)
        comp=el(dirs[current],'Component',Id=cid,Guid='*')
        el(comp,'File',Id=fid,Name=rel.name,Source=str(source),KeyPath='yes');components.append(cid)
        if rel.as_posix()=='Start-Clash-Glass.cmd':starter=fid
    menu=el(package,'StandardDirectory',Id='ProgramMenuFolder')
    menu_dir=el(menu,'Directory',Id='AppMenuFolder',Name='SusuClash')
    shortcut=el(menu_dir,'Component',Id='StartMenuShortcut',Guid='{D73879E7-BBBB-44DC-8928-91E7B0F93D44}')
    el(shortcut,'Shortcut',Id='AppShortcut',Name='SusuClash',Target='[#'+starter+']',WorkingDirectory='INSTALLFOLDER',Description='SusuClash',Icon='SusuClashIcon',IconIndex='0')
    el(shortcut,'RemoveFolder',Id='RemoveAppMenuFolder',On='uninstall')
    el(shortcut,'RegistryValue',Root='HKCU',Key='Software\\SusuClash',Name='ShortcutInstalled',Type='integer',Value='1',KeyPath='yes')
    components.append('StartMenuShortcut')
    desktop=el(package,'StandardDirectory',Id='DesktopFolder')
    desktop_shortcut=el(desktop,'Component',Id='DesktopShortcut',Guid='{9B103E0E-5FA1-48E4-A9C7-E2BF46B8184A}')
    el(desktop_shortcut,'Shortcut',Id='DesktopAppShortcut',Name='SusuClash',Target='[#'+starter+']',WorkingDirectory='INSTALLFOLDER',Description='SusuClash',Icon='SusuClashIcon',IconIndex='0')
    el(desktop_shortcut,'RegistryValue',Root='HKCU',Key='Software\\SusuClash',Name='DesktopShortcutInstalled',Type='integer',Value='1',KeyPath='yes')
    components.append('DesktopShortcut')
    feature=el(package,'Feature',Id='MainFeature',Title='SusuClash',Level='1')
    for cid in components:el(feature,'ComponentRef',Id=cid)
    wxs=work/('SusuClash-'+version+'.wxs');ET.ElementTree(wix).write(wxs,encoding='utf-8',xml_declaration=True)
    subprocess.run(['wix','build','-ext','WixToolset.UI.wixext','-culture','zh-CN','-arch','x64','-dcl','medium','-pdbtype','none',str(wxs),'-out',str(output)],check=True,cwd=str(SOURCE))
    print('MSI',output);print('SHA256',digest(output));print('Files',len(files));print('Build directory',work)

if __name__=='__main__': main()
