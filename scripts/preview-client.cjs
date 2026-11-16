const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {createFixture}=require('../qa/preview-fixture.cjs');
const ROOT=path.resolve(__dirname,'..'),APP=path.join(ROOT,'app');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.gif':'image/gif','.ico':'image/x-icon'};
const APP_VERSION=require('../package.json').version;
const slots=['cat','fish','whale'];
async function body(req){let value='';for await(const chunk of req){value+=chunk;if(value.length>6*1024*1024)throw Error('preview request too large')}return value?JSON.parse(value):{};}
async function startPreview({port=0,host='127.0.0.1'}={}){
  const fixtures=Object.fromEntries(slots.map(slot=>[slot,createFixture(slot)]));
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      res.setHeader('Cache-Control','no-store');
      if(url.pathname==='/__preview/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({preview:true,version:APP_VERSION,style:'author-v3'}));return;}
      const reset=url.pathname.match(/^\/__preview\/reset\/(cat|fish|whale)$/);
      if(reset&&req.method==='POST'){const payload=await body(req);fixtures[reset[1]]=createFixture(reset[1],['normal','empty','error','long'].includes(payload.scenario)?payload.scenario:'normal');res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}
      if(url.pathname==='/__preview/bridge.js'){res.setHeader('Content-Type',mime['.js']);res.end(await fs.readFile(path.join(ROOT,'qa/preview-bridge.js')));return;}
      if(url.pathname==='/'){
        const panes=slots.map(slot=>`<article class="pane" data-slot="${slot}"><header class="pane-heading"><strong class="current-theme">${{cat:'猫猫 · 珍珠',fish:'游鱼 · 薄荷',whale:'鲸鱼 · 夜航'}[slot]}</strong><span>完整交互 · 独立操作</span></header><div class="frame"><iframe src="/client/${slot}/" title="${slot} 完整客户端"></iframe></div><div class="reopen"><span>预览窗口已收起</span><button type="button" data-reopen>重新显示</button></div></article>`).join('');
        res.setHeader('Content-Type',mime['.html']);res.end((await fs.readFile(path.join(ROOT,'qa/preview-shell.html'),'utf8')).replace('__PANES__',panes));return;
      }
      const client=url.pathname.match(/^\/client\/(cat|fish|whale)\/(.*)$/);
      if(!client){res.writeHead(404).end('Not found');return;}
      const [,slot,relative]=client;
      if(relative.startsWith('api/')){
        const result=fixtures[slot].request(decodeURIComponent(relative.slice(4)),req.method,req.method==='GET'?{}:await body(req));const code=result.httpStatus||200;delete result.httpStatus;res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));return;
      }
      const file=path.resolve(APP,decodeURIComponent(relative||'index.html'));
      if(!file.startsWith(APP+path.sep)){res.writeHead(403).end('Forbidden');return;}
      let data=await fs.readFile(file);
      if(path.basename(file)==='index.html')data=Buffer.from(data.toString('utf8').replace('<head>','<head><script src="/__preview/bridge.js?slot='+slot+'"></script>'));
      res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data);
    }catch(error){res.writeHead(error.code==='ENOENT'?404:500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});
  return{server,url:'http://'+host+':'+server.address().port+'/',fixtures,close:()=>new Promise(resolve=>server.close(resolve))};
}
if(require.main===module){const arg=process.argv.find(a=>a.startsWith('--port='));startPreview({port:arg?Number(arg.slice(7)):4541}).then(async preview=>{const info={url:preview.url,pid:process.pid,version:APP_VERSION,style:'author-v3',isolated:true};await fs.mkdir(path.join(ROOT,'outputs/log'),{recursive:true});await fs.writeFile(path.join(ROOT,'outputs/log/client-preview-address.json'),JSON.stringify(info,null,2));console.log(JSON.stringify(info));}).catch(error=>{console.error(error);process.exit(1)});}
module.exports={startPreview};
