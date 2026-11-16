from pathlib import Path
import uuid,json,hashlib,subprocess,xml.etree.ElementTree as ET
root=Path(__file__).resolve().parents[2]
import argparse
parser=argparse.ArgumentParser();parser.add_argument('--receipt',required=True);args=parser.parse_args()
receipt=Path(args.receipt).resolve()
report=json.loads(receipt.read_text(encoding='utf-8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
ui=Path(report['nativeDll']);state=Path(report['stateDll'])
assert sha(ui)==report['nativeSha256']
assert sha(state)==report['stateSha256']
work=root/'outputs/working'/('production-marker-fixture-'+uuid.uuid4().hex);work.mkdir()
product='{'+str(uuid.uuid4()).upper()+'}';upgrade='{'+str(uuid.uuid4()).upper()+'}'
assert upgrade!='{D7806B3D-6DD7-4DA6-B640-D96A07185A75}'
(work/'marker.txt').write_text('Isolated production EmbeddedUI/CA bridge test. No app payload.\n')
ns='http://wixtoolset.org/schemas/v4/wxs';ET.register_namespace('',ns)
def e(p,n,**a):return ET.SubElement(p,'{'+ns+'}'+n,a)
wix=ET.Element('{'+ns+'}Wix')
package=e(wix,'Package',Name='SusuClash Installer QA Fixture',Manufacturer='SusuClash QA',Version='1.0.0',Scope='perUser',ProductCode=product,UpgradeCode=upgrade)
e(package,'MediaTemplate',EmbedCab='yes');e(package,'Property',Id='REBOOT',Value='ReallySuppress')
e(package,'Property',Id='INSTALLDESKTOPSHORTCUT',Value='0')
e(package,'Property',Id='QAFIXTUREDIR',Value=str(work/'installed')+'\\')
ui_element=e(package,'UI');e(ui_element,'EmbeddedUI',Id='SusuClashEmbeddedUI',SourceFile=str(ui))
e(package,'Binary',Id='SusuClashRebootState',SourceFile=str(state))
e(package,'CustomAction',Id='ReportRebootState',BinaryRef='SusuClashRebootState',DllEntry='ReportRebootState',Execute='immediate',Return='ignore')
sequence=e(package,'InstallExecuteSequence');e(sequence,'Custom',Action='ReportRebootState',After='InstallFinalize',Condition='NOT REMOVE~="ALL"')
target=e(package,'StandardDirectory',Id='TARGETDIR');directory=e(target,'Directory',Id='QAFIXTUREDIR',Name='IsolatedMarker')
component=e(directory,'Component',Id='Marker',Guid='{'+str(uuid.uuid4()).upper()+'}')
e(component,'File',Id='MarkerFile',Name='marker.txt',Source=str(work/'marker.txt'),KeyPath='yes')
feature=e(package,'Feature',Id='Fixture',Title='Isolated marker only',Level='1');e(feature,'ComponentRef',Id='Marker')
ET.ElementTree(wix).write(work/'fixture.wxs',encoding='utf-8',xml_declaration=True)
subprocess.run([str(Path.home()/'.dotnet/tools/wix.exe'),'build','-arch','x64',str(work/'fixture.wxs'),'-out',str(work/'fixture.msi')],check=True)
manifest={'work':str(work),'msi':str(work/'fixture.msi'),'productCode':product,'upgradeCode':upgrade,'ui':str(ui),'uiSha256':sha(ui),'state':str(state),'stateSha256':sha(state),'receipt':str(receipt),'receiptSha256':sha(receipt),'sourceFiles':report['sourceFiles'],'marker':str(work/'installed/marker.txt'),'installed':False}
(work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(manifest,ensure_ascii=False))
