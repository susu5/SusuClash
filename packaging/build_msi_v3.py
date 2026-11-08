#!/usr/bin/env python3
"""Build an offline per-user Windows MSI from an explicit application allowlist.

No profile, subscription, log, environment or user data is harvested.
Requires WiX 4+ on PATH. Run from any working directory.
"""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'outputs' / 'candidate'
WORK = ROOT / 'outputs' / 'working' / 'msi-build'
NS = 'http://wixtoolset.org/schemas/v4/wxs'
UI_NS = 'http://wixtoolset.org/schemas/v4/wxs/ui'
ET.register_namespace('', NS)
ET.register_namespace('ui', UI_NS)
def el(parent, tag, **attributes):
    return ET.SubElement(parent, '{%s}%s' % (NS, tag), attributes)
def stable(prefix, path):
    return prefix + hashlib.sha256(path.as_posix().lower().encode('utf8')).hexdigest()[:28]

def approved():
    files = [ROOT/'Start-Clash-Glass.cmd', ROOT/'package.json', ROOT/'README.md']
    rules = {
        ROOT/'app': {'.html','.css','.js','.svg','.png','.gif','.webp','.ico','.woff2'},
        ROOT/'src': {'.mjs','.ps1'},
        ROOT/'node_modules'/'yaml': {'.js','.json','.mjs','.cjs','.ts','.md'},
        ROOT/'runtime'/'node': {'.exe','.dll'},
    }
    for base, suffixes in rules.items():
        if not base.is_dir():
            raise SystemExit('Missing required directory: '+str(base))
        for p in base.rglob('*'):
            if p.is_file() and not p.is_symlink() and p.suffix.lower() in suffixes:
                files.append(p)
    yaml_license = ROOT/'node_modules'/'yaml'/'LICENSE'
    if yaml_license.is_file(): files.append(yaml_license)
    # Explicit desktop host and Microsoft WebView2 SDK dependencies; do not
    # copy the machine's Edge/WebView installation or any browser profile.
    for name in ('SusuClashWindow.exe','Microsoft.Web.WebView2.Core.dll',
                 'Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll',
                 'LICENSE.txt','NOTICE.txt'):
        p=ROOT/'runtime'/'webview2'/name
        if not p.is_file() or p.is_symlink():
            raise SystemExit('Missing required desktop host file: '+str(p))
        files.append(p)
    for name in ('mihomo.exe','ASN.mmdb','Country.mmdb','geoip.dat','geosite.dat','README.md'):
        p=ROOT/'runtime'/name
        if not p.is_file(): raise SystemExit('Missing required runtime file: '+str(p))
        files.append(p)
    files = sorted(set(files), key=lambda p: p.relative_to(ROOT).as_posix().lower())
    forbidden={'profiles','subscriptions','config','configs','logs','.env','.git','sessions'}
    for p in files:
        rel = p.relative_to(ROOT)
        if any(part.lower() in forbidden for part in rel.parts):
            raise SystemExit('Refusing potentially private input: '+str(rel))
    if not (ROOT/'runtime'/'node'/'node.exe').is_file(): raise SystemExit('Bundled Node is missing')
    if not (ROOT/'node_modules'/'yaml'/'package.json').is_file(): raise SystemExit('Bundled yaml is missing')
    return files

def main():
    OUT.mkdir(parents=True,exist_ok=True); WORK.mkdir(parents=True,exist_ok=True)
    version=json.loads((ROOT/'package.json').read_text(encoding='utf-8')).get('version','')
    if not isinstance(version,str) or not re.fullmatch(r'\d+\.\d+\.\d+',version):
        raise SystemExit('package.json version must have three numeric fields')
    major,minor,build=map(int,version.split('.'))
    if major>255 or minor>255 or build>65535:
        raise SystemExit('package.json version exceeds MSI version limits')
    files=approved()
    wix=ET.Element('{%s}Wix'%NS)
    # Keep the upgrade family and installation paths used by the released MSI.
    # Bump the first three version fields: Windows Installer ignores the fourth.
    package=el(wix,'Package',Name='SusuClash',Manufacturer='SusuClash',Version=version,UpgradeCode='{D7806B3D-6DD7-4DA6-B640-D96A07185A75}',Scope='perUser')
    ET.SubElement(package, '{%s}WixUI' % UI_NS, {'Id': 'WixUI_Minimal'})
    el(package, 'WixVariable', Id='WixUILicenseRtf', Value=str(ROOT/'packaging'/'test-notice.rtf'))
    # Remove the old product inside the transaction so rollback can restore it.
    el(package,'MajorUpgrade',Schedule='afterInstallInitialize',DowngradeErrorMessage='A newer version of SusuClash is already installed.')
    el(package,'MediaTemplate',EmbedCab='yes')
    el(package,'Icon',Id='SusuClashIcon',SourceFile=str(ROOT/'app'/'icon.ico'))
    el(package,'Property',Id='ARPPRODUCTICON',Value='SusuClashIcon')
    local=el(package,'StandardDirectory',Id='LocalAppDataFolder')
    programs=el(local,'Directory',Id='LocalPrograms',Name='Programs')
    install=el(programs,'Directory',Id='INSTALLFOLDER',Name='ClashGlass')
    dirs={Path('.'):install}; components=[]; starter=None
    for source in files:
        rel=source.relative_to(ROOT)
        current=Path('.')
        for part in rel.parent.parts:
            child=current/part
            if child not in dirs:
                dirs[child]=el(dirs[current],'Directory',Id=stable('D',child),Name=part)
            current=child
        cid=stable('C',rel); fid=stable('F',rel)
        comp=el(dirs[current],'Component',Id=cid,Guid='*')
        el(comp,'File',Id=fid,Source=str(source),KeyPath='yes')
        components.append(cid)
        if rel.as_posix()=='Start-Clash-Glass.cmd': starter=fid
    menu=el(package,'StandardDirectory',Id='ProgramMenuFolder')
    menu_dir=el(menu,'Directory',Id='AppMenuFolder',Name='SusuClash')
    # A renamed shortcut directory is a new component; the old major-upgrade
    # transaction removes the legacy shortcut before installing this one.
    shortcut=el(menu_dir,'Component',Id='StartMenuShortcut',Guid='{D73879E7-BBBB-44DC-8928-91E7B0F93D44}')
    el(shortcut,'Shortcut',Id='AppShortcut',Name='SusuClash',Target='[#'+starter+']',WorkingDirectory='INSTALLFOLDER',Description='SusuClash',Icon='SusuClashIcon',IconIndex='0')
    el(shortcut,'RemoveFolder',Id='RemoveAppMenuFolder',On='uninstall')
    el(shortcut,'RegistryValue',Root='HKCU',Key='Software\\SusuClash',Name='ShortcutInstalled',Type='integer',Value='1',KeyPath='yes')
    components.append('StartMenuShortcut')
    feature=el(package,'Feature',Id='MainFeature',Title='SusuClash',Level='1')
    for cid in components: el(feature,'ComponentRef',Id=cid)
    wxs=WORK/('SusuClash-'+version+'.wxs')
    ET.ElementTree(wix).write(wxs,encoding='utf-8',xml_declaration=True)
    output=OUT/('SusuClash-Setup-x64-v'+version+'.msi')
    result=subprocess.run(['wix','build','-ext','WixToolset.UI.wixext','-culture','zh-CN','-loc',str(ROOT/'packaging'/'zh-cn-test.wxl'),'-arch','x64','-dcl','medium','-pdbtype','none',str(wxs),'-out',str(output)],cwd=str(ROOT))
    if result.returncode: raise SystemExit(result.returncode)
    print('MSI:',output,'\nAllowlisted files:',len(files),'\nBytes:',output.stat().st_size)
if __name__=='__main__': main()
