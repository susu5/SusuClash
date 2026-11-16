// Native setup consumes the approved web contract; no second palette is maintained.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('yaml');
const root = path.resolve(__dirname, '../..');
function generate(output) {
  const design = fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8');
  const spec = yaml.parse(design.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  const sidecar = JSON.parse(fs.readFileSync(path.join(root, '.impeccable/design.json')));
  const ext = sidecar.extensions;
  if (ext.approval.version !== 'author-v3' || ext.approval.status !== 'approved') throw Error('Unapproved installer theme source');
  const color = v => {
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) throw Error('Unsupported color: '+v);
    const alpha = v.length === 9 ? parseInt(v.slice(7,9),16) : 255;
    return `Color.FromArgb(${alpha}, ${parseInt(v.slice(1,3),16)}, ${parseInt(v.slice(3,5),16)}, ${parseInt(v.slice(5,7),16)})`;
  };
  const pixels = v => {
    if (!/^\d+(\.\d+)?px$/.test(v)) throw Error('Expected pixel contract: '+v);
    return parseFloat(v)+'f';
  };
  const fontStack = [...spec.typography.body.fontFamily.matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  if (fontStack[0] !== 'Segoe UI' || !fontStack.includes('Microsoft YaHei UI')) throw Error('Unsupported native font mapping');
  const rows = ['// Generated from DESIGN.md and .impeccable/design.json. Do not edit.',
    '// Approved installer geometry: outputs/candidate/SusuClash-安装器外圈进度-设计说明-v2-待审.md',
    'using System.Drawing;', 'namespace SusuClash.Installer {', 'public static class InstallerTheme {',
    `public const string FontFamily = ${JSON.stringify(fontStack[0])};`,
    `public const string CjkFontFamily = ${JSON.stringify(fontStack[1])};`];
  for (const [name, value] of Object.entries({CaptionPixels:spec.typography.caption.fontSize, BodyPixels:spec.typography.body.fontSize,
    TitlePixels:spec.typography['page-title'].fontSize, DialogPixels:spec.typography['dialog-title'].fontSize,
    PanelRadius:spec.rounded.panel, SheetRadius:spec.rounded.sheet, ControlRadius:spec.rounded['compact-control'],
    TitlebarHeight:'49px', PanelPadding:spec.spacing.panel})) rows.push(`public const float ${name} = ${pixels(value)};`);
  rows.push('public static readonly InstallerThemeData[] All = new InstallerThemeData[] {');
  for (const [key,name] of [['cat','珍珠'],['fish','薄荷'],['whale','夜航']]) {
    const fields = [`Key = "${key}"`, `Name = "${name}"`];
    for (const [name,role] of Object.entries({Window:'window',Surface:'surface',Text:'text',Muted:'muted',Accent:'accent',Track:'nav-track',NavSelected:'nav-selected',NavText:'nav-text',NavAccent:'nav-accent'})) {
      fields.push(`${name} = ${color(spec.colors[key+'-'+role])}`);
    }
    for (const [kind,css] of [['Raised','raised'],['Inset','inset']]) {
      const value=ext.shadows.find(s=>s.name===key+'-'+css).value;
      value.split(',').forEach((part,i)=>{
        const match=part.trim().match(/^(?:inset )?(-?\d+)px (-?\d+)px (\d+)px (#[0-9a-f]+)$/i);
        if(!match) throw Error('Unsupported native shadow: '+part);
        fields.push(`Shadow${kind}${i===0?'Dark':'Light'} = ${color(match[4])}`);
        const prefix=`Shadow${kind}${i===0?'':'Light'}`;
        ['OffsetX','OffsetY','Blur'].forEach((property,j)=>fields.push(`${prefix}${property} = ${match[j+1]}f`));
      });
    }
    rows.push('new InstallerThemeData { '+fields.join(', ')+' },');
  }
  rows.push('};', '}', '}');
  fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output, rows.join('\n')+'\n');
  return {file:output,contractSha256:ext.approval.contractSha256,sourceSha256:crypto.createHash('sha256').update(design).digest('hex')};
}
if (require.main === module) {
  if (!process.argv[2]) throw Error('Output .cs path required');
  console.log(JSON.stringify(generate(path.resolve(process.argv[2]))));
}
module.exports={generate};
