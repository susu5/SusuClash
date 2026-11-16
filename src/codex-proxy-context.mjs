const proxyKeys=new Set(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']);
const fail=()=>{throw new Error('unsupported_proxy_context');};

// This deliberately accepts only unambiguous, single-line dotenv syntax. It
// does not load a file, expand variables, or infer whether an app loads dotenv.
function parseValue(source){
  if(source.startsWith('"')||source.startsWith("'")){
    const quote=source[0];let end=-1;
    for(let i=1;i<source.length;i++){
      if(quote==='"'&&source[i]==='\\'){if(i+1>=source.length)fail();i++;continue;}
      if(source[i]===quote){end=i;break;}
    }
    if(end<0||! /^[ \t]*(?:#.*)?$/.test(source.slice(end+1)))fail();
    return {value:source.slice(1,end),offset:1};
  }
  // A comment needs a separator. A URL fragment cannot silently become a
  // comment and thereby turn an unsupported proxy URL into an eligible one.
  const comment=/(?:^|[ \t]+)#/.exec(source);
  const value=(comment?source.slice(0,comment.index):source).replace(/[ \t]+$/,'');
  if(/["']/.test(value)||value.endsWith('\\'))fail();
  return {value,offset:0};
}

function inspect(content){
  if(typeof content!=='string'||content.length>1048576||/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content))fail();
  const env={},entries=[];let port=null,noProxy,position=0;
  for(const row of content.split(/(?<=\n)/)){
    let line=row.replace(/\r?\n$/,'');const bom=position===0&&line.startsWith('\uFEFF')?1:0;
    line=line.slice(bom);
    if(line.includes('\r')||line.includes('\uFEFF'))fail();
    if(/^[ \t]*(?:#.*)?$/.test(line)){position+=row.length;continue;}
    const assignment=/^([ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*)(.*)$/.exec(line);
    if(!assignment)fail();
    const parsed=parseValue(assignment[3]),key=assignment[2].toUpperCase();
    if(proxyKeys.has(key)){
      if(Object.hasOwn(env,key)||/[\\$`]/.test(parsed.value))fail();
      env[key]=parsed.value;
      if(key==='NO_PROXY')noProxy=parsed.value;
      else{
        const local=/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})(\/?)$/i.exec(parsed.value);
        if(!local)fail();
        const found=Number(local[2]);
        if(found<1||found>65535||port!==null&&port!==found)fail();
        port=found;
        const start=position+bom+assignment[1].length+parsed.offset+parsed.value.lastIndexOf(':')+1;
        entries.push({start,end:start+local[2].length});
      }
    }
    position+=row.length;
  }
  return {env,port,hasProxy:entries.length>0,noProxy,entries};
}

export function inspectCodexProxyEnv(content){
  const {entries,...result}=inspect(content);return result;
}

export function patchCodexProxyPort(content,port){
  if(!Number.isInteger(port)||port<1||port>65535)fail();
  const parsed=inspect(content);
  if(!parsed.hasProxy)fail();
  if(parsed.port===port)return content;
  let patched=content;
  for(const entry of parsed.entries.reverse())patched=patched.slice(0,entry.start)+port+patched.slice(entry.end);
  return patched;
}

export function safeCodexNoProxy(value,hosts=['chatgpt.com','api.openai.com','auth.openai.com']){
  if(value===undefined||value==='')return true;
  if(typeof value!=='string'||value.length>8192||/[\x00-\x1f\x7f]/.test(value)||!Array.isArray(hosts)||!hosts.length||hosts.length>256)return false;
  if(!value.trim())return true;
  const destinations=[];
  for(const host of hosts){
    if(typeof host!=='string'||!host||host.length>253||/[\s\x00-\x1f\x7f]/.test(host))return false;
    destinations.push(host.toLowerCase().replace(/^\[::1\]$/,'::1').replace(/\.$/,''));
  }
  const patterns=value.split(',').map(x=>x.trim().toLowerCase());
  if(patterns.length>256)return false;
  for(const pattern of patterns){
    if(!pattern)return false;
    const normalized=pattern==='[::1]'?'::1':pattern;
    if(['localhost','.localhost','.local'].includes(normalized)){
      const suffix=normalized.replace(/^\./,'');
      if(destinations.some(host=>host===suffix||host.endsWith('.'+suffix)))return false;
      continue;
    }
    if(normalized==='::1'){
      if(destinations.includes('::1'))return false;
      continue;
    }
    const parts=normalized.split('.');
    if(parts.length!==4||parts.some(x=>!/^(?:0|[1-9][0-9]{0,2})$/.test(x)||Number(x)>255))return false;
    const numbers=parts.map(Number),local=numbers[0]===127||numbers[0]===10||numbers[0]===172&&numbers[1]>=16&&numbers[1]<=31||numbers[0]===192&&numbers[1]===168||numbers[0]===169&&numbers[1]===254;
    if(!local||destinations.includes(normalized))return false;
  }
  return true;
}
